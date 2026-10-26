const { endpoint, readJson, requiredText, optionalId, isUniqueViolation } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { logChange, listChanges } = require("../shared/changelog");
const { money } = require("../shared/format");
const { lowestAvailable } = require("../shared/inventory");

// The Inventory page: equipment (how many IT owns and how many are out now)
// and software licenses (seats owned and in use, and what they cost). Every
// technician can add, adjust and delete, and every change goes in the
// Inventory history. Costs are for tracking only.

async function equipment(db) {
  const result = await db.request().query(`
    SELECT i.Id, i.Name, i.UnitCost, i.QuantityOwned, i.IsActive, i.IsDefaultForOnboarding,
           COALESCE(o.QuantityOut, 0) AS QuantityOut,
           i.QuantityOwned - COALESCE(o.QuantityOut, 0) AS Available,
           CAST(CASE WHEN EXISTS (
             SELECT 1 FROM dbo.TicketItems x
             LEFT JOIN dbo.Tickets t ON t.Id = x.TicketId
             LEFT JOIN dbo.Statuses s ON s.Id = t.StatusId
             WHERE x.InventoryItemId = i.Id AND x.ReturnedAt IS NULL
               AND (x.OutAt IS NOT NULL OR (t.Id IS NOT NULL AND s.IsClosed = 0))
           ) THEN 1 ELSE 0 END AS BIT) AS InUse
    FROM dbo.InventoryItems i
    OUTER APPLY (
      SELECT SUM(ti.Quantity) AS QuantityOut
      FROM dbo.TicketItems ti
      WHERE ti.InventoryItemId = i.Id AND ti.OutAt IS NOT NULL AND ti.ReturnedAt IS NULL
    ) o
    WHERE i.IsDeleted = 0
    ORDER BY i.SortOrder, i.Name
  `);
  return result.recordset;
}

async function licenses(db) {
  const result = await db.request().query(`
    SELECT s.Id, s.Name, s.CostPerSeat, s.SeatsPurchased, s.IsActive, s.IsDefaultForOnboarding,
           s.BillingPeriodId, b.Name AS BillingPeriodName, b.MonthsPerPeriod,
           (SELECT COUNT(*) FROM dbo.LicenseAssignments la WHERE la.SoftwareId = s.Id AND la.RemovedAt IS NULL) AS SeatsUsed,
           CAST(s.SeatsPurchased * s.CostPerSeat / NULLIF(b.MonthsPerPeriod, 0) AS DECIMAL(12, 2)) AS MonthlyCost
    FROM dbo.Software s
    JOIN dbo.BillingPeriods b ON b.Id = s.BillingPeriodId
    WHERE s.IsDeleted = 0
    ORDER BY s.SortOrder, s.Name
  `);
  return result.recordset;
}

endpoint("inventory", { methods: ["GET"], route: "inventory", role: "technician" }, async () => {
  const pool = await getConnection();
  const settings = await getSettings();
  const items = await equipment(pool);
  const software = await licenses(pool);
  return {
    jsonBody: {
      equipment: items,
      licenses: software,
      lowStockThreshold: settings.LowStockThreshold ?? 2,
      totals: {
        equipmentValue: items.reduce((sum, i) => sum + i.QuantityOwned * Number(i.UnitCost), 0),
        monthlyLicenses: software.reduce((sum, s) => sum + Number(s.MonthlyCost || 0), 0)
      },
      history: await listChanges(pool, { area: "inventory", top: 50 })
    }
  };
});

function readCount(value, field) {
  const n = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isInteger(n) || n < 0 || n > 100000) {
    throw new HttpError(400, `${field} must be a whole number`);
  }
  return n;
}

function readCost(value, field) {
  const n = Number(value);
  if (value === "" || value === null || value === undefined || Number.isNaN(n) || n < 0 || n > 99999999) {
    throw new HttpError(400, `${field} must be an amount`);
  }
  return Math.round(n * 100) / 100;
}

