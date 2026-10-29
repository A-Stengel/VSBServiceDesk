const { sql } = require("./db");
const { HttpError } = require("./errors");
const { requiredId } = require("./endpoint");

// How many of each inventory item are free between two dates.
//
// An item counts as out until a technician marks it returned:
// - once handed out, whatever the dates (an overdue rental is still out);
// - before that, on an open ticket with an end date (rentals, bookings) only
//   while its dates overlap the dates asked about;
// - before that, on an open ticket without an end date (provisioning,
//   onboarding) from then on.
// Items on a closed ticket that were never handed out don't count.
async function getAvailability(db, { startDate, endDate, excludeTicketId } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db
    .request()
    .input("Start", sql.Date, startDate || endDate || today)
    .input("End", sql.Date, endDate || startDate || today)
    .input("Exclude", sql.Int, excludeTicketId || null)
    .query(`
      SELECT i.Id, i.Name, i.UnitCost, i.QuantityOwned, i.IsDefaultForOnboarding, i.LowStockAt,
             COALESCE(o.QuantityOut, 0) AS QuantityOut,
             i.QuantityOwned - COALESCE(o.QuantityOut, 0) AS Available
      FROM dbo.InventoryItems i
      OUTER APPLY (
        SELECT SUM(ti.Quantity) AS QuantityOut
        FROM dbo.TicketItems ti
        LEFT JOIN dbo.Tickets t ON t.Id = ti.TicketId
        LEFT JOIN dbo.Statuses s ON s.Id = t.StatusId
        WHERE ti.InventoryItemId = i.Id
          AND ti.ReturnedAt IS NULL
          AND (@Exclude IS NULL OR ti.TicketId IS NULL OR ti.TicketId <> @Exclude)
          AND (ti.OutAt IS NOT NULL OR (
            ti.TicketId IS NOT NULL
            AND s.IsClosed = 0
            AND (t.EndDate IS NULL
                 OR (COALESCE(t.StartDate, t.EndDate) <= @End AND t.EndDate >= @Start))))
      ) o
      WHERE i.IsActive = 1
      ORDER BY i.SortOrder, i.Name
    `);
  return result.recordset;
}

// The fewest of an item free on any day from today on, counted the same way
// as getAvailability. The busiest day is always today or the first day of a
// later rental, so only those days are checked.
async function lowestAvailable(db, inventoryItemId) {
  const today = new Date().toISOString().slice(0, 10);
  const result = await db
    .request()
    .input("ItemId", sql.Int, inventoryItemId)
    .input("Today", sql.Date, today)
    .query(`
      WITH Days AS (
        SELECT @Today AS D
        UNION
        SELECT COALESCE(t.StartDate, t.EndDate)
        FROM dbo.TicketItems ti
        JOIN dbo.Tickets t ON t.Id = ti.TicketId
        WHERE ti.InventoryItemId = @ItemId AND ti.ReturnedAt IS NULL
          AND t.EndDate IS NOT NULL AND COALESCE(t.StartDate, t.EndDate) > @Today
      )
      SELECT TOP (1) i.Name, i.QuantityOwned, d.D AS Day,
             i.QuantityOwned - COALESCE(o.QuantityOut, 0) AS Available
      FROM dbo.InventoryItems i
      CROSS JOIN Days d
      OUTER APPLY (
        SELECT SUM(ti.Quantity) AS QuantityOut
        FROM dbo.TicketItems ti
        LEFT JOIN dbo.Tickets t ON t.Id = ti.TicketId
        LEFT JOIN dbo.Statuses s ON s.Id = t.StatusId
        WHERE ti.InventoryItemId = i.Id
          AND ti.ReturnedAt IS NULL
          AND (ti.OutAt IS NOT NULL OR (
            ti.TicketId IS NOT NULL
            AND s.IsClosed = 0
            AND (t.EndDate IS NULL OR (COALESCE(t.StartDate, t.EndDate) <= d.D AND t.EndDate >= d.D))))
      ) o
      WHERE i.Id = @ItemId
      ORDER BY Available, d.D
    `);
  return result.recordset[0];
}

const dayLabel = (day, today) => {
  const iso = day instanceof Date ? day.toISOString().slice(0, 10) : String(day).slice(0, 10);
  if (iso <= today) return "right now";
  const [y, m, d] = iso.split("-").map(Number);
  return `on ${new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
};

// Stops any change that would leave fewer than zero of an item free on any
// day. Call it inside the transaction, after the change: it throws, so the
// whole change is undone. The item rows are locked so two people can't
// both take the last one at the same moment.
async function assertStock(db, inventoryItemIds) {
  const ids = [...new Set(inventoryItemIds.filter(Boolean))].sort((a, b) => a - b);
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    await db.request().input("Id", sql.Int, id).query("SELECT Id FROM dbo.InventoryItems WITH (UPDLOCK, HOLDLOCK) WHERE Id = @Id");
    const low = await lowestAvailable(db, id);
    if (low && low.Available < 0) {
      throw new HttpError(409, `There aren't enough ${low.Name} for that: it would be ${-low.Available} short ${dayLabel(low.Day, today)}. ` +
        "Ask for fewer, pick other dates, or add more on the Inventory page.");
    }
  }
}

// The same check for everything on one ticket, after its dates or status change.
async function assertTicketStock(db, ticketId) {
  const lines = await db.request().input("Id", sql.Int, ticketId)
    .query("SELECT DISTINCT InventoryItemId FROM dbo.TicketItems WHERE TicketId = @Id AND ReturnedAt IS NULL");
  await assertStock(db, lines.recordset.map((l) => l.InventoryItemId));
}

// Stops a license being assigned to more people than there are seats.
async function assertSeats(db, softwareIds) {
  const ids = [...new Set(softwareIds.filter(Boolean))].sort((a, b) => a - b);
  for (const id of ids) {
    const result = await db.request().input("Id", sql.Int, id).query(`
      SELECT s.Name, s.SeatsPurchased,
             (SELECT COUNT(*) FROM dbo.LicenseAssignments la WHERE la.SoftwareId = s.Id AND la.RemovedAt IS NULL) AS SeatsUsed
      FROM dbo.Software s WITH (UPDLOCK, HOLDLOCK)
      WHERE s.Id = @Id
    `);
    const row = result.recordset[0];
    if (row && row.SeatsUsed > row.SeatsPurchased) {
      throw new HttpError(409, `There are no free ${row.Name} seats: all ${row.SeatsPurchased} are assigned. ` +
        "Free one up or add seats on the Inventory page first.");
    }
  }
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

// Puts an inventory line on a ticket at today's unit cost. With holderId (and
// no ticket) it's handed straight to that person and counts as out now.
async function addTicketItem(db, ticketId, inventoryItemId, quantity, holderId = null) {
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
    .input("HolderId", sql.Int, holderId)
    .query(`
      INSERT INTO dbo.TicketItems (TicketId, InventoryItemId, Quantity, UnitCostAtTime, HolderId, OutAt)
      OUTPUT INSERTED.Id
      VALUES (@TicketId, @ItemId, @Quantity, @UnitCost, @HolderId, CASE WHEN @HolderId IS NULL THEN NULL ELSE SYSUTCDATETIME() END)
    `);
  await assertStock(db, [inventoryItemId]);
  return { id: row.recordset[0].Id, name: item.Name };
}

module.exports = { getAvailability, lowestAvailable, assertStock, assertTicketStock, assertSeats, readItems, addTicketItem };
