const {
  endpoint,
  readJson,
  optionalId,
  requiredId,
  optionalText,
  requiredText,
  optionalDateTime,
  isUniqueViolation,
  isForeignKeyViolation
} = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings, saveSettings } = require("../shared/settings");
const { bookingWarnings, readItems, addTicketItem } = require("../shared/inventory");
const { personName, formatNumber, loadTicket, setStatus, recordEvents } = require("../shared/tickets");

// Event bookings: a room for a meeting, plus any equipment it needs. The
// booking holds the room and event details and is worked by Event Managers
// (HR). Equipment goes on a linked Equipment Rental ticket for technicians,
// created only when equipment is asked for.
//
// Times are VSB local time, stored as typed ("2026-10-12T09:00"). The SQL
// driver reads and writes DATETIME2 as UTC, so a wall time is passed as that
// same time in UTC and comes back unchanged.

const toSqlTime = (wall) => new Date(`${wall}:00Z`);
const toWall = (date) => (date ? date.toISOString().slice(0, 16) : null);

// Now in VSB's time zone, in the same wall-time form, for "upcoming".
function wallNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T").slice(0, 16);
}

function wallLabel(wall) {
  const [day, time] = wall.split("T");
  const [y, m, d] = day.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, h, min));
  return date.toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
}

const BOOKING_SELECT = `
  SELECT b.Id, b.RequesterId, ${personName("r")} AS RequesterName, r.Email AS RequesterEmail,
         b.Title, b.StartAt, b.EndAt, b.RoomId, rm.Name AS RoomName,
         b.AttendeeCount, b.Refreshments, b.Foia, b.LunchCatered, b.Comments,
         b.BookingStatusId, bs.Name AS StatusName, bs.Color AS StatusColor, bs.IsActiveBooking,
         b.TicketId, ts.Name AS TicketStatusName, ts.IsClosed AS TicketIsClosed,
         b.ConfirmedById, CASE WHEN cb.Id IS NOT NULL THEN ${personName("cb")} END AS ConfirmedByName, b.ConfirmedAt,
         b.CreatedAt, b.UpdatedAt,
         CAST(CASE WHEN bs.IsActiveBooking = 1 AND EXISTS (
           SELECT 1 FROM dbo.EventBookings o
           JOIN dbo.BookingStatuses os ON os.Id = o.BookingStatusId
           WHERE o.Id <> b.Id AND o.RoomId = b.RoomId AND os.IsActiveBooking = 1
             AND o.StartAt < b.EndAt AND o.EndAt > b.StartAt
         ) THEN 1 ELSE 0 END AS BIT) AS HasOverlap
  FROM dbo.EventBookings b
  JOIN dbo.Users r ON r.Id = b.RequesterId
  JOIN dbo.Rooms rm ON rm.Id = b.RoomId
  JOIN dbo.BookingStatuses bs ON bs.Id = b.BookingStatusId
  LEFT JOIN dbo.Users cb ON cb.Id = b.ConfirmedById
  LEFT JOIN dbo.Tickets t ON t.Id = b.TicketId
  LEFT JOIN dbo.Statuses ts ON ts.Id = t.StatusId
`;

// Requesters don't see the overlap hint: room availability isn't tracked
// reliably, so it's only a prompt for Event Managers to check.
function shape(row, user) {
  const booking = {
    ...row,
    StartAt: toWall(row.StartAt),
    EndAt: toWall(row.EndAt),
    TicketNumber: row.TicketId ? formatNumber(row.TicketId) : null
  };
  if (!user.IsEventManager) delete booking.HasOverlap;
  return booking;
}

async function loadBooking(db, id) {
  const result = await db.request().input("Id", sql.Int, id).query(`${BOOKING_SELECT} WHERE b.Id = @Id`);
  return result.recordset[0];
}

const canSee = (user, booking) => user.IsEventManager || booking.RequesterId === user.Id;

async function loadVisibleBooking(db, id, user) {
  const booking = await loadBooking(db, id);
  if (!booking || !canSee(user, booking)) throw new HttpError(404, "Booking not found");
  return booking;
}

