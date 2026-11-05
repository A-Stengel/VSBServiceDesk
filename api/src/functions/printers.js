const { endpoint, readJson, requiredText, optionalText, optionalId, isUniqueViolation } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { logChange } = require("../shared/changelog");
const { money } = require("../shared/format");
const { recordEvents, formatNumber } = require("../shared/tickets");

// Printers, and the ink and toner IT keeps for them. Each cartridge is a type
// and color with a count, and says which printers it works with, so a low ink
// ticket for any of those printers shows its stock. Changes go in the
// Inventory history (sections printers and ink). Counts never go below zero.

async function printers(db) {
  const rows = (await db.request().query(`
    SELECT p.Id, p.Name, p.Model, p.Location, p.DepartmentId, d.Name AS DepartmentName, p.IsActive
    FROM dbo.Printers p
    LEFT JOIN dbo.Departments d ON d.Id = p.DepartmentId
    WHERE p.IsDeleted = 0
    ORDER BY p.Name
  `)).recordset;
  return rows;
}

async function cartridges(db) {
  const rows = (await db.request().query(`
    SELECT c.Id, c.Name, c.Color, c.QuantityOnHand, c.LowStockAt, c.UnitCost, c.IsActive
    FROM dbo.InkCartridges c
    WHERE c.IsDeleted = 0
    ORDER BY c.Name, c.Color
  `)).recordset;
  const links = (await db.request().query(`
    SELECT cp.InkCartridgeId, cp.PrinterId FROM dbo.InkCartridgePrinters cp
    JOIN dbo.Printers p ON p.Id = cp.PrinterId AND p.IsDeleted = 0
  `)).recordset;
  for (const row of rows) row.PrinterIds = links.filter((l) => l.InkCartridgeId === row.Id).map((l) => l.PrinterId);
  return rows;
}

endpoint("printing", { methods: ["GET"], route: "printing", role: "technician" }, async () => {
  const pool = await getConnection();
  return { jsonBody: { printers: await printers(pool), ink: await cartridges(pool) } };
});

function readCount(value, field) {
  const n = Number(value);
  if (value === "" || value === null || value === undefined || !Number.isInteger(n) || n < 0 || n > 100000) {
    throw new HttpError(400, `${field} must be a whole number, 0 or more`);
  }
  return n;
}

function readWarnAt(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new HttpError(400, "Warn at must be a whole number, or blank for no warning");
  return n;
}

function readCost(value) {
  if (value === "" || value === null || value === undefined) return 0;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > 99999999) throw new HttpError(400, "Cost each must be an amount");
  return Math.round(n * 100) / 100;
}

function readPrinterIds(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "Works with must be a list of printers");
  return [...new Set(value.map((v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, "Pick printers from the list");
    return n;
  }))];
}

// ---------------------------------------------------------------------------
// Printers
// ---------------------------------------------------------------------------

function readPrinter(body, isNew) {
  const values = {};
  if (isNew || "name" in body) values.Name = [sql.NVarChar(100), requiredText(body.name, "Name", 100)];
  if ("model" in body) values.Model = [sql.NVarChar(150), optionalText(body.model, "Model", 150)];
  if ("location" in body) values.Location = [sql.NVarChar(200), optionalText(body.location, "Location", 200)];
  if ("departmentId" in body) values.DepartmentId = [sql.Int, optionalId(body.departmentId, "Department")];
  if (!isNew && "isActive" in body) values.IsActive = [sql.Bit, !!body.isActive];
  return values;
}

