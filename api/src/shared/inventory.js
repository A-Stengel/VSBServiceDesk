const { sql } = require("./db");

// How many of each inventory item are free between two dates.
//
// An item on a ticket counts as out until a technician marks it returned:
// - on a ticket with an end date (rentals, bookings) only while its dates
//   overlap the dates asked about;
// - on a ticket without an end date (provisioning, onboarding) from then on.
// Items on a closed ticket that were never handed out don't count.
async function getAvailability(db, { startDate, endDate, excludeTicketId } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db
    .request()
    .input("Start", sql.Date, startDate || endDate || today)
    .input("End", sql.Date, endDate || startDate || today)
    .input("Exclude", sql.Int, excludeTicketId || null)
    .query(`
      SELECT i.Id, i.Name, i.UnitCost, i.QuantityOwned, i.IsDefaultForOnboarding,
             COALESCE(o.QuantityOut, 0) AS QuantityOut,
             i.QuantityOwned - COALESCE(o.QuantityOut, 0) AS Available
      FROM dbo.InventoryItems i
      OUTER APPLY (
        SELECT SUM(ti.Quantity) AS QuantityOut
        FROM dbo.TicketItems ti
        JOIN dbo.Tickets t ON t.Id = ti.TicketId
        JOIN dbo.Statuses s ON s.Id = t.StatusId
        WHERE ti.InventoryItemId = i.Id
          AND ti.ReturnedAt IS NULL
          AND (@Exclude IS NULL OR t.Id <> @Exclude)
          AND NOT (s.IsClosed = 1 AND ti.OutAt IS NULL)
          AND (t.EndDate IS NULL
               OR (COALESCE(t.StartDate, t.EndDate) <= @End AND t.EndDate >= @Start))
      ) o
      WHERE i.IsActive = 1
      ORDER BY i.SortOrder, i.Name
    `);
  return result.recordset;
}

// Warnings for items asked for beyond what's free on those dates.
async function bookingWarnings(db, items, dates) {
  if (!items.length) return [];
  const availability = await getAvailability(db, dates);
  const warnings = [];
  for (const item of items) {
    const row = availability.find((a) => a.Id === item.inventoryItemId);
    if (row && item.quantity > row.Available) {
      warnings.push(`${row.Name}: ${item.quantity} asked for, ${Math.max(row.Available, 0)} free on those dates`);
    }
  }
  return warnings;
}

module.exports = { getAvailability, bookingWarnings };