async function recordBookingEvents(db, bookingId, actorId, changes) {
  for (const change of changes) {
    await db
      .request()
      .input("BookingId", sql.Int, bookingId)
      .input("ActorId", sql.Int, actorId)
      .input("Field", sql.NVarChar(50), change.field)
      .input("OldValue", sql.NVarChar(400), change.oldValue == null ? null : String(change.oldValue).slice(0, 400))
      .input("NewValue", sql.NVarChar(400), change.newValue == null ? null : String(change.newValue).slice(0, 400))
      .query(`
        INSERT INTO dbo.BookingEvents (BookingId, ActorId, Field, OldValue, NewValue)
        VALUES (@BookingId, @ActorId, @Field, @OldValue, @NewValue)
      `);
  }
}

async function roomName(db, roomId) {
  const result = await db.request().input("Id", sql.Int, roomId).query("SELECT Name, IsActive FROM dbo.Rooms WHERE Id = @Id");
  const room = result.recordset[0];
  if (!room) throw new HttpError(400, "That room doesn't exist");
  return room;
}

const yesNo = (value) => (value ? "Yes" : "No");

function readBool(value, field) {
  if (value === true || value === false) return value;
  throw new HttpError(400, `Answer ${field} with yes or no`);
}

function readAttendees(value) {
  const count = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isInteger(count) || count < 0 || count > 10000) {
    throw new HttpError(400, "Attendee Count must be a whole number");
  }
  return count;
}

function checkTimes(startAt, endAt) {
  if (endAt <= startAt) throw new HttpError(400, "The end time must be after the start time");
}

function ticketDescription(booking) {
  return [
    `Equipment for the event booking "${booking.Title}".`,
    `Room: ${booking.RoomName}`,
    `Starts: ${wallLabel(booking.StartAt)}`,
    `Ends: ${wallLabel(booking.EndAt)}`,
    `Attendees: ${booking.AttendeeCount}`,
    booking.Comments ? `Comments: ${booking.Comments}` : null
  ].filter(Boolean).join("\n");
}

// Creates the Equipment Rental ticket that holds a booking's equipment, for
// the booking's dates, and links it to the booking.
async function createLinkedTicket(tx, settings, booking, items, actorId) {
  if (!settings.BookingTicketTypeId) throw new HttpError(500, "Set the ticket type for a booking's equipment in Settings");
  const requester = await tx.request().input("Id", sql.Int, booking.RequesterId).query("SELECT DepartmentId FROM dbo.Users WHERE Id = @Id");
  const created = await tx
    .request()
    .input("TypeId", sql.Int, settings.BookingTicketTypeId)
    .input("StatusId", sql.Int, settings.NewStatusId)
    .input("PriorityId", sql.Int, settings.DefaultPriorityId)
    .input("SourceId", sql.Int, settings.WebSourceId)
    .input("RequesterId", sql.Int, booking.RequesterId)
    .input("DepartmentId", sql.Int, requester.recordset[0]?.DepartmentId ?? null)
    .input("Subject", sql.NVarChar(255), `Event: ${booking.Title}`.slice(0, 255))
    .input("Description", sql.NVarChar(sql.MAX), ticketDescription(booking))
    .input("StartDate", sql.Date, booking.StartAt.slice(0, 10))
    .input("EndDate", sql.Date, booking.EndAt.slice(0, 10))
    .query(`
      INSERT INTO dbo.Tickets
        (TicketTypeId, StatusId, PriorityId, SourceId, RequesterId, DepartmentId, Subject, Description, StartDate, EndDate)
      OUTPUT INSERTED.Id
      VALUES (@TypeId, @StatusId, @PriorityId, @SourceId, @RequesterId, @DepartmentId, @Subject, @Description, @StartDate, @EndDate)
    `);
  const ticketId = created.recordset[0].Id;
  for (const item of items) await addTicketItem(tx, ticketId, item.inventoryItemId, item.quantity);
  await recordEvents(tx, ticketId, actorId, [{ field: "Created", newValue: `From event booking: ${booking.Title}` }]);
  await tx.request().input("Id", sql.Int, booking.Id).input("TicketId", sql.Int, ticketId)
    .query("UPDATE dbo.EventBookings SET TicketId = @TicketId WHERE Id = @Id");
  return ticketId;
}

