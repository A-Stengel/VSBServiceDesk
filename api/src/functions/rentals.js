const { endpoint } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { personName, formatNumber, FOR_IT_SQL } = require("../shared/tickets");
const { toSqlTime, toWall, wallNow } = require("../shared/clock");

// The Rentals & Events list: one row per Equipment Rental / Event Booking
// ticket, with a room part (HR) and an equipment part (IT).
//
// HR (Event Managers who aren't technicians) see every ticket with a room,
// with no equipment information. Technicians see every ticket except those
// that only book a room (those are HR's alone until equipment is added);
// admins see those too, since they can confirm rooms. Everyone else sees
// their own requests (scope=mine).

// requested, out or returned, from the ticket's lines ('none' without lines)
const STAGE_SQL = `
  CASE
    WHEN NOT EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = t.Id) THEN 'none'
    WHEN EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = t.Id AND q.OutAt IS NOT NULL AND q.ReturnedAt IS NULL) THEN 'out'
    WHEN NOT EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = t.Id AND q.ReturnedAt IS NULL) THEN 'returned'
    ELSE 'requested'
  END`;

const ITEMS_SQL = `
  (SELECT STRING_AGG(CONCAT(i.Name, CASE WHEN q.Quantity > 1 THEN CONCAT(' x', q.Quantity) END), ', ')
   FROM dbo.TicketItems q JOIN dbo.InventoryItems i ON i.Id = q.InventoryItemId WHERE q.TicketId = t.Id)`;

// When the request ends: the event's end time, or the day after a rental's
// last day.
const END_SQL = "COALESCE(t.EndAt, DATEADD(DAY, 1, CAST(COALESCE(t.EndDate, t.StartDate) AS DATETIME2(0))))";

// Still to come, or open with equipment that hasn't come back.
const UPCOMING_SQL = `(${END_SQL} >= @Now OR (${END_SQL} IS NULL AND s.IsClosed = 0)
  OR (s.IsClosed = 0 AND EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = t.Id AND q.ReturnedAt IS NULL)))`;

const dayStart = (date) => (date ? `${date.toISOString().slice(0, 10)}T00:00` : null);

// ?scope=all|mine  ?when=upcoming|past|all
endpoint("listRentals", { methods: ["GET"], route: "rentals" }, async (request, context, user) => {
  const q = request.query;
  const settings = await getSettings();
  const all = q.get("scope") === "all";
  if (all && !user.IsEventManager && !user.IsTechnician) throw new HttpError(403, "Only technicians and event managers can see every request");
  // Every technician counts as an Event Manager too; HR and admins are the
  // ones who look after rooms.
  const roomDesk = user.IsEventManager && (!user.IsTechnician || user.IsAdmin);
  const when = ["upcoming", "past", "all"].includes(q.get("when")) ? q.get("when") : "upcoming";
  if (!settings.BookingTicketTypeId) return { jsonBody: [] };

  const where = ["t.TicketTypeId = @BookingType"];
  if (all) {
    const parts = [];
    if (user.IsTechnician) parts.push(FOR_IT_SQL);
    if (roomDesk) parts.push("tr.TicketId IS NOT NULL");
    where.push(`(${parts.join(" OR ")})`);
  } else {
    where.push("(t.RequesterId = @Me OR t.ForUserId = @Me)");
  }
  if (when === "upcoming") where.push(UPCOMING_SQL);
  if (when === "past") where.push(`NOT ${UPCOMING_SQL}`);

  const pool = await getConnection();
  const result = await pool.request()
    .input("Me", sql.Int, user.Id)
    .input("Now", sql.DateTime2(0), toSqlTime(wallNow(settings)))
    .input("BookingType", sql.Int, settings.BookingTicketTypeId)
    .query(`
      SELECT TOP (1000) t.Id, t.Subject, t.StartAt, t.EndAt, t.StartDate, t.EndDate, t.RequesterId, t.ForUserId,
             ${personName("r")} AS RequesterName, s.Name AS TicketStatusName, s.IsClosed, t.CreatedAt, t.UpdatedAt,
             CAST(CASE WHEN tr.TicketId IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS HasRoom,
             rm.Name AS RoomName, tr.BookingStatusId, bs.Name AS RoomStatusName, bs.Color AS RoomStatusColor,
             bs.IsActiveBooking, tr.AttendeeCount, ${STAGE_SQL} AS EquipmentStage, ${ITEMS_SQL} AS Items,
             CAST(CASE WHEN bs.IsActiveBooking = 1 AND EXISTS (
               SELECT 1 FROM dbo.TicketRooms o
               JOIN dbo.Tickets ot ON ot.Id = o.TicketId
               JOIN dbo.BookingStatuses os ON os.Id = o.BookingStatusId
               WHERE o.TicketId <> t.Id AND o.RoomId = tr.RoomId AND os.IsActiveBooking = 1
                 AND ot.StartAt < t.EndAt AND ot.EndAt > t.StartAt
             ) THEN 1 ELSE 0 END AS BIT) AS HasOverlap
      FROM dbo.Tickets t
      JOIN dbo.Users r ON r.Id = t.RequesterId
      JOIN dbo.Statuses s ON s.Id = t.StatusId
      LEFT JOIN dbo.TicketRooms tr ON tr.TicketId = t.Id
      LEFT JOIN dbo.Rooms rm ON rm.Id = tr.RoomId
      LEFT JOIN dbo.BookingStatuses bs ON bs.Id = tr.BookingStatusId
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(t.StartAt, CAST(t.StartDate AS DATETIME2(0)))
    `);

  const rows = result.recordset.map((t) => {
    const own = t.RequesterId === user.Id || t.ForUserId === user.Id;
    const allDay = !t.StartAt;
    const row = {
      Kind: t.HasRoom ? "booking" : "rental",
      Key: `t${t.Id}`,
      Id: t.Id,
      TicketId: t.Id,
      TicketNumber: formatNumber(t.Id),
      Title: t.Subject,
      StartAt: allDay ? dayStart(t.StartDate) : toWall(t.StartAt),
      EndAt: allDay ? dayStart(t.EndDate) : toWall(t.EndAt),
      AllDay: allDay,
      RequesterId: t.RequesterId,
      RequesterName: t.RequesterName,
      IsClosed: t.IsClosed,
      CreatedAt: t.CreatedAt,
      UpdatedAt: t.UpdatedAt,
      RoomName: t.RoomName,
      BookingStatusId: t.BookingStatusId,
      RoomStatusName: t.RoomStatusName,
      RoomStatusColor: t.RoomStatusColor,
      IsActiveBooking: t.IsActiveBooking,
      AttendeeCount: t.AttendeeCount
    };
    if (roomDesk && t.HasRoom) row.HasOverlap = t.HasOverlap;
    // HR sees the room part only
    if (user.IsTechnician || own) {
      row.TicketStatusName = t.TicketStatusName;
      row.EquipmentStage = t.EquipmentStage;
      row.Items = t.Items;
    }
    return row;
  });
  return { jsonBody: rows };
});