// The two kinds of inventory. "in use" is what can't go: the count can't drop
// below it, and the row can't be deleted while it's above zero.
const KINDS = {
  equipment: {
    table: "dbo.InventoryItems",
    section: "equipment",
    noun: "item",
    count: { column: "QuantityOwned", label: "On hand" },
    cost: { column: "UnitCost", label: "Cost each" },
    inUse: async (db, id) => {
      const row = (await equipment(db)).find((i) => i.Id === id);
      return row ? { used: row.QuantityOut, blocked: row.InUse, label: "checked out" } : null;
    }
  },
  licenses: {
    table: "dbo.Software",
    section: "licenses",
    noun: "license",
    count: { column: "SeatsPurchased", label: "Seats owned" },
    cost: { column: "CostPerSeat", label: "Cost per seat" },
    inUse: async (db, id) => {
      const row = (await licenses(db)).find((s) => s.Id === id);
      return row ? { used: row.SeatsUsed, blocked: row.SeatsUsed > 0, label: "assigned" } : null;
    }
  }
};

function kindOf(request) {
  const kind = KINDS[request.params.kind];
  if (!kind) throw new HttpError(404, "Unknown inventory list");
  return kind;
}

// Body: { name, count, cost } and, for licenses, { billingPeriodId } (Monthly
// when left out).
endpoint(
  "addInventory",
  { methods: ["POST"], route: "inventory/{kind}", role: "technician", failMessage: "Could not add it" },
  async (request, context, user) => {
    const kind = kindOf(request);
    const body = await readJson(request);
    const name = requiredText(body.name, "Name", 150);
    const count = readCount(body.count, kind.count.label);
    const cost = readCost(body.cost ?? 0, kind.cost.label);
    try {
      await withTransaction(async (tx) => {
        const req = tx.request()
          .input("Name", sql.NVarChar(150), name)
          .input("Count", sql.Int, count)
          .input("Cost", sql.Decimal(10, 2), cost);
        if (kind === KINDS.licenses) {
          let periodId = optionalId(body.billingPeriodId, "Billing period");
          if (!periodId) {
            const monthly = await tx.request().query("SELECT TOP (1) Id FROM dbo.BillingPeriods WHERE IsActive = 1 ORDER BY SortOrder, Id");
            periodId = monthly.recordset[0]?.Id;
          }
          if (!periodId) throw new HttpError(400, "Add a billing period in Settings first");
          await req.input("PeriodId", sql.Int, periodId).query(`
            INSERT INTO dbo.Software (Name, SeatsPurchased, CostPerSeat, BillingPeriodId) VALUES (@Name, @Count, @Cost, @PeriodId)
          `);
        } else {
          await req.query("INSERT INTO dbo.InventoryItems (Name, QuantityOwned, UnitCost) VALUES (@Name, @Count, @Cost)");
        }
        await logChange(tx, {
          area: "inventory",
          section: kind.section,
          actorId: user.Id,
          summary: `Added ${name}: ${count} at ${money(cost)} ${kind === KINDS.licenses ? "per seat" : "each"}`
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `There's already a ${kind.noun} called ${name}. Pick another name.`);
      throw error;
    }
    return { status: 201, jsonBody: { ok: true } };
  }
);

// Body: any of { name, count, cost, isActive } and, for licenses, billingPeriodId
endpoint(
  "updateInventory",
  { methods: ["PATCH"], route: "inventory/{kind}/{id:int}", role: "technician", failMessage: "Could not save it" },
  async (request, context, user) => {
    const kind = kindOf(request);
    const id = Number(request.params.id);
    const body = await readJson(request);
    try {
      await withTransaction(async (tx) => {
        const found = await tx.request().input("Id", sql.Int, id)
          .query(`SELECT Name, ${kind.count.column} AS Count, ${kind.cost.column} AS Cost, IsActive FROM ${kind.table} WHERE Id = @Id AND IsDeleted = 0`);
        const before = found.recordset[0];
        if (!before) throw new HttpError(404, "Not found");
        const sets = [];
        const notes = [];
        const req = tx.request().input("Id", sql.Int, id);
        if ("name" in body) {
          const name = requiredText(body.name, "Name", 150);
          if (name !== before.Name) {
            sets.push("Name = @Name");
            req.input("Name", sql.NVarChar(150), name);
            notes.push(`Renamed ${before.Name} to ${name}`);
          }
        }
        if ("count" in body) {
          const count = readCount(body.count, kind.count.label);
          if (kind === KINDS.equipment) {
            // Out now, or booked for any day from today on
            const low = await lowestAvailable(tx, id);
            const needed = low ? before.Count - low.Available : 0;
            if (count < needed) throw new HttpError(400, `${needed} are out or booked on the busiest day, so ${kind.count.label.toLowerCase()} can't go below that`);
          } else {
            const use = await kind.inUse(tx, id);
            if (count < use.used) throw new HttpError(400, `${use.used} are ${use.label}, so ${kind.count.label.toLowerCase()} can't go below that`);
          }
          if (count !== before.Count) {
            sets.push(`${kind.count.column} = @Count`);
            req.input("Count", sql.Int, count);
            notes.push(`${before.Name}: ${kind.count.label.toLowerCase()} ${before.Count} to ${count}`);
          }
        }
        if ("cost" in body) {
          const cost = readCost(body.cost, kind.cost.label);
          if (cost !== Number(before.Cost)) {
            sets.push(`${kind.cost.column} = @Cost`);
            req.input("Cost", sql.Decimal(10, 2), cost);
            notes.push(`${before.Name}: ${kind.cost.label.toLowerCase()} ${money(before.Cost)} to ${money(cost)}`);
          }
        }
        if (kind === KINDS.licenses && "billingPeriodId" in body) {
          const periodId = optionalId(body.billingPeriodId, "Billing period");
          if (!periodId) throw new HttpError(400, "Pick how often it's billed");
          const periods = await tx.request().input("Id", sql.Int, id).input("PeriodId", sql.Int, periodId).query(`
            SELECT (SELECT b.Name FROM dbo.Software s JOIN dbo.BillingPeriods b ON b.Id = s.BillingPeriodId WHERE s.Id = @Id) AS Was,
                   (SELECT Name FROM dbo.BillingPeriods WHERE Id = @PeriodId AND IsActive = 1) AS Now,
                   (SELECT BillingPeriodId FROM dbo.Software WHERE Id = @Id) AS WasId
          `);
          const { Was, Now, WasId } = periods.recordset[0];
          if (!Now) throw new HttpError(400, "That billing period isn't available");
          if (WasId !== periodId) {
            sets.push("BillingPeriodId = @PeriodId");
            req.input("PeriodId", sql.Int, periodId);
            notes.push(`${before.Name}: billed ${String(Was).toLowerCase()} to ${Now.toLowerCase()}`);
          }
        }
        if ("isActive" in body && !!body.isActive !== before.IsActive) {
          sets.push("IsActive = @IsActive");
          req.input("IsActive", sql.Bit, !!body.isActive);
          notes.push(`${body.isActive ? "Turned on" : "Turned off"} ${before.Name}`);
        }
        if (!sets.length) return;
        await req.query(`UPDATE ${kind.table} SET ${sets.join(", ")} WHERE Id = @Id`);
        for (const summary of notes) await logChange(tx, { area: "inventory", section: kind.section, entityId: id, actorId: user.Id, summary });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `There's already a ${kind.noun} with that name`);
      throw error;
    }
    return { jsonBody: { ok: true } };
  }
);

// Only when none are checked out (or no seats are assigned). Old tickets
// still point at the row, so it's hidden rather than removed.
endpoint(
  "deleteInventory",
  { methods: ["DELETE"], route: "inventory/{kind}/{id:int}", role: "technician", failMessage: "Could not delete it" },
  async (request, context, user) => {
    const kind = kindOf(request);
    const id = Number(request.params.id);
    await withTransaction(async (tx) => {
      const found = await tx.request().input("Id", sql.Int, id).query(`SELECT Name FROM ${kind.table} WHERE Id = @Id AND IsDeleted = 0`);
      if (!found.recordset[0]) throw new HttpError(404, "Not found");
      const use = await kind.inUse(tx, id);
      if (use.blocked) {
        throw new HttpError(400, kind === KINDS.licenses
          ? "Seats are still assigned. Remove them first."
          : "Some are still checked out or asked for on an open ticket. Mark them returned first.");
      }
      await tx.request().input("Id", sql.Int, id)
        // The name is freed so a new one can use it
        .query(`
          UPDATE ${kind.table}
          SET IsDeleted = 1, IsActive = 0, IsDefaultForOnboarding = 0,
              Name = CONCAT(LEFT(Name, 120), N' (deleted #', Id, N')')
          WHERE Id = @Id
        `);
      await logChange(tx, { area: "inventory", section: kind.section, entityId: id, actorId: user.Id, summary: `Deleted ${found.recordset[0].Name}` });
    });
    return { jsonBody: { ok: true } };
  }
);