// Closes a booking's linked ticket (if it's still open) with a technician
// note saying why.
async function closeLinkedTicket(tx, settings, ticketId, note, actorId) {
  if (!ticketId) return;
  const ticket = await loadTicket(tx, ticketId);
  if (!ticket || ticket.IsClosed) return;
  await tx.request().input("TicketId", sql.Int, ticketId).input("AuthorId", sql.Int, actorId).input("Body", sql.NVarChar(sql.MAX), note)
    .query("INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote) VALUES (@TicketId, @AuthorId, @Body, 1)");
  await setStatus(tx, ticket, settings.ClosedStatusId, actorId);
}

async function ticketLines(db, ticketId) {
  const result = await db.request().input("Id", sql.Int, ticketId).query(`
    SELECT ti.Id, ti.InventoryItemId, i.Name, ti.Quantity, ti.OutAt, ti.ReturnedAt
    FROM dbo.TicketItems ti
    JOIN dbo.InventoryItems i ON i.Id = ti.InventoryItemId
    WHERE ti.TicketId = @Id
    ORDER BY i.Name
  `);
  return result.recordset;
}

const itemsLabel = (lines) => lines.map((l) => `${l.Name} x${l.Quantity}`).join(", ") || "None";

// Makes the booking's equipment match "items": creates the linked ticket when
// equipment is first asked for, replaces its lines while nothing has been
// handed out, and closes the ticket when no equipment is needed any more.
async function syncItems(tx, settings, booking, items, actorId) {
  if (!booking.TicketId) {
    if (!items.length) return;
    const ticketId = await createLinkedTicket(tx, settings, booking, items, actorId);
    const lines = await ticketLines(tx, ticketId);
    await recordBookingEvents(tx, booking.Id, actorId, [{ field: "Equipment", oldValue: "None", newValue: itemsLabel(lines) }]);
    return;
  }

  const lines = await ticketLines(tx, booking.TicketId);
  const same = lines.length === items.length &&
    items.every((i) => lines.some((l) => l.InventoryItemId === i.inventoryItemId && l.Quantity === i.quantity));
  if (same) return;
  if (lines.some((l) => l.OutAt)) {
    throw new HttpError(400, `Some of the equipment has already been handed out. Ask IT to change it on ticket #${formatNumber(booking.TicketId)}.`);
  }

  await tx.request().input("Id", sql.Int, booking.TicketId).query("DELETE FROM dbo.TicketItems WHERE TicketId = @Id");
  for (const item of items) await addTicketItem(tx, booking.TicketId, item.inventoryItemId, item.quantity);
  const after = await ticketLines(tx, booking.TicketId);
  await recordEvents(tx, booking.TicketId, actorId, [{ field: "Equipment", oldValue: itemsLabel(lines), newValue: itemsLabel(after) }]);
  await recordBookingEvents(tx, booking.Id, actorId, [{ field: "Equipment", oldValue: itemsLabel(lines), newValue: itemsLabel(after) }]);

  const ticket = await loadTicket(tx, booking.TicketId);
  if (!items.length) {
    await closeLinkedTicket(tx, settings, booking.TicketId, "The event booking no longer needs any equipment.", actorId);
  } else if (ticket.IsClosed) {
    await setStatus(tx, ticket, settings.NewStatusId, actorId);
  }
}

// ---------------------------------------------------------------------------
// List and read
// ---------------------------------------------------------------------------

