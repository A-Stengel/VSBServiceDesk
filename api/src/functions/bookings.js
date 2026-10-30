const { app } = require("@azure/functions");
const {
  endpoint,
  readJson,
  readBodyWithFiles,
  optionalId,
  requiredText,
  optionalDateTime,
  isUniqueViolation,
  isForeignKeyViolation
} = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings, saveSettings } = require("../shared/settings");
const { assertTicketStock, readItems, addTicketItem } = require("../shared/inventory");
const { saveAttachments, finishRichText, readInlineNames } = require("../shared/attachments");
const { sanitizeRich, toPlain } = require("../shared/richtext");
const { toSqlTime, wallNow, wallLabel } = require("../shared/clock");
const { loadTicket, loadVisibleTicket, accessOf, forViewer, setStatus, recordEvents } = require("../shared/tickets");
const { logChange } = require("../shared/changelog");
const { ticketCreated, ticketClosed, bookingDecided, bookingChanged } = require("../shared/notify");
const { syncCalendar } = require("../shared/calendar");

// Equipment Rental / Event Booking: one ticket for a room, equipment, or both.
//
// The room part (dbo.TicketRooms) is HR's: Event Managers confirm or decline
// it and can change the event's details. The equipment part (the ticket's
// equipment lines) is IT's, and only the requester and technicians see or
// change it. A ticket with a room and no equipment stays out of technicians'
// lists and closes itself once the event is over.
//
// Times are the desk's local wall time, stored as typed (see shared/clock).

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

function readTime(value, field) {
  const time = optionalDateTime(value, field);
  if (!time) throw new HttpError(400, `${field} is required`);
  return time;
}

function checkTimes(startAt, endAt) {
  if (endAt <= startAt) throw new HttpError(400, "The end time must be after the start time");
}

async function activeRoom(db, roomId) {
  const result = await db.request().input("Id", sql.Int, roomId).query("SELECT Name, IsActive FROM dbo.Rooms WHERE Id = @Id");
  const room = result.recordset[0];
  if (!room) throw new HttpError(400, "That room doesn't exist");
  return room;
}

