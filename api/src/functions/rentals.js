const { endpoint } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { personName, formatNumber } = require("../shared/tickets");

// The Rentals & Events list: one row per request, with a room part (HR) and
// an equipment part (IT). A row is either an event booking (with or without
// equipment) or an Equipment Rental ticket that has no room.
//
// Event Managers who aren't technicians see room bookings only, with no
// equipment information at all. Technicians see everything. Everyone else
// sees their own requests (scope=mine).

const wall = (date) => (date ? date.toISOString().slice(0, 16) : null);

function wallNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T").slice(0, 16);
}

// requested, out or returned, from a ticket's lines ('none' without lines)
const STAGE_SQL = (ticketId) => `
  CASE
    WHEN ${ticketId} IS NULL OR NOT EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = ${ticketId}) THEN 'none'
    WHEN EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = ${ticketId} AND q.OutAt IS NOT NULL AND q.ReturnedAt IS NULL) THEN 'out'
    WHEN NOT EXISTS (SELECT 1 FROM dbo.TicketItems q WHERE q.TicketId = ${ticketId} AND q.ReturnedAt IS NULL) THEN 'returned'
    ELSE 'requested'
  END`;

const ITEMS_SQL = (ticketId) => `
  (SELECT STRING_AGG(CONCAT(i.Name, CASE WHEN q.Quantity > 1 THEN CONCAT(' x', q.Quantity) END), ', ')
   FROM dbo.TicketItems q JOIN dbo.InventoryItems i ON i.Id = q.InventoryItemId WHERE q.TicketId = ${ticketId})`;

// ?scope=all|mine  ?when=upcoming|past|all
endpoint("listRentals", { methods: ["GET"], route: "rentals" }, async (request, context, user) => {
  const q = request.query;
  const settings = await getSettings();
  const all = q.get("scope") === "all";
  if (all && !user.IsEventManager && !user.IsTechnician) throw new HttpError(403, "Only technicians and event managers can see every request");
  const roomOnly = all && !user.IsTechnician;
  const when = ["upcoming", "past", "all"].includes(q.get("when")) ? q.get("when") : "upcoming";
  const now = wallNow();
  const pool = await getConnection();

  const req = () => pool.request()
    .input("Me", sql.Int, user.Id)
    .input("Now", sql.DateTime2(0), new Date(`${now}:00Z`))
    .input("Today", sql.Date, now.slice(0, 10))
    .input("RentalType", sql.Int, settings.BookingTicketTypeId ?? null);

  const bookingWhere = [];
  const rentalWhere = ["t.TicketTypeId = @RentalType", "NOT EXISTS (SELECT 1 FROM dbo.EventBookings x WHERE x.TicketId = t.Id)"];
  if (!all) {
    bookingWhere.push("b.RequesterId = @Me");
    rentalWhere.push("(t.RequesterId = @Me OR t.ForUserId = @Me)");
  }
  if (when === "upcoming") {
    bookingWhere.push("b.EndAt >= @Now");
    rentalWhere.push("(COALESCE(t.EndDate, t.StartDate) IS NULL OR COALESCE(t.EndDate, t.StartDate) >= @Today OR s.IsClosed = 0)");
  }
  if (when === "past") {
    bookingWhere.push("b.EndAt < @Now");
    rentalWhere.push("COALESCE(t.EndDate, t.StartDate) < @Today AND s.IsClosed = 1");
  }

  const bookings = await req().query(`
    SELECT TOP (500) b.Id, b.Title, b.StartAt, b.EndAt, b.RequesterId, ${personName("r")} AS RequesterName,
           b.RoomId, rm.Name AS RoomName, b.BookingStatusId, bs.Name AS RoomStatusName, bs.Color AS RoomStatusColor,
           bs.IsActiveBooking, b.AttendeeCount, b.TicketId, ${STAGE_SQL("b.TicketId")} AS EquipmentStage,
           ${ITEMS_SQL("b.TicketId")} AS Items, b.CreatedAt,
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
    ${bookingWhere.length ? `WHERE ${bookingWhere.join(" AND ")}` : ""}
    ORDER BY b.StartAt
  `);

  const rows = bookings.recordset.map((b) => {
    const row = {
      Kind: "booking",
      Key: `b${b.Id}`,
      Id: b.Id,
      Title: b.Title,
      StartAt: wall(b.StartAt),
      EndAt: wall(b.EndAt),
      RequesterId: b.RequesterId,
      RequesterName: b.RequesterName,
      RoomName: b.RoomName,
      BookingStatusId: b.BookingStatusId,
      RoomStatusName: b.RoomStatusName,
      RoomStatusColor: b.RoomStatusColor,
      IsActiveBooking: b.IsActiveBooking,
      AttendeeCount: b.AttendeeCount,
      CreatedAt: b.CreatedAt
    };
    if (user.IsEventManager) row.HasOverlap = b.HasOverlap;
    if (!roomOnly) {
      row.TicketId = b.TicketId;
      row.TicketNumber = b.TicketId ? formatNumber(b.TicketId) : null;
      row.EquipmentStage = b.EquipmentStage;
      row.Items = b.Items;
    }
    return row;
  });

  if (!roomOnly && settings.BookingTicketTypeId) {
    const rentals = await req().query(`
      SELECT TOP (500) t.Id, t.Subject, t.StartDate, t.EndDate, t.RequesterId, ${personName("r")} AS RequesterName,
             s.Name AS TicketStatusName, s.IsClosed, ${STAGE_SQL("t.Id")} AS EquipmentStage, ${ITEMS_SQL("t.Id")} AS Items, t.CreatedAt
      FROM dbo.Tickets t
      JOIN dbo.Users r ON r.Id = t.RequesterId
      JOIN dbo.Statuses s ON s.Id = t.StatusId
      WHERE ${rentalWhere.join(" AND ")}
      ORDER BY t.StartDate
    `);
    for (const t of rentals.recordset) {
      rows.push({
        Kind: "rental",
        Key: `t${t.Id}`,
        Id: t.Id,
        Title: t.Subject,
        StartAt: t.StartDate ? `${t.StartDate.toISOString().slice(0, 10)}T00:00` : null,
        EndAt: t.EndDate ? `${t.EndDate.toISOString().slice(0, 10)}T00:00` : null,
        AllDay: true,
        RequesterId: t.RequesterId,
        RequesterName: t.RequesterName,
        RoomName: null,
        TicketId: t.Id,
        TicketNumber: formatNumber(t.Id),
        TicketStatusName: t.TicketStatusName,
        EquipmentStage: t.EquipmentStage,
        Items: t.Items,
        CreatedAt: t.CreatedAt
      });
    }
  }

  rows.sort((a, b) => String(a.StartAt || "").localeCompare(String(b.StartAt || "")));
  return { jsonBody: rows };
});