// ?scope=mine|all (all: Event Managers)  ?when=upcoming|past|all
// ?statusId  ?roomId
endpoint("listBookings", { methods: ["GET"], route: "bookings" }, async (request, context, user) => {
  const q = request.query;
  const settings = await getSettings();
  const all = q.get("scope") === "all";
  if (all && !user.IsEventManager) throw new HttpError(403, "Only event managers can see every booking");
  const pool = await getConnection();
  const req = pool.request().input("Me", sql.Int, user.Id).input("Now", sql.DateTime2(0), toSqlTime(wallNow()))
    .input("Pending", sql.Int, settings.BookingPendingStatusId ?? null);
  const where = [];
  if (!all) where.push("b.RequesterId = @Me");
  const when = q.get("when") || "upcoming";
  if (when === "upcoming") where.push("b.EndAt >= @Now");
  if (when === "past") where.push("b.EndAt < @Now");
  const statusId = optionalId(q.get("statusId"), "Status");
  if (statusId) {
    where.push("b.BookingStatusId = @StatusId");
    req.input("StatusId", sql.Int, statusId);
  }
  const roomId = optionalId(q.get("roomId"), "Room");
  if (roomId) {
    where.push("b.RoomId = @RoomId");
    req.input("RoomId", sql.Int, roomId);
  }
  const order = when === "past" ? "x.StartAt DESC" : "CASE WHEN x.BookingStatusId = @Pending THEN 0 ELSE 1 END, x.StartAt";
  const result = await req.query(`
    SELECT TOP (500) * FROM (${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}) x
    ORDER BY ${order}
  `);
  return { jsonBody: result.recordset.map((row) => shape(row, user)) };
});

endpoint("getBooking", { methods: ["GET"], route: "bookings/{id:int}" }, async (request, context, user) => {
  const pool = await getConnection();
  const booking = await loadVisibleBooking(pool, Number(request.params.id), user);
  const items = booking.TicketId ? await ticketLines(pool, booking.TicketId) : [];
  const events = await pool.request().input("Id", sql.Int, booking.Id).query(`
    SELECT e.Id, e.Field, e.OldValue, e.NewValue, e.[At], ${personName("u")} AS ActorName
    FROM dbo.BookingEvents e
    LEFT JOIN dbo.Users u ON u.Id = e.ActorId
    WHERE e.BookingId = @Id
    ORDER BY e.[At], e.Id
  `);
  return {
    jsonBody: {
      booking: shape(booking, user),
      items,
      events: events.recordset,
      // Event Managers see the equipment but can't change it
      canChangeItems: booking.RequesterId === user.Id || user.IsTechnician
    }
  };
});

// ---------------------------------------------------------------------------
// Create and change
// ---------------------------------------------------------------------------

