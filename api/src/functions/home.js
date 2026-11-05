const { endpoint } = require("../shared/endpoint");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { personName, formatNumber, FOR_IT_SQL, MINE_SQL } = require("../shared/tickets");
const { toSqlTime, wallNow } = require("../shared/clock");

// The home page: the numbers on the tiles and the five latest things that
// happened, both limited to what the signed-in person can see. Tickets that
// only book a room are HR's, so technicians' numbers leave them out.

endpoint("home", { methods: ["GET"], route: "home" }, async (request, context, user) => {
  const settings = await getSettings();
  const pool = await getConnection();
  const tech = !!user.IsTechnician;
  // Every technician counts as an Event Manager too; the room numbers are for
  // HR and admins.
  const eventManager = !!user.IsEventManager && (!user.IsTechnician || !!user.IsAdmin);

  const counts = (await pool.request()
    .input("Me", sql.Int, user.Id)
    .input("MyEmail", sql.NVarChar(320), String(user.Email || "").toLowerCase())
    .input("Now", sql.DateTime2(0), toSqlTime(wallNow(settings)))
    .input("Pending", sql.Int, settings.BookingPendingStatusId ?? null)
    .input("Confirmed", sql.Int, settings.BookingConfirmedStatusId ?? null)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND ${MINE_SQL}) AS MyOpen,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND s.IsWaitingOnRequester = 1 AND t.RequesterId = @Me) AS WaitingOnMe,
        ${tech ? `
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND t.TechnicianId IS NULL AND ${FOR_IT_SQL}) AS Unassigned,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND t.TechnicianId = @Me) AS AssignedToMe,
        (SELECT COUNT(*) FROM dbo.Tickets t JOIN dbo.Statuses s ON s.Id = t.StatusId
          WHERE s.IsClosed = 0 AND s.IsWaitingOnRequester = 1 AND ${FOR_IT_SQL}) AS WaitingOnRequester,
        (SELECT COALESCE(SUM(Quantity), 0) FROM dbo.TicketItems WHERE OutAt IS NOT NULL AND ReturnedAt IS NULL) AS EquipmentOut,` : ""}
        ${eventManager ? `
        (SELECT COUNT(*) FROM dbo.TicketRooms tr JOIN dbo.Tickets t ON t.Id = tr.TicketId
          WHERE tr.BookingStatusId = @Pending AND t.EndAt >= @Now) AS RoomsPending,
        (SELECT COUNT(*) FROM dbo.TicketRooms tr JOIN dbo.Tickets t ON t.Id = tr.TicketId
          WHERE tr.BookingStatusId = @Confirmed AND t.EndAt >= @Now) AS UpcomingEvents,` : ""}
        0 AS Unused
    `)).recordset[0];
  delete counts.Unused;

  // Technicians see all activity on their tickets (notes included); Event
  // Managers see the room part of tickets with a room (replies and HR notes,
  // no equipment); everyone sees their own requests.
  const ROOM_ONLY_FIELDS = "N'Created', N'Room requested', N'Room status'";
  const activity = (await pool.request()
    .input("Me", sql.Int, user.Id)
    .input("MyEmail", sql.NVarChar(320), String(user.Email || "").toLowerCase())
    .input("Tech", sql.Bit, tech)
    .input("EventManager", sql.Bit, eventManager)
    .query(`
      SELECT TOP (5) * FROM (
        SELECT e.TicketId, t.Subject, e.[At],
               CASE WHEN u.Id IS NOT NULL THEN ${personName("u")} END AS ActorName, e.Field, e.OldValue, e.NewValue
        FROM dbo.TicketEvents e
        JOIN dbo.Tickets t ON t.Id = e.TicketId
        LEFT JOIN dbo.Users u ON u.Id = e.ActorId
        WHERE e.Field IN (N'Created', N'Status', N'Assigned To', N'Priority', N'Room requested', N'Room status', N'Equipment')
          AND ((@Tech = 1 AND ${FOR_IT_SQL}) OR ${MINE_SQL}
            OR (@EventManager = 1 AND e.Field IN (${ROOM_ONLY_FIELDS})
              AND EXISTS (SELECT 1 FROM dbo.TicketRooms hr WHERE hr.TicketId = t.Id)))
        UNION ALL
        SELECT c.TicketId, t.Subject, c.CreatedAt,
               ${personName("u")}, CASE WHEN c.IsTechnicianNote = 1 THEN N'Note' ELSE N'Reply' END, NULL, NULL
        FROM dbo.TicketConversations c
        JOIN dbo.Tickets t ON t.Id = c.TicketId
        JOIN dbo.Users u ON u.Id = c.AuthorId
        WHERE (@Tech = 1 AND ${FOR_IT_SQL})
          OR (${MINE_SQL} AND c.IsTechnicianNote = 0)
          OR (@EventManager = 1 AND (c.IsTechnicianNote = 0 OR c.VisibleToEventManagers = 1)
            AND EXISTS (SELECT 1 FROM dbo.TicketRooms hr WHERE hr.TicketId = t.Id))
      ) a
      ORDER BY a.[At] DESC
    `)).recordset;

  return {
    jsonBody: {
      counts,
      activity: activity.map((a) => ({
        kind: "ticket",
        id: a.TicketId,
        target: `${formatNumber(a.TicketId)} · ${a.Subject}`,
        at: a.At,
        who: a.ActorName || "System",
        what: describe(a)
      }))
    }
  };
});

function describe(a) {
  if (a.Field === "Room requested") return "requested a room";
  if (a.Field === "Room status") return `set the room to ${a.NewValue}`;
  if (a.Field === "Equipment") return "changed the equipment";
  if (a.Field === "Created") return "opened a ticket";
  if (a.Field === "Reply") return "replied";
  if (a.Field === "Note") return "added an internal note";
  if (a.Field === "Assigned To") return a.NewValue ? `assigned it to ${a.NewValue}` : "unassigned it";
  return `set ${a.Field.toLowerCase()} to ${a.NewValue}`;
}
