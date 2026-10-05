const { sql } = require("./db");
const { HttpError } = require("./errors");
const { requiredId } = require("./endpoint");

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

// Reads a list of { inventoryItemId, quantity } from a request, merging
// repeats of the same item.
function readItems(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "Items must be a list");
  const merged = new Map();
  for (const item of value) {
    const id = requiredId(item?.inventoryItemId, "Item");
    const quantity = Number(item?.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) throw new HttpError(400, "Quantity must be a whole number from 1 to 1000");
    merged.set(id, (merged.get(id) || 0) + quantity);
  }
  return [...merged].map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity }));
}

// Puts an inventory line on a ticket at today's unit cost.
async function addTicketItem(db, ticketId, inventoryItemId, quantity) {
  const found = await db.request().input("Id", sql.Int, inventoryItemId)
    .query("SELECT Id, Name, UnitCost FROM dbo.InventoryItems WHERE Id = @Id AND IsActive = 1");
  const item = found.recordset[0];
  if (!item) throw new HttpError(400, "That inventory item doesn't exist");
  const row = await db
    .request()
    .input("TicketId", sql.Int, ticketId)
    .input("ItemId", sql.Int, inventoryItemId)
    .input("Quantity", sql.Int, quantity)
    .input("UnitCost", sql.Decimal(10, 2), item.UnitCost)
    .query(`
      INSERT INTO dbo.TicketItems (TicketId, InventoryItemId, Quantity, UnitCostAtTime)
      OUTPUT INSERTED.Id
      VALUES (@TicketId, @ItemId, @Quantity, @UnitCost)
    `);
  return { id: row.recordset[0].Id, name: item.Name };
}

module.exports = { getAvailability, bookingWarnings, readItems, addTicketItem };