endpoint(
  "createBooking",
  { methods: ["POST"], route: "bookings", failMessage: "Could not save the booking" },
  async (request, context, user) => {
    const body = await readJson(request);
    const settings = await getSettings();
    const title = requiredText(body.title, "Title", 255);
    const startAt = optionalDateTime(body.startAt, "Start Time");
    const endAt = optionalDateTime(body.endAt, "End Time");
    if (!startAt) throw new HttpError(400, "Start Time is required");
    if (!endAt) throw new HttpError(400, "End Time is required");
    checkTimes(startAt, endAt);
    const roomId = requiredId(body.roomId, "Location");
    const attendeeCount = readAttendees(body.attendeeCount);
    const refreshments = readBool(body.refreshments, "Refreshments");
    const foia = readBool(body.foia, "FOIA");
    const lunchCatered = readBool(body.lunchCatered, "Will Lunch Be Catered?");
    const comments = optionalText(body.comments, "User Comments", 4000);
    const items = readItems(body.items);
    if (!settings.BookingPendingStatusId) throw new HttpError(500, "Set the status for new event bookings in Settings");

    const pool = await getConnection();
    const room = await roomName(pool, roomId);
    if (!room.IsActive) throw new HttpError(400, "That room can't be booked any more");
    const warnings = await bookingWarnings(pool, items, { startDate: startAt.slice(0, 10), endDate: endAt.slice(0, 10) });

    let bookingId;
    try {
      bookingId = await withTransaction(async (tx) => {
        const created = await tx
          .request()
          .input("RequesterId", sql.Int, user.Id)
          .input("Title", sql.NVarChar(255), title)
          .input("StartAt", sql.DateTime2(0), toSqlTime(startAt))
          .input("EndAt", sql.DateTime2(0), toSqlTime(endAt))
          .input("RoomId", sql.Int, roomId)
          .input("AttendeeCount", sql.Int, attendeeCount)
          .input("Refreshments", sql.Bit, refreshments)
          .input("Foia", sql.Bit, foia)
          .input("LunchCatered", sql.Bit, lunchCatered)
          .input("Comments", sql.NVarChar(4000), comments)
          .input("StatusId", sql.Int, settings.BookingPendingStatusId)
          .query(`
            INSERT INTO dbo.EventBookings
              (RequesterId, Title, StartAt, EndAt, RoomId, AttendeeCount, Refreshments, Foia, LunchCatered, Comments, BookingStatusId)
            OUTPUT INSERTED.Id
            VALUES (@RequesterId, @Title, @StartAt, @EndAt, @RoomId, @AttendeeCount, @Refreshments, @Foia, @LunchCatered, @Comments, @StatusId)
          `);
        const id = created.recordset[0].Id;
        await recordBookingEvents(tx, id, user.Id, [{ field: "Booked", newValue: `${title}, ${room.Name}` }]);
        if (items.length) {
          const booking = shape(await loadBooking(tx, id), user);
          await createLinkedTicket(tx, settings, booking, items, user.Id);
        }
        return id;
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new HttpError(400, "One of the choices on the form no longer exists");
      throw error;
    }

    // The HR email and the VSB Events calendar entry come in a later step
    // (design, Event booking), behind the Outgoing email switch.
    const pool2 = await getConnection();
    return { status: 201, jsonBody: { booking: shape(await loadBooking(pool2, bookingId), user), warnings } };
  }
);

const FIELDS = [
  // [body key, column, label]
  ["title", "Title", "Title"],
  ["startAt", "StartAt", "Start Time"],
  ["endAt", "EndAt", "End Time"],
  ["roomId", "RoomId", "Location"],
  ["attendeeCount", "AttendeeCount", "Attendee Count"],
  ["refreshments", "Refreshments", "Refreshments"],
  ["foia", "Foia", "FOIA"],
  ["lunchCatered", "LunchCatered", "Will Lunch Be Catered?"],
  ["comments", "Comments", "User Comments"]
];

// The requester, an Event Manager or a technician can change anything about
// an active booking, including moving it. Equipment can only be changed by
// the requester or a technician. Changes don't send a booking back to
// Pending.
endpoint(
  "updateBooking",
  { methods: ["PATCH"], route: "bookings/{id:int}", failMessage: "Could not save the booking" },
  async (request, context, user) => {
    const body = await readJson(request);
    const settings = await getSettings();
    const id = Number(request.params.id);
    let warnings = [];

    await withTransaction(async (tx) => {
      const current = await loadVisibleBooking(tx, id, user);
      const booking = shape(current, user);
      if (!booking.IsActiveBooking) throw new HttpError(400, `This booking is ${booking.StatusName.toLowerCase()} and can't be changed`);

      const next = {};
      if ("title" in body) next.Title = requiredText(body.title, "Title", 255);
      if ("startAt" in body) next.StartAt = optionalDateTime(body.startAt, "Start Time") || (() => { throw new HttpError(400, "Start Time is required"); })();
      if ("endAt" in body) next.EndAt = optionalDateTime(body.endAt, "End Time") || (() => { throw new HttpError(400, "End Time is required"); })();
      if ("roomId" in body) next.RoomId = requiredId(body.roomId, "Location");
      if ("attendeeCount" in body) next.AttendeeCount = readAttendees(body.attendeeCount);
      if ("refreshments" in body) next.Refreshments = readBool(body.refreshments, "Refreshments");
      if ("foia" in body) next.Foia = readBool(body.foia, "FOIA");
      if ("lunchCatered" in body) next.LunchCatered = readBool(body.lunchCatered, "Will Lunch Be Catered?");
      if ("comments" in body) next.Comments = optionalText(body.comments, "User Comments", 4000);
      const startAt = next.StartAt ?? booking.StartAt;
      const endAt = next.EndAt ?? booking.EndAt;
      checkTimes(startAt, endAt);

      let newRoom;
      if ("RoomId" in next && next.RoomId !== booking.RoomId) {
        newRoom = await roomName(tx, next.RoomId);
        if (!newRoom.IsActive) throw new HttpError(400, "That room can't be booked any more");
      }

      const changes = FIELDS.filter(([, column]) => column in next && next[column] !== booking[column]);
      if (changes.length) {
        const req = tx.request().input("Id", sql.Int, id);
        const sets = [];
        for (const [, column] of changes) {
          const value = next[column];
          const type = column === "StartAt" || column === "EndAt" ? sql.DateTime2(0)
            : column === "Title" ? sql.NVarChar(255)
            : column === "Comments" ? sql.NVarChar(4000)
            : typeof value === "boolean" ? sql.Bit : sql.Int;
          req.input(column, type, column === "StartAt" || column === "EndAt" ? toSqlTime(value) : value);
          sets.push(`${column} = @${column}`);
        }
        await req.query(`UPDATE dbo.EventBookings SET ${sets.join(", ")}, UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id`);

        await recordBookingEvents(tx, id, user.Id, changes.map(([, column, label]) => {
          const show = (value) => column === "RoomId" ? null
            : column === "StartAt" || column === "EndAt" ? wallLabel(value)
            : typeof value === "boolean" ? yesNo(value) : value;
          return column === "RoomId"
            ? { field: label, oldValue: booking.RoomName, newValue: newRoom.Name }
            : { field: label, oldValue: show(booking[column]), newValue: show(next[column]) };
        }));
      }

      // Moving the meeting moves the linked ticket's equipment dates
      const updated = shape(await loadBooking(tx, id), user);
      if (booking.TicketId && (startAt.slice(0, 10) !== booking.StartAt.slice(0, 10) || endAt.slice(0, 10) !== booking.EndAt.slice(0, 10))) {
        const ticket = await loadTicket(tx, booking.TicketId);
        const day = (value) => (value ? value.toISOString().slice(0, 10) : null);
        await tx.request().input("Id", sql.Int, booking.TicketId)
          .input("StartDate", sql.Date, startAt.slice(0, 10)).input("EndDate", sql.Date, endAt.slice(0, 10))
          .query("UPDATE dbo.Tickets SET StartDate = @StartDate, EndDate = @EndDate, UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id");
        await recordEvents(tx, booking.TicketId, user.Id, [
          { field: "Start date", oldValue: day(ticket.StartDate), newValue: startAt.slice(0, 10) },
          { field: "End date", oldValue: day(ticket.EndDate), newValue: endAt.slice(0, 10) }
        ].filter((e) => e.oldValue !== e.newValue));
      }

      if ("items" in body) {
        if (booking.RequesterId !== user.Id && !user.IsTechnician) {
          throw new HttpError(403, "Only the person who booked it or IT can change the equipment");
        }
        const items = readItems(body.items);
        warnings = await bookingWarnings(tx, items, {
          startDate: startAt.slice(0, 10),
          endDate: endAt.slice(0, 10),
          excludeTicketId: booking.TicketId
        });
        await syncItems(tx, settings, updated, items, user.Id);
      }
    });

    // The HR and technician emails and the calendar update come in a later
    // step, behind the Outgoing email switch.
    const pool = await getConnection();
    return { jsonBody: { booking: shape(await loadBooking(pool, id), user), warnings } };
  }
);

// Body: { reason } (optional). Confirm and decline are for Event Managers;
// the requester can also cancel.
for (const [name, action] of [["confirmBooking", "confirm"], ["declineBooking", "decline"], ["cancelBooking", "cancel"]]) {
  endpoint(
    name,
    { methods: ["POST"], route: `bookings/{id:int}/${action}`, failMessage: "Could not save the booking" },
    async (request, context, user) => {
      const body = await readJson(request);
      const reason = optionalText(body.reason, "Reason", 300);
      const settings = await getSettings();
      const id = Number(request.params.id);
      const statusKey = { confirm: "BookingConfirmedStatusId", decline: "BookingDeclinedStatusId", cancel: "BookingCancelledStatusId" }[action];
      const statusId = settings[statusKey];
      if (!statusId) throw new HttpError(500, "Set the booking statuses in Settings");

      await withTransaction(async (tx) => {
        const booking = await loadVisibleBooking(tx, id, user);
        if (action !== "cancel" && !user.IsEventManager) throw new HttpError(403, "Only event managers can do that");
        if (!booking.IsActiveBooking) throw new HttpError(400, `This booking is already ${booking.StatusName.toLowerCase()}`);
        if (action === "confirm" && booking.BookingStatusId === statusId) throw new HttpError(400, "This booking is already confirmed");

        const status = await tx.request().input("Id", sql.Int, statusId).query("SELECT Name FROM dbo.BookingStatuses WHERE Id = @Id");
        const confirm = action === "confirm";
        await tx.request().input("Id", sql.Int, id).input("StatusId", sql.Int, statusId).input("By", sql.Int, user.Id)
          .query(`
            UPDATE dbo.EventBookings
            SET BookingStatusId = @StatusId, UpdatedAt = SYSUTCDATETIME()
                ${confirm ? ", ConfirmedById = @By, ConfirmedAt = SYSUTCDATETIME()" : ""}
            WHERE Id = @Id
          `);
        await recordBookingEvents(tx, id, user.Id, [
          { field: "Status", oldValue: booking.StatusName, newValue: status.recordset[0].Name },
          ...(reason ? [{ field: "Reason", newValue: reason }] : [])
        ]);
        if (!confirm) {
          const what = action === "decline" ? "declined" : "cancelled";
          await closeLinkedTicket(tx, settings, booking.TicketId,
            `The event booking "${booking.Title}" was ${what}${reason ? `: ${reason}` : "."} The equipment isn't needed.`, user.Id);
        }
      });

      // The requester's email and the calendar change come in a later step.
      const pool = await getConnection();
      return { jsonBody: { booking: shape(await loadBooking(pool, id), user) } };
    }
  );
}

// ---------------------------------------------------------------------------
// Rooms and guidelines (Event Managers)
// ---------------------------------------------------------------------------

endpoint("listRooms", { methods: ["GET"], route: "bookings/rooms", role: "eventManager" }, async () => {
  const pool = await getConnection();
  const result = await pool.request().query("SELECT Id, Name, SortOrder, IsActive FROM dbo.Rooms ORDER BY SortOrder, Name");
  return { jsonBody: result.recordset };
});

function readRoom(body, isNew) {
  const values = {};
  if (isNew || "name" in body) values.Name = requiredText(body.name, "Room name", 100);
  if ("sortOrder" in body) {
    const n = Number(body.sortOrder || 0);
    if (!Number.isInteger(n)) throw new HttpError(400, "Sort order must be a whole number");
    values.SortOrder = n;
  }
  if ("isActive" in body) values.IsActive = !!body.isActive;
  return values;
}

async function saveRoom(request, id) {
  const values = readRoom(await readJson(request), !id);
  const columns = Object.keys(values);
  if (!columns.length) throw new HttpError(400, "Nothing to change");
  const pool = await getConnection();
  const req = pool.request();
  for (const c of columns) req.input(c, c === "Name" ? sql.NVarChar(100) : c === "IsActive" ? sql.Bit : sql.Int, values[c]);
  try {
    if (!id) {
      const result = await req.query(`INSERT INTO dbo.Rooms (${columns.join(", ")}) OUTPUT INSERTED.Id VALUES (${columns.map((c) => `@${c}`).join(", ")})`);
      return { status: 201, jsonBody: { Id: result.recordset[0].Id } };
    }
    const result = await req.input("Id", sql.Int, id).query(`UPDATE dbo.Rooms SET ${columns.map((c) => `${c} = @${c}`).join(", ")} WHERE Id = @Id`);
    if (!result.rowsAffected[0]) throw new HttpError(404, "Room not found");
    return { jsonBody: { ok: true } };
  } catch (error) {
    if (isUniqueViolation(error)) throw new HttpError(409, "A room with that name already exists");
    throw error;
  }
}

endpoint("createRoom", { methods: ["POST"], route: "bookings/rooms", role: "eventManager", failMessage: "Could not add the room" },
  async (request) => saveRoom(request, null));

endpoint("updateRoom", { methods: ["PATCH"], route: "bookings/rooms/{id:int}", role: "eventManager", failMessage: "Could not save the room" },
  async (request) => saveRoom(request, Number(request.params.id)));

// Body: { text }. Shown by the Guidelines button on the booking form.
endpoint(
  "saveGuidelines",
  { methods: ["PUT"], route: "bookings/guidelines", role: "eventManager", failMessage: "Could not save the guidelines" },
  async (request) => {
    const body = await readJson(request);
    const text = optionalText(body.text, "Guidelines", 4000) || "";
    await saveSettings({ EventGuidelines: text });
    return { jsonBody: { text } };
  }
);
