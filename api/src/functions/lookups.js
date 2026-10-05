const { endpoint, readJson, isUniqueViolation, isForeignKeyViolation } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { LOOKUPS, FIELD_KEYS, orderBy, columnList } = require("../shared/lookups");
const { getSettings } = require("../shared/settings");

// Everything the forms need in one call: the active rows of every lookup, which
// fields each ticket type shows, and the status/priority ids the screens use.
endpoint("getLookups", { methods: ["GET"], route: "lookups" }, async () => {
  const pool = await getConnection();
  const lookups = {};
  for (const [key, def] of Object.entries(LOOKUPS)) {
    const result = await pool.request().query(`SELECT ${columnList(def)} FROM ${def.table} WHERE IsActive = 1 ORDER BY ${orderBy(def)}`);
    lookups[key] = result.recordset;
  }
  const fields = await pool.request().query(`
    SELECT TicketTypeId, FieldKey, Label, IsRequired, SortOrder
    FROM dbo.TicketTypeFields
    ORDER BY TicketTypeId, SortOrder
  `);
  const settings = await getSettings();
  return {
    jsonBody: {
      ...lookups,
      ticketTypeFields: fields.recordset,
      defaults: {
        newStatusId: settings.NewStatusId,
        awaitingStatusId: settings.AwaitingStatusId,
        closedStatusId: settings.ClosedStatusId,
        defaultPriorityId: settings.DefaultPriorityId,
        webSourceId: settings.WebSourceId
      }
    }
  };
});

function getDef(request) {
  const def = LOOKUPS[request.params.table];
  if (!def) throw new HttpError(404, "Unknown list");
  return def;
}

// Turns request values into typed SQL inputs, checking each against its column.
function readValues(def, body, isNew) {
  const values = [];
  for (const column of def.columns) {
    if (!(column.name in body)) {
      if (isNew && column.required) throw new HttpError(400, `${column.label} is required`);
      if (isNew && column.default !== undefined) values.push({ column, type: sql.Bit, value: column.default });
      continue;
    }
    let value = body[column.name];
    if (value === "" || value === undefined) value = null;
    if (value === null) {
      if (column.required) throw new HttpError(400, `${column.label} is required`);
      if (column.type === "bit") value = false;
      if (column.type === "int" || column.type === "decimal") value = 0;
    }
    let type;
    switch (column.type) {
      case "string":
        if (value !== null) {
          value = String(value).trim();
          if (column.max && value.length > column.max) throw new HttpError(400, `${column.label} must be ${column.max} characters or fewer`);
          if (!value && column.required) throw new HttpError(400, `${column.label} is required`);
        }
        type = sql.NVarChar(column.max || 400);
        break;
      case "int":
      case "ref":
        if (value !== null && !Number.isInteger(Number(value))) throw new HttpError(400, `${column.label} must be a whole number`);
        value = value === null ? null : Number(value);
        type = sql.Int;
        break;
      case "decimal":
        if (value !== null && Number.isNaN(Number(value))) throw new HttpError(400, `${column.label} must be a number`);
        value = value === null ? null : Number(value);
        type = sql.Decimal(10, 2);
        break;
      case "bit":
        value = value === true || value === 1 || value === "true" || value === "1";
        type = sql.Bit;
        break;
      case "date":
        if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new HttpError(400, `${column.label} must be a date`);
        type = sql.Date;
        break;
      case "choice":
        if (value !== null && !column.choices.includes(value)) throw new HttpError(400, `${column.label} must be one of: ${column.choices.join(", ")}`);
        type = sql.NVarChar(50);
        break;
      default:
        throw new Error(`Unknown column type ${column.type}`);
    }
    values.push({ column, type, value });
  }
  return values;
}

function bind(request, values) {
  values.forEach((v, i) => request.input(`v${i}`, v.type, v.value));
  return request;
}

function friendlyError(error) {
  if (isUniqueViolation(error)) return new HttpError(409, "An entry with that name already exists");
  if (isForeignKeyViolation(error)) return new HttpError(400, "That refers to an entry that doesn't exist");
  return error;
}