async function equipmentLines(db, ticketId) {
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

// Makes the ticket's equipment match "items", while none of it has been
// handed out.
async function syncItems(tx, ticketId, items, actorId) {
  const lines = await equipmentLines(tx, ticketId);
  const same = lines.length === items.length &&
    items.every((i) => lines.some((l) => l.InventoryItemId === i.inventoryItemId && l.Quantity === i.quantity));
  if (same) return false;
  if (lines.some((l) => l.OutAt)) throw new HttpError(400, "Some of the equipment has already been handed out. Ask IT to change it.");
  await tx.request().input("Id", sql.Int, ticketId).query("DELETE FROM dbo.TicketItems WHERE TicketId = @Id");
  for (const item of items) await addTicketItem(tx, ticketId, item.inventoryItemId, item.quantity);
  await recordEvents(tx, ticketId, actorId, [{ field: "Equipment", oldValue: itemsLabel(lines), newValue: itemsLabel(await equipmentLines(tx, ticketId)) }]);
  return true;
}

// Equipment that's out with the requester keeps the ticket open for IT.
async function equipmentStillOut(db, ticketId) {
  const result = await db.request().input("Id", sql.Int, ticketId)
    .query("SELECT TOP (1) 1 AS X FROM dbo.TicketItems WHERE TicketId = @Id AND OutAt IS NOT NULL AND ReturnedAt IS NULL");
  return result.recordset.length > 0;
}

async function addMessage(tx, ticketId, authorId, text, direction) {
  await tx.request()
    .input("TicketId", sql.Int, ticketId)
    .input("AuthorId", sql.Int, authorId)
    .input("Body", sql.NVarChar(sql.MAX), sanitizeRich(`<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`))
    .input("Direction", sql.NVarChar(3), direction)
    .query("INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, Direction) VALUES (@TicketId, @AuthorId, @Body, 0, @Direction)");
}

// The rental or booking this person may change: their own, any with a room
// for Event Managers, any for technicians.
async function loadChangeable(db, id, user, settings) {
  const ticket = await loadVisibleTicket(db, id, user);
  if (ticket.TicketTypeId !== settings.BookingTicketTypeId) throw new HttpError(400, "This ticket isn't a rental or event booking");
  return ticket;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

// Multipart or JSON: { title, startAt, endAt, roomId, attendeeCount,
// refreshments, foia, lunchCatered, comments (rich text), items, inline }.
// A room, equipment, or both.
endpoint(
  "createBooking",
  { methods: ["POST"], route: "bookings", failMessage: "Could not save the request" },
  async (request, context, user) => {
    const { data, files } = await readBodyWithFiles(request);
    const settings = await getSettings();
    if (!settings.BookingTicketTypeId) throw new HttpError(500, "Set the ticket type for rentals and event bookings in Settings");
    const title = requiredText(data.title, "Title", 255);
    const startAt = readTime(data.startAt, "Start Time");
    const endAt = readTime(data.endAt, "End Time");
    checkTimes(startAt, endAt);
    const roomId = optionalId(data.roomId, "Room");
    const items = readItems(data.items);
    if (!roomId && !items.length) throw new HttpError(400, "Pick a room, some equipment, or both");
    let room = null;
    if (roomId) {
      if (!settings.BookingPendingStatusId) throw new HttpError(500, "Set the room status for new bookings in Settings");
      room = {
        id: roomId,
        attendeeCount: readAttendees(data.attendeeCount),
        refreshments: readBool(data.refreshments, "Refreshments"),
        foia: readBool(data.foia, "FOIA"),
        lunchCatered: readBool(data.lunchCatered, "Will Lunch Be Catered?")
      };
    }
    const comments = typeof data.comments === "string" ? data.comments : "";
    if (comments.length > 200000) throw new HttpError(400, "The comments are too long");

    const pool = await getConnection();
    if (room) {
      const found = await activeRoom(pool, room.id);
      if (!found.IsActive) throw new HttpError(400, "That room can't be booked any more");
      room.name = found.Name;
    }
    const requester = (await pool.request().input("Id", sql.Int, user.Id).query("SELECT DepartmentId FROM dbo.Users WHERE Id = @Id")).recordset[0];

    let ticketId;
    try {
      ticketId = await withTransaction(async (tx) => {
        const created = await tx.request()
          .input("TypeId", sql.Int, settings.BookingTicketTypeId)
          .input("StatusId", sql.Int, settings.NewStatusId)
          .input("PriorityId", sql.Int, settings.DefaultPriorityId)
          .input("SourceId", sql.Int, settings.WebSourceId)
          .input("RequesterId", sql.Int, user.Id)
          .input("DepartmentId", sql.Int, requester?.DepartmentId ?? null)
          .input("Subject", sql.NVarChar(255), title)
          .input("StartDate", sql.Date, startAt.slice(0, 10))
          .input("EndDate", sql.Date, endAt.slice(0, 10))
          .input("StartAt", sql.DateTime2(0), toSqlTime(startAt))
          .input("EndAt", sql.DateTime2(0), toSqlTime(endAt))
          .query(`
            INSERT INTO dbo.Tickets
              (TicketTypeId, StatusId, PriorityId, SourceId, RequesterId, DepartmentId, Subject, Description, StartDate, EndDate, StartAt, EndAt)
            OUTPUT INSERTED.Id
            VALUES (@TypeId, @StatusId, @PriorityId, @SourceId, @RequesterId, @DepartmentId, @Subject, N'', @StartDate, @EndDate, @StartAt, @EndAt)
          `);
        const id = created.recordset[0].Id;
        const saved = await saveAttachments(tx, id, null, files, user.Id, readInlineNames(data.inline));
        const description = await finishRichText(tx, id, comments, saved);
        await tx.request().input("Id", sql.Int, id).input("Description", sql.NVarChar(sql.MAX), description)
          .query("UPDATE dbo.Tickets SET Description = @Description WHERE Id = @Id");
        for (const item of items) await addTicketItem(tx, id, item.inventoryItemId, item.quantity);
        const events = [{ field: "Created", newValue: "Equipment Rental / Event Booking" }];
        if (room) {
          await tx.request()
            .input("TicketId", sql.Int, id)
            .input("RoomId", sql.Int, room.id)
            .input("AttendeeCount", sql.Int, room.attendeeCount)
            .input("Refreshments", sql.Bit, room.refreshments)
            .input("Foia", sql.Bit, room.foia)
            .input("LunchCatered", sql.Bit, room.lunchCatered)
            .input("StatusId", sql.Int, settings.BookingPendingStatusId)
            .query(`
              INSERT INTO dbo.TicketRooms (TicketId, RoomId, AttendeeCount, Refreshments, Foia, LunchCatered, BookingStatusId)
              VALUES (@TicketId, @RoomId, @AttendeeCount, @Refreshments, @Foia, @LunchCatered, @StatusId)
            `);
          events.push({ field: "Room requested", newValue: `${room.name}, ${wallLabel(startAt)}` });
        }
        if (items.length) events.push({ field: "Equipment", oldValue: "None", newValue: itemsLabel(await equipmentLines(tx, id)) });
        await recordEvents(tx, id, user.Id, events);
        return id;
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new HttpError(400, "One of the choices on the form no longer exists");
      throw error;
    }

    await ticketCreated(ticketId, context);
    await syncCalendar(ticketId, context);
    return { status: 201, jsonBody: { ticket: forViewer(await loadTicket(pool, ticketId), user), warnings: [] } };
  }
);

// ---------------------------------------------------------------------------
// Change
// ---------------------------------------------------------------------------

const ROOM_COLUMNS = [
  // [body key, column, history label, read]
  ["attendeeCount", "AttendeeCount", "Attendee count", readAttendees],
  ["refreshments", "Refreshments", "Refreshments", (v) => readBool(v, "Refreshments")],
  ["foia", "Foia", "FOIA", (v) => readBool(v, "FOIA")],
  ["lunchCatered", "LunchCatered", "Lunch catered", (v) => readBool(v, "Will Lunch Be Catered?")]
];

// The requester, an Event Manager or a technician can change the event's
// details while the ticket is open, including moving it. Only the requester
// and technicians can change the equipment. A change doesn't send a
// confirmed room back to Pending. Multipart or JSON, with any of the create
// fields; "roomId": null removes the room (when there's equipment).
endpoint(
  "updateBooking",
  { methods: ["PATCH"], route: "bookings/{id:int}", failMessage: "Could not save the request" },
  async (request, context, user) => {
    const { data, files } = await readBodyWithFiles(request);
    const settings = await getSettings();
    const id = Number(request.params.id);
    let changes = [];

    await withTransaction(async (tx) => {
      const ticket = await loadChangeable(tx, id, user, settings);
      const access = accessOf(user, ticket);
      if (ticket.IsClosed) throw new HttpError(400, "This request is closed and can't be changed");
      if ("items" in data && !access.equipment) throw new HttpError(403, "Only the person who asked for it or IT can change the equipment");
      const events = [];

      // Title, times and comments live on the ticket
      const before = forViewer(ticket, user);
      const startAt = "startAt" in data ? readTime(data.startAt, "Start Time") : before.StartAt;
      const endAt = "endAt" in data ? readTime(data.endAt, "End Time") : before.EndAt;
      if (startAt && endAt) checkTimes(startAt, endAt);
      const sets = [];
      const req = tx.request().input("Id", sql.Int, id);
      if ("title" in data) {
        const title = requiredText(data.title, "Title", 255);
        if (title !== ticket.Subject) {
          sets.push("Subject = @Subject");
          req.input("Subject", sql.NVarChar(255), title);
          events.push({ field: "Subject", oldValue: ticket.Subject, newValue: title });
        }
      }
      if (startAt !== before.StartAt || endAt !== before.EndAt) {
        if (!startAt || !endAt) throw new HttpError(400, "Start Time and End Time are required");
        sets.push("StartAt = @StartAt", "EndAt = @EndAt", "StartDate = @StartDate", "EndDate = @EndDate");
        req.input("StartAt", sql.DateTime2(0), toSqlTime(startAt)).input("EndAt", sql.DateTime2(0), toSqlTime(endAt))
          .input("StartDate", sql.Date, startAt.slice(0, 10)).input("EndDate", sql.Date, endAt.slice(0, 10));
        if (startAt !== before.StartAt) events.push({ field: "Starts", oldValue: wallLabel(before.StartAt), newValue: wallLabel(startAt) });
        if (endAt !== before.EndAt) events.push({ field: "Ends", oldValue: wallLabel(before.EndAt), newValue: wallLabel(endAt) });
      }
      if ("comments" in data) {
        const draft = typeof data.comments === "string" ? data.comments : "";
        if (draft.length > 200000) throw new HttpError(400, "The comments are too long");
        const saved = await saveAttachments(tx, id, null, files, user.Id, readInlineNames(data.inline));
        const description = await finishRichText(tx, id, draft, saved);
        if (description !== ticket.Description) {
          sets.push("Description = @Description");
          req.input("Description", sql.NVarChar(sql.MAX), description);
          events.push({ field: "Comments", oldValue: toPlain(ticket.Description) || null, newValue: toPlain(description) || null });
        }
      }
      if (sets.length) await req.query(`UPDATE dbo.Tickets SET ${sets.join(", ")}, UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id`);
      if (startAt !== before.StartAt || endAt !== before.EndAt) await assertTicketStock(tx, id);

      // The room part
      if ("roomId" in data) {
        const roomId = optionalId(data.roomId, "Room");
        if (!roomId && ticket.HasRoom) {
          if (!access.equipment) throw new HttpError(403, "Only the person who asked for it or IT can remove the room");
          await tx.request().input("Id", sql.Int, id).query("DELETE FROM dbo.TicketRooms WHERE TicketId = @Id");
          events.push({ field: "Room", oldValue: ticket.RoomName, newValue: "No room" });
        } else if (roomId && roomId !== ticket.RoomId) {
          const room = await activeRoom(tx, roomId);
          if (!room.IsActive) throw new HttpError(400, "That room can't be booked any more");
          if (ticket.HasRoom) {
            await tx.request().input("Id", sql.Int, id).input("RoomId", sql.Int, roomId)
              .query("UPDATE dbo.TicketRooms SET RoomId = @RoomId WHERE TicketId = @Id");
          } else {
            await tx.request()
              .input("TicketId", sql.Int, id)
              .input("RoomId", sql.Int, roomId)
              .input("AttendeeCount", sql.Int, readAttendees(data.attendeeCount))
              .input("Refreshments", sql.Bit, readBool(data.refreshments, "Refreshments"))
              .input("Foia", sql.Bit, readBool(data.foia, "FOIA"))
              .input("LunchCatered", sql.Bit, readBool(data.lunchCatered, "Will Lunch Be Catered?"))
              .input("StatusId", sql.Int, settings.BookingPendingStatusId)
              .query(`
                INSERT INTO dbo.TicketRooms (TicketId, RoomId, AttendeeCount, Refreshments, Foia, LunchCatered, BookingStatusId)
                VALUES (@TicketId, @RoomId, @AttendeeCount, @Refreshments, @Foia, @LunchCatered, @StatusId)
              `);
          }
          events.push({ field: ticket.HasRoom ? "Room" : "Room requested", oldValue: ticket.RoomName || null, newValue: room.Name });
        }
      }
      if (ticket.HasRoom && !("roomId" in data && !data.roomId)) {
        const changed = ROOM_COLUMNS.filter(([key]) => key in data).map(([key, column, label, read]) => [column, label, read(data[key])])
          .filter(([column, , value]) => value !== ticket[column]);
        if (changed.length) {
          const roomReq = tx.request().input("Id", sql.Int, id);
          for (const [column, , value] of changed) roomReq.input(column, typeof value === "boolean" ? sql.Bit : sql.Int, value);
          await roomReq.query(`UPDATE dbo.TicketRooms SET ${changed.map(([c]) => `${c} = @${c}`).join(", ")} WHERE TicketId = @Id`);
          for (const [column, label, value] of changed) {
            events.push({ field: label, oldValue: typeof value === "boolean" ? yesNo(ticket[column]) : ticket[column], newValue: typeof value === "boolean" ? yesNo(value) : value });
          }
        }
      }
      await recordEvents(tx, id, user.Id, events);
      changes = events;

      if ("items" in data) {
        const before = itemsLabel(await equipmentLines(tx, id));
        if (await syncItems(tx, id, readItems(data.items), user.Id)) {
          changes.push({ field: "Equipment", oldValue: before, newValue: itemsLabel(await equipmentLines(tx, id)) });
        }
      }
      const after = await loadTicket(tx, id);
      if (!after.HasRoom && !after.HasEquipment) throw new HttpError(400, "A request needs a room, some equipment, or both");
    });

    await bookingChanged(id, changes, user, context);
    await syncCalendar(id, context);
    const pool = await getConnection();
    return { jsonBody: { ticket: forViewer(await loadTicket(pool, id), user), warnings: [] } };
  }
);

// Body: { reason } (optional). Confirm and decline are for HR (Event Managers
// who aren't technicians) and admins. The requester, HR and technicians can
// cancel. Declining or cancelling closes the ticket, unless equipment is out
// with the requester; then it stays open for IT to collect it.
for (const [name, action] of [["confirmBooking", "confirm"], ["declineBooking", "decline"], ["cancelBooking", "cancel"]]) {
  endpoint(
    name,
    { methods: ["POST"], route: `bookings/{id:int}/${action}`, failMessage: "Could not save the request" },
    async (request, context, user) => {
      const body = await readJson(request);
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
      const settings = await getSettings();
      const id = Number(request.params.id);
      const statusKey = { confirm: "BookingConfirmedStatusId", decline: "BookingDeclinedStatusId", cancel: "BookingCancelledStatusId" }[action];
      const statusId = settings[statusKey];
      const warnings = [];
      let closedNow = false;

      await withTransaction(async (tx) => {
        const ticket = await loadChangeable(tx, id, user, settings);
        const canDecide = user.IsAdmin || (user.IsEventManager && !user.IsTechnician);
        if (action !== "cancel" && !canDecide) throw new HttpError(403, "Only HR can confirm or decline a room");
        if (action !== "cancel" && !ticket.HasRoom) throw new HttpError(400, "This request has no room");
        if (ticket.HasRoom && !statusId) throw new HttpError(500, "Set the room statuses in Settings");
        if (ticket.IsClosed) throw new HttpError(400, "This request is already closed");
        if (ticket.HasRoom && !ticket.IsActiveBooking) throw new HttpError(400, `This room is already ${ticket.RoomStatusName.toLowerCase()}`);
        if (action === "confirm" && ticket.BookingStatusId === statusId) throw new HttpError(400, "This room is already confirmed");

        if (ticket.HasRoom) {
          const status = await tx.request().input("Id", sql.Int, statusId).query("SELECT Name FROM dbo.BookingStatuses WHERE Id = @Id");
          await tx.request().input("Id", sql.Int, id).input("StatusId", sql.Int, statusId).input("By", sql.Int, user.Id)
            .query(`
              UPDATE dbo.TicketRooms
              SET BookingStatusId = @StatusId ${action === "confirm" ? ", ConfirmedById = @By, ConfirmedAt = SYSUTCDATETIME()" : ""}
              WHERE TicketId = @Id
            `);
          await recordEvents(tx, id, user.Id, [{ field: "Room status", oldValue: ticket.RoomStatusName, newValue: status.recordset[0].Name }]);
        }
        if (action === "cancel") await recordEvents(tx, id, user.Id, [{ field: "Cancelled", newValue: reason || null }]);
        if (reason) {
          const own = ticket.RequesterId === user.Id;
          await addMessage(tx, id, user.Id, reason, own ? "in" : "out");
        }
        if (action !== "confirm") {
          if (await equipmentStillOut(tx, id)) {
            warnings.push("Equipment is still out with the requester, so the ticket stays open until IT marks it returned.");
          } else {
            warnings.push(...(await setStatus(tx, await loadTicket(tx, id), settings.ClosedStatusId, user.Id)));
            closedNow = true;
          }
        }
      });

      if (action !== "cancel") await bookingDecided(id, action, reason, context);
      else await bookingChanged(id, [{ field: "Cancelled", newValue: reason || null }], user, context);
      if (closedNow) await ticketClosed(id, context);
      await syncCalendar(id, context);
      const pool = await getConnection();
      return { jsonBody: { ticket: forViewer(await loadTicket(pool, id), user), warnings } };
    }
  );
}

// ---------------------------------------------------------------------------
// Room-only tickets close themselves once the event is over
// ---------------------------------------------------------------------------

// Closes every open ticket that has a room, no equipment and an event that
// has ended. No closed email or survey goes out for these: IT did no work on
// them. Returns how many it closed.
async function closeEndedRoomBookings(settings) {
  if (!settings.ClosedStatusId) return 0;
  const pool = await getConnection();
  const due = await pool.request().input("Now", sql.DateTime2(0), toSqlTime(wallNow(settings))).query(`
    SELECT t.Id
    FROM dbo.Tickets t
    JOIN dbo.TicketRooms tr ON tr.TicketId = t.Id
    JOIN dbo.Statuses s ON s.Id = t.StatusId
    WHERE s.IsClosed = 0 AND t.EndAt < @Now
      AND NOT EXISTS (SELECT 1 FROM dbo.TicketItems ti WHERE ti.TicketId = t.Id)
  `);
  for (const { Id } of due.recordset) {
    await withTransaction(async (tx) => {
      const ticket = await loadTicket(tx, Id);
      if (!ticket || ticket.IsClosed || ticket.HasEquipment) return;
      await recordEvents(tx, Id, null, [{ field: "Closed automatically", newValue: "The event is over" }]);
      await setStatus(tx, ticket, settings.ClosedStatusId, null);
    });
  }
  return due.recordset.length;
}

app.timer("closeEndedBookings", {
  schedule: "0 5 * * * *", // five past every hour
  handler: async (timer, context) => {
    const closed = await closeEndedRoomBookings(await getSettings());
    if (closed) context.log(`Closed ${closed} room-only booking ticket(s) whose event is over`);
  }
});

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

// Body: { text } (rich text, without images). Shown beside the booking form.
endpoint(
  "saveGuidelines",
  { methods: ["PUT"], route: "bookings/guidelines", role: "eventManager", failMessage: "Could not save the guidelines" },
  async (request, context, user) => {
    const body = await readJson(request);
    if (typeof body.text !== "string" && body.text != null) throw new HttpError(400, "Guidelines must be text");
    if ((body.text || "").length > 100000) throw new HttpError(400, "The guidelines are too long");
    const text = sanitizeRich(body.text || "");
    await saveSettings({ EventGuidelines: text });
    const pool = await getConnection();
    await logChange(pool, { area: "settings", section: "guidelines", actorId: user.Id, summary: "Changed the booking guidelines" });
    return { jsonBody: { text } };
  }
);

module.exports = { closeEndedRoomBookings };