// Body: { name, model, location, departmentId }
endpoint(
  "addPrinter",
  { methods: ["POST"], route: "printing/printers", role: "technician", failMessage: "Could not add the printer" },
  async (request, context, user) => {
    const values = readPrinter(await readJson(request), true);
    try {
      await withTransaction(async (tx) => {
        const req = tx.request();
        for (const [column, [type, value]] of Object.entries(values)) req.input(column, type, value);
        const columns = Object.keys(values);
        const row = (await req.query(`
          INSERT INTO dbo.Printers (${columns.join(", ")}) OUTPUT INSERTED.Id VALUES (${columns.map((c) => `@${c}`).join(", ")})
        `)).recordset[0];
        await logChange(tx, { area: "inventory", section: "printers", entityId: row.Id, actorId: user.Id, summary: `Added the printer ${values.Name[1]}` });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `There's already a printer called ${values.Name[1]}`);
      throw error;
    }
    return { status: 201, jsonBody: { ok: true } };
  }
);

// Body: any of { name, model, location, departmentId, isActive }
endpoint(
  "updatePrinter",
  { methods: ["PATCH"], route: "printing/printers/{id:int}", role: "technician", failMessage: "Could not save the printer" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const values = readPrinter(await readJson(request), false);
    try {
      await withTransaction(async (tx) => {
        const before = (await tx.request().input("Id", sql.Int, id).query("SELECT * FROM dbo.Printers WHERE Id = @Id AND IsDeleted = 0")).recordset[0];
        if (!before) throw new HttpError(404, "That printer doesn't exist");
        const changed = Object.entries(values).filter(([column, [, value]]) => (before[column] ?? null) !== (value ?? null) && !(typeof value === "boolean" && !!before[column] === value));
        if (!changed.length) return;
        const req = tx.request().input("Id", sql.Int, id);
        for (const [column, [type, value]] of changed) req.input(column, type, value);
        await req.query(`UPDATE dbo.Printers SET ${changed.map(([c]) => `${c} = @${c}`).join(", ")} WHERE Id = @Id`);
        const notes = changed.map(([column, [, value]]) => {
          if (column === "Name") return `Renamed the printer ${before.Name} to ${value}`;
          if (column === "IsActive") return `${value ? "Turned on" : "Turned off"} the printer ${before.Name}`;
          if (column === "DepartmentId") return `${before.Name}: changed the department`;
          return `${before.Name}: ${column.toLowerCase()} ${before[column] || "empty"} to ${value || "empty"}`;
        });
        for (const summary of notes) await logChange(tx, { area: "inventory", section: "printers", entityId: id, actorId: user.Id, summary });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "There's already a printer with that name");
      throw error;
    }
    return { jsonBody: { ok: true } };
  }
);

// Old tickets still point at the printer, so it's hidden rather than removed.
endpoint(
  "deletePrinter",
  { methods: ["DELETE"], route: "printing/printers/{id:int}", role: "technician", failMessage: "Could not delete the printer" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    await withTransaction(async (tx) => {
      const before = (await tx.request().input("Id", sql.Int, id).query("SELECT Name FROM dbo.Printers WHERE Id = @Id AND IsDeleted = 0")).recordset[0];
      if (!before) throw new HttpError(404, "That printer doesn't exist");
      const held = (await tx.request().input("Id", sql.Int, id)
        .query("SELECT COUNT(*) AS N FROM dbo.PersonAccess WHERE Kind = 'printer' AND RefId = @Id AND RemovedAt IS NULL")).recordset[0].N;
      if (held) throw new HttpError(400, `${held} ${held === 1 ? "person has" : "people have"} access to this printer. Turn it off instead, or remove their access first.`);
      await tx.request().input("Id", sql.Int, id).query(`
        DELETE FROM dbo.InkCartridgePrinters WHERE PrinterId = @Id;
        UPDATE dbo.Printers SET IsDeleted = 1, IsActive = 0, Name = CONCAT(LEFT(Name, 80), N' (deleted #', Id, N')') WHERE Id = @Id;
      `);
      await logChange(tx, { area: "inventory", section: "printers", entityId: id, actorId: user.Id, summary: `Deleted the printer ${before.Name}` });
    });
    return { jsonBody: { ok: true } };
  }
);

// ---------------------------------------------------------------------------
// Ink and toner
// ---------------------------------------------------------------------------

async function setPrinters(tx, cartridgeId, printerIds) {
  for (const printerId of printerIds) {
    const found = (await tx.request().input("Id", sql.Int, printerId).query("SELECT Id FROM dbo.Printers WHERE Id = @Id AND IsDeleted = 0")).recordset[0];
    if (!found) throw new HttpError(400, "One of the printers picked no longer exists");
  }
  await tx.request().input("Id", sql.Int, cartridgeId).query("DELETE FROM dbo.InkCartridgePrinters WHERE InkCartridgeId = @Id");
  for (const printerId of printerIds) {
    await tx.request().input("Id", sql.Int, cartridgeId).input("PrinterId", sql.Int, printerId)
      .query("INSERT INTO dbo.InkCartridgePrinters (InkCartridgeId, PrinterId) VALUES (@Id, @PrinterId)");
  }
}

const inkName = (row) => `${row.Name} ${row.Color}`;

// Body: { name, color, count, lowStockAt, cost, printerIds }
endpoint(
  "addInk",
  { methods: ["POST"], route: "printing/ink", role: "technician", failMessage: "Could not add the cartridge" },
  async (request, context, user) => {
    const body = await readJson(request);
    const name = requiredText(body.name, "Type", 100);
    const color = requiredText(body.color, "Color", 50);
    const count = readCount(body.count ?? 0, "On hand");
    const lowStockAt = readWarnAt(body.lowStockAt);
    const cost = readCost(body.cost);
    const printerIds = readPrinterIds(body.printerIds);
    try {
      await withTransaction(async (tx) => {
        const row = (await tx.request()
          .input("Name", sql.NVarChar(100), name)
          .input("Color", sql.NVarChar(50), color)
          .input("Count", sql.Int, count)
          .input("LowStockAt", sql.Int, lowStockAt)
          .input("Cost", sql.Decimal(10, 2), cost)
          .query(`
            INSERT INTO dbo.InkCartridges (Name, Color, QuantityOnHand, LowStockAt, UnitCost)
            OUTPUT INSERTED.Id VALUES (@Name, @Color, @Count, @LowStockAt, @Cost)
          `)).recordset[0];
        await setPrinters(tx, row.Id, printerIds);
        await logChange(tx, {
          area: "inventory",
          section: "ink",
          entityId: row.Id,
          actorId: user.Id,
          summary: `Added ${name} ${color}: ${count} at ${money(cost)} each, works with ${printerIds.length} printer${printerIds.length === 1 ? "" : "s"}`
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `There's already a ${name} ${color} cartridge`);
      throw error;
    }
    return { status: 201, jsonBody: { ok: true } };
  }
);

// Body: any of { name, color, count, lowStockAt, cost, isActive, printerIds }
endpoint(
  "updateInk",
  { methods: ["PATCH"], route: "printing/ink/{id:int}", role: "technician", failMessage: "Could not save the cartridge" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    try {
      await withTransaction(async (tx) => {
        const before = (await tx.request().input("Id", sql.Int, id).query("SELECT * FROM dbo.InkCartridges WHERE Id = @Id AND IsDeleted = 0")).recordset[0];
        if (!before) throw new HttpError(404, "That cartridge doesn't exist");
        const label = inkName(before);
        const sets = [];
        const notes = [];
        const req = tx.request().input("Id", sql.Int, id);
        const change = (column, type, value, note) => {
          sets.push(`${column} = @${column}`);
          req.input(column, type, value);
          notes.push(note);
        };
        if ("name" in body) {
          const name = requiredText(body.name, "Type", 100);
          if (name !== before.Name) change("Name", sql.NVarChar(100), name, `Renamed ${label} to ${name} ${before.Color}`);
        }
        if ("color" in body) {
          const color = requiredText(body.color, "Color", 50);
          if (color !== before.Color) change("Color", sql.NVarChar(50), color, `${label}: color ${before.Color} to ${color}`);
        }
        if ("count" in body) {
          const count = readCount(body.count, "On hand");
          if (count !== before.QuantityOnHand) change("QuantityOnHand", sql.Int, count, `${label}: on hand ${before.QuantityOnHand} to ${count}`);
        }
        if ("lowStockAt" in body) {
          const warnAt = readWarnAt(body.lowStockAt);
          const shown = (n) => (n === null ? "no warning" : String(n));
          if (warnAt !== before.LowStockAt) change("LowStockAt", sql.Int, warnAt, `${label}: warn at ${shown(before.LowStockAt)} to ${shown(warnAt)}`);
        }
        if ("cost" in body) {
          const cost = readCost(body.cost);
          if (cost !== Number(before.UnitCost)) change("UnitCost", sql.Decimal(10, 2), cost, `${label}: cost each ${money(before.UnitCost)} to ${money(cost)}`);
        }
        if ("isActive" in body && !!body.isActive !== !!before.IsActive) {
          change("IsActive", sql.Bit, !!body.isActive, `${body.isActive ? "Turned on" : "Turned off"} ${label}`);
        }
        if (sets.length) await req.query(`UPDATE dbo.InkCartridges SET ${sets.join(", ")} WHERE Id = @Id`);
        if ("printerIds" in body) {
          const printerIds = readPrinterIds(body.printerIds);
          const old = (await tx.request().input("Id", sql.Int, id).query("SELECT PrinterId FROM dbo.InkCartridgePrinters WHERE InkCartridgeId = @Id")).recordset.map((r) => r.PrinterId);
          const same = old.length === printerIds.length && old.every((p) => printerIds.includes(p));
          if (!same) {
            await setPrinters(tx, id, printerIds);
            const names = printerIds.length
              ? (await tx.request().query(`SELECT Name FROM dbo.Printers WHERE Id IN (${printerIds.join(", ")}) ORDER BY Name`)).recordset.map((r) => r.Name).join(", ")
              : "no printers";
            notes.push(`${label}: works with ${names}`);
          }
        }
        for (const summary of notes) await logChange(tx, { area: "inventory", section: "ink", entityId: id, actorId: user.Id, summary });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "There's already a cartridge with that type and color");
      throw error;
    }
    return { jsonBody: { ok: true } };
  }
);

// Old low ink tickets still point at the cartridge, so it's hidden rather
// than removed.
endpoint(
  "deleteInk",
  { methods: ["DELETE"], route: "printing/ink/{id:int}", role: "technician", failMessage: "Could not delete the cartridge" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    await withTransaction(async (tx) => {
      const before = (await tx.request().input("Id", sql.Int, id).query("SELECT Name, Color FROM dbo.InkCartridges WHERE Id = @Id AND IsDeleted = 0")).recordset[0];
      if (!before) throw new HttpError(404, "That cartridge doesn't exist");
      await tx.request().input("Id", sql.Int, id).query(`
        DELETE FROM dbo.InkCartridgePrinters WHERE InkCartridgeId = @Id;
        UPDATE dbo.InkCartridges SET IsDeleted = 1, IsActive = 0, Name = CONCAT(LEFT(Name, 80), N' (deleted #', Id, N')') WHERE Id = @Id;
      `);
      await logChange(tx, { area: "inventory", section: "ink", entityId: id, actorId: user.Id, summary: `Deleted ${inkName(before)}` });
    });
    return { jsonBody: { ok: true } };
  }
);

// ---------------------------------------------------------------------------
// Low ink tickets: "Take 1" lowers the count for a cartridge reported low,
// and undo puts it back. The count never goes below zero.
// ---------------------------------------------------------------------------

async function inkLine(tx, ticketId, lineId) {
  const line = (await tx.request().input("Id", sql.Int, lineId).input("TicketId", sql.Int, ticketId).query(`
    SELECT ti.Id, ti.InkCartridgeId, ti.TakenAt, c.Name, c.Color
    FROM dbo.TicketInk ti JOIN dbo.InkCartridges c ON c.Id = ti.InkCartridgeId
    WHERE ti.Id = @Id AND ti.TicketId = @TicketId
  `)).recordset[0];
  if (!line) throw new HttpError(404, "That cartridge isn't on this ticket");
  return line;
}

endpoint(
  "takeInk",
  { methods: ["POST"], route: "tickets/{id:int}/ink/{lineId:int}/take", role: "technician", failMessage: "Could not take the cartridge" },
  async (request, context, user) => {
    const ticketId = Number(request.params.id);
    const lineId = Number(request.params.lineId);
    await withTransaction(async (tx) => {
      const line = await inkLine(tx, ticketId, lineId);
      if (line.TakenAt) throw new HttpError(400, "That cartridge was already taken for this ticket");
      const taken = await tx.request().input("Id", sql.Int, line.InkCartridgeId)
        .query("UPDATE dbo.InkCartridges SET QuantityOnHand = QuantityOnHand - 1 WHERE Id = @Id AND QuantityOnHand > 0");
      if (!taken.rowsAffected[0]) throw new HttpError(400, `There are no ${inkName(line)} cartridges left. Add stock on the Inventory page.`);
      await tx.request().input("Id", sql.Int, lineId).input("UserId", sql.Int, user.Id)
        .query("UPDATE dbo.TicketInk SET TakenAt = SYSUTCDATETIME(), TakenById = @UserId WHERE Id = @Id");
      await recordEvents(tx, ticketId, user.Id, [{ field: "Ink taken", newValue: inkName(line) }]);
      await logChange(tx, { area: "inventory", section: "ink", entityId: line.InkCartridgeId, actorId: user.Id, summary: `Took 1 ${inkName(line)} for ticket ${formatNumber(ticketId)}` });
    });
    return { jsonBody: { ok: true } };
  }
);

endpoint(
  "undoTakeInk",
  { methods: ["DELETE"], route: "tickets/{id:int}/ink/{lineId:int}/take", role: "technician", failMessage: "Could not put the cartridge back" },
  async (request, context, user) => {
    const ticketId = Number(request.params.id);
    const lineId = Number(request.params.lineId);
    await withTransaction(async (tx) => {
      const line = await inkLine(tx, ticketId, lineId);
      if (!line.TakenAt) return;
      await tx.request().input("Id", sql.Int, line.InkCartridgeId).query("UPDATE dbo.InkCartridges SET QuantityOnHand = QuantityOnHand + 1 WHERE Id = @Id");
      await tx.request().input("Id", sql.Int, lineId).query("UPDATE dbo.TicketInk SET TakenAt = NULL, TakenById = NULL WHERE Id = @Id");
      await recordEvents(tx, ticketId, user.Id, [{ field: "Ink put back", newValue: inkName(line) }]);
      await logChange(tx, { area: "inventory", section: "ink", entityId: line.InkCartridgeId, actorId: user.Id, summary: `Put back 1 ${inkName(line)} from ticket ${formatNumber(ticketId)}` });
    });
    return { jsonBody: { ok: true } };
  }
);
