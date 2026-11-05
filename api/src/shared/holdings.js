const { sql } = require("./db");
const { getAccessHoldings } = require("./access");

// What a person holds now: every license seat they have, every item handed
// to them to keep that hasn't come back (on a ticket for them, or handed
// straight to them from their page), and the access they've been given
// (shared mailboxes, calendars, phone queues, printers and iMIS).
async function getHoldings(db, personId) {
  const seats = await db.request().input("UserId", sql.Int, personId).query(`
    SELECT la.Id, s.Name, la.SoftwareId, la.AssignedAt, la.AssignedTicketId, a.Name AS ApplicationName
    FROM dbo.LicenseAssignments la
    JOIN dbo.Software s ON s.Id = la.SoftwareId
    LEFT JOIN dbo.Applications a ON a.Id = s.ApplicationId
    WHERE la.UserId = @UserId AND la.RemovedAt IS NULL
    ORDER BY s.Name
  `);
  const items = await db.request().input("UserId", sql.Int, personId).query(`
    SELECT ti.Id, ti.Quantity, i.Name, ti.InventoryItemId, ti.TicketId, ti.OutAt
    FROM dbo.TicketItems ti
    LEFT JOIN dbo.Tickets t ON t.Id = ti.TicketId
    JOIN dbo.InventoryItems i ON i.Id = ti.InventoryItemId
    WHERE ti.ReturnedAt IS NULL AND ti.OutAt IS NOT NULL
      AND (ti.HolderId = @UserId
           OR (ti.TicketId IS NOT NULL AND ti.HolderId IS NULL AND t.EndDate IS NULL
               AND (t.ForUserId = @UserId OR (t.ForUserId IS NULL AND t.RequesterId = @UserId))))
    ORDER BY i.Name
  `);
  return { seats: seats.recordset, items: items.recordset, access: await getAccessHoldings(db, personId) };
}

module.exports = { getHoldings };
