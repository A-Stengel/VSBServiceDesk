const { endpoint } = require("../shared/endpoint");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { personName, formatNumber } = require("../shared/tickets");

// The home page: the numbers on the tiles and the five latest things that
// happened, both limited to what the signed-in person can see.

function wallNow() {
  return new Date().toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T").slice(0, 16);
}

endpoint("home", { methods: ["GET"], route: "home" }, async (request, context, user) => {
  const settings = await getSettings();
  const pool = await getConnection();
  const tech = !!user.IsTechnician;
  const eventManager = !!user.IsEventManager;

  const counts = (await pool.request()
    .input("Me", sql.Int, user.Id)
    .input("Now", sql.DateTime2(0), new Date(`${wallNow()}:00Z`))
    .input("Pending", sql.Int, settings.BookingPendingStatusId ?? null)
    .input("Confirmed", sql.Int, settings.BookingConfirmedStatusId ?? null)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND (t.RequesterId = @Me OR t.ForUserId = @Me)) AS MyOpen,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND s.IsWaitingOnRequester = 1 AND t.RequesterId = @Me) AS WaitingOnMe,
        ${tech ? `
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND t.TechnicianId IS NULL) AS Unassigned,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND t.TechnicianId = @Me) AS AssignedToMe,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND s.IsWaitingOnRequester = 1) AS WaitingOnRequester,
        (SELECT COALESCE(SUM(Quantity), 0) FROM dbo.TicketItems WHERE OutAt IS NOT NULL AND ReturnedAt IS NULL) AS EquipmentOut,` : ""}
        ${eventManager ? `
        (SELECT COUNT(*) FROM dbo.EventBookings WHERE BookingStatusId = @Pending AND EndAt >= @Now) AS RoomsPending,
        (SELECT COUNT(*) FROM dbo.EventBookings WHERE BookingStatusId = @Confirmed AND EndAt >= @Now) AS UpcomingEvents,` : ""}
        0 AS Unused
    `)).recordset[0];
  delete counts.Unused;

  // Technicians see all ticket activity (notes included); Event Managers see
  // every room booking but no equipment; everyone sees their own requests.
  const activity = (await pool.request()
    .input("Me", sql.Int, user.Id)
    .input("Tech", sql.Bit, tech)
    .input("EventManager", sql.Bit, eventManager)
    .query(`
      SELECT TOP (5) * FROM (
        SELECT 'ticket' AS Kind, e.TicketId AS TargetId, t.Subject AS Target, e.[At],
               CASE WHEN u.Id IS NOT NULL THEN ${personName("u")} END AS ActorName, e.Field, e.OldValue, e.NewValue, CAST(0 AS BIT) AS IsNote
        FROM dbo.TicketEvents e
        JOIN dbo.Tickets t ON t.Id = e.TicketId
        LEFT JOIN dbo.Users u ON u.Id = e.ActorId
        WHERE e.Field IN (N'Created', N'Status', N'Assigned To', N'Priority')
          AND (@Tech = 1 OR t.RequesterId = @Me OR t.ForUserId = @Me)
        UNION ALL
        SELECT 'ticket', c.TicketId, t.Subject, c.CreatedAt,
               ${personName("u")}, CASE WHEN c.IsTechnicianNote = 1 THEN N'Note' ELSE N'Reply' END, NULL, NULL, c.IsTechnicianNote
        FROM dbo.TicketConversations c
        JOIN dbo.Tickets t ON t.Id = c.TicketId
        JOIN dbo.Users u ON u.Id = c.AuthorId
        WHERE (@Tech = 1 OR ((t.RequesterId = @Me OR t.ForUserId = @Me) AND c.IsTechnicianNote = 0))
        UNION ALL
        SELECT 'booking', e.BookingId, b.Title, e.[At],
               CASE WHEN u.Id IS NOT NULL THEN ${personName("u")} END, e.Field, e.OldValue, e.NewValue, CAST(0 AS BIT)
        FROM dbo.BookingEvents e
        JOIN dbo.EventBookings b ON b.Id = e.BookingId
        LEFT JOIN dbo.Users u ON u.Id = e.ActorId
        WHERE e.Field IN (N'Booked', N'Status', N'Equipment')
          AND (b.RequesterId = @Me OR @Tech = 1 OR (@EventManager = 1 AND e.Field <> N'Equipment'))
      ) a
      ORDER BY a.[At] DESC
    `)).recordset;

  return {
    jsonBody: {
      counts,
      activity: activity.map((a) => ({
        kind: a.Kind,
        id: a.TargetId,
        target: a.Kind === "ticket" ? `${formatNumber(a.TargetId)} · ${a.Target}` : a.Target,
        at: a.At,
        who: a.ActorName || "System",
        what: describe(a)
      }))
    }
  };
});

function describe(a) {
  if (a.Kind === "booking") {
    if (a.Field === "Booked") return "requested a room";
    if (a.Field === "Equipment") return "changed the equipment";
    return `set the room to ${a.NewValue}`;
  }
  if (a.Field === "Created") return "opened a ticket";
  if (a.Field === "Reply") return "replied";
  if (a.Field === "Note") return "added an internal note";
  if (a.Field === "Assigned To") return a.NewValue ? `assigned it to ${a.NewValue}` : "unassigned it";
  return `set ${a.Field.toLowerCase()} to ${a.NewValue}`;
}