endpoint("adminListLookup", { methods: ["GET"], route: "manage/lookups/{table}", role: "admin" }, async (request) => {
  const def = getDef(request);
  const pool = await getConnection();
  const result = await pool.request().query(`SELECT ${columnList(def)} FROM ${def.table} ORDER BY ${orderBy(def)}`);
  return { jsonBody: { label: def.label, columns: def.columns, rows: result.recordset } };
});

endpoint(
  "adminCreateLookup",
  { methods: ["POST"], route: "manage/lookups/{table}", role: "admin", failMessage: "Could not add the entry" },
  async (request) => {
    const def = getDef(request);
    const values = readValues(def, await readJson(request), true);
    const pool = await getConnection();
    try {
      const result = await bind(pool.request(), values).query(`
        INSERT INTO ${def.table} (${values.map((v) => `[${v.column.name}]`).join(", ")})
        OUTPUT INSERTED.Id
        VALUES (${values.map((v, i) => `@v${i}`).join(", ")})
      `);
      return { status: 201, jsonBody: { Id: result.recordset[0].Id } };
    } catch (error) {
      throw friendlyError(error);
    }
  }
);

endpoint(
  "adminUpdateLookup",
  { methods: ["PATCH"], route: "manage/lookups/{table}/{id:int}", role: "admin", failMessage: "Could not save the entry" },
  async (request) => {
    const def = getDef(request);
    const values = readValues(def, await readJson(request), false);
    if (!values.length) throw new HttpError(400, "Nothing to change");
    const pool = await getConnection();
    try {
      const result = await bind(pool.request(), values)
        .input("Id", sql.Int, Number(request.params.id))
        .query(`UPDATE ${def.table} SET ${values.map((v, i) => `[${v.column.name}] = @v${i}`).join(", ")} WHERE Id = @Id`);
      if (!result.rowsAffected[0]) throw new HttpError(404, "Entry not found");
      return { jsonBody: { ok: true } };
    } catch (error) {
      throw friendlyError(error);
    }
  }
);

// Replaces the form fields shown for one ticket type.
// Body: [{ fieldKey, label, isRequired, sortOrder }]
endpoint(
  "adminSaveTicketTypeFields",
  { methods: ["PUT"], route: "manage/ticket-type-fields/{typeId:int}", role: "admin", failMessage: "Could not save the form fields" },
  async (request) => {
    const typeId = Number(request.params.typeId);
    const body = await readJson(request);
    if (!Array.isArray(body)) throw new HttpError(400, "Send a list of fields");
    const seen = new Set();
    const fields = body.map((f, i) => {
      if (!FIELD_KEYS.includes(f.fieldKey)) throw new HttpError(400, `Unknown field ${f.fieldKey}`);
      if (seen.has(f.fieldKey)) throw new HttpError(400, `${f.fieldKey} is listed twice`);
      seen.add(f.fieldKey);
      const label = String(f.label || "").trim();
      if (!label || label.length > 100) throw new HttpError(400, "Each field needs a label of 100 characters or fewer");
      return { fieldKey: f.fieldKey, label, isRequired: !!f.isRequired, sortOrder: Number.isInteger(f.sortOrder) ? f.sortOrder : (i + 1) * 10 };
    });
    if (seen.has("subcategory") && !seen.has("category")) throw new HttpError(400, "Subcategory needs Category on the form too");

    await withTransaction(async (tx) => {
      const exists = await tx.request().input("Id", sql.Int, typeId).query("SELECT 1 AS x FROM dbo.TicketTypes WHERE Id = @Id");
      if (!exists.recordset.length) throw new HttpError(404, "Ticket type not found");
      await tx.request().input("Id", sql.Int, typeId).query("DELETE FROM dbo.TicketTypeFields WHERE TicketTypeId = @Id");
      for (const f of fields) {
        await tx
          .request()
          .input("TypeId", sql.Int, typeId)
          .input("FieldKey", sql.NVarChar(50), f.fieldKey)
          .input("Label", sql.NVarChar(100), f.label)
          .input("IsRequired", sql.Bit, f.isRequired)
          .input("SortOrder", sql.Int, f.sortOrder)
          .query(`
            INSERT INTO dbo.TicketTypeFields (TicketTypeId, FieldKey, Label, IsRequired, SortOrder)
            VALUES (@TypeId, @FieldKey, @Label, @IsRequired, @SortOrder)
          `);
      }
    });
    return { jsonBody: { ok: true } };
  }
);
