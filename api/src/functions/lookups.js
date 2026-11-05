const { endpoint, readJson, isUniqueViolation, isForeignKeyViolation } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { LOOKUPS, FIELD_KEYS, orderBy, columnList } = require("../shared/lookups");
const { getSettings } = require("../shared/settings");
const { logChange } = require("../shared/changelog");

// Everything the forms need in one call: the active rows of every lookup, which
// fields each ticket type (and category) shows, the status/priority ids the
// screens use, and the event booking guidelines.
// Prices are for technicians only, so everyone else gets the lists without
// costs.
const PRICE_COLUMNS = { inventoryItems: ["UnitCost"], software: ["CostPerSeat"] };

endpoint("getLookups", { methods: ["GET"], route: "lookups", open: true }, async (request, context, user) => {
  const pool = await getConnection();
  const lookups = {};
  for (const [key, def] of Object.entries(LOOKUPS)) {
    const result = await pool.request().query(`SELECT ${columnList(def)} FROM ${def.table} WHERE IsActive = 1 ORDER BY ${orderBy(def)}`);
    lookups[key] = result.recordset;
    if (!user.IsTechnician && PRICE_COLUMNS[key]) {
      for (const row of lookups[key]) for (const column of PRICE_COLUMNS[key]) delete row[column];
    }
  }
  const fields = await pool.request().query(`
    SELECT TicketTypeId, CategoryId, FieldKey, Label, IsRequired, SortOrder
    FROM dbo.TicketTypeFields
    ORDER BY TicketTypeId, SortOrder
  `);
  // Printers for the onboarding and low ink forms, and which cartridges
  // each one takes
  const printers = await pool.request().query(`
    SELECT Id, Name, Model, Location, DepartmentId FROM dbo.Printers
    WHERE IsActive = 1 AND IsDeleted = 0 ORDER BY Name
  `);
  const printerInk = await pool.request().query(`
    SELECT cp.PrinterId, c.Id AS InkCartridgeId, c.Name, c.Color
    FROM dbo.InkCartridgePrinters cp
    JOIN dbo.InkCartridges c ON c.Id = cp.InkCartridgeId
    WHERE c.IsActive = 1 AND c.IsDeleted = 0
    ORDER BY c.Name, c.Color
  `);
  const settings = await getSettings();
  return {
    jsonBody: {
      ...lookups,
      printers: printers.recordset,
      printerInk: printerInk.recordset,
      ticketTypeFields: fields.recordset,
      defaults: {
        newStatusId: settings.NewStatusId,
        awaitingStatusId: settings.AwaitingStatusId,
        closedStatusId: settings.ClosedStatusId,
        defaultPriorityId: settings.DefaultPriorityId,
        webSourceId: settings.WebSourceId,
        bookingPendingStatusId: settings.BookingPendingStatusId,
        bookingConfirmedStatusId: settings.BookingConfirmedStatusId,
        bookingDeclinedStatusId: settings.BookingDeclinedStatusId,
        bookingCancelledStatusId: settings.BookingCancelledStatusId,
        bookingTicketTypeId: settings.BookingTicketTypeId,
        staffUserTypeId: settings.StaffUserTypeId
      },
      // Which emails go out, so the screens can say what will happen
      email: {
        reply: settings.OutReply === "On",
        hrReply: settings.OutHrReply === "On",
        closed: settings.OutClosed === "On",
        survey: settings.OutSurvey === "On",
        maintenance: settings.MaintenanceMode === "On",
        maxAttachmentBytes: Math.floor(((settings.MaxEmailMB || 25) * 1024 * 1024) / 1.37)
      },
      eventGuidelines: settings.EventGuidelines || "",
      organization: {
        appName: settings.AppName || "Service Desk",
        organizationName: settings.OrganizationName || "",
        timeZone: settings.TimeZone || "America/New_York",
        mailboxAddress: settings.MailboxAddress || "",
        staffDomains: settings.StaffEmailDomains || ""
      }
    }
  };
});

// Admins edit every list; Event Managers also edit rooms and room statuses.
function getDef(request, user) {
  const def = LOOKUPS[request.params.table];
  if (!def) throw new HttpError(404, "Unknown list");
  if (!user.IsAdmin && !(def.eventManagers && user.IsEventManager)) throw new HttpError(403, "Only admins can do that");
  return def;
}

const display = (column, value) => {
  if (value === null || value === undefined || value === "") return "empty";
  if (column.type === "bit") return value ? "yes" : "no";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

// A plain sentence for the section's history, like "Renamed Phone to Phones".
function describeChange(def, before, values) {
  const name = before.Name || display({}, before.HolidayDate);
  const parts = [];
  for (const { column, value } of values) {
    const old = before[column.name];
    const same = column.type === "bit" ? !!old === !!value
      : column.type === "date" ? display(column, old) === display(column, value)
      : column.type === "decimal" || column.type === "int" || column.type === "ref" ? Number(old) === Number(value) && (old === null) === (value === null)
      : (old ?? null) === (value ?? null);
    if (same) continue;
    if (column.name === "Name") parts.push(`Renamed ${old} to ${value}`);
    else if (column.name === "IsActive") parts.push(`${value ? "Turned on" : "Turned off"} ${name}`);
    else if (column.name === "SortOrder") parts.push(`Moved ${name}`);
    else parts.push(`${name}: ${column.label} ${display(column, old)} to ${display(column, value)}`);
  }
  return parts.join("; ");
}

// Turns request values into typed SQL inputs, checking each against its column.
function readValues(def, body, isNew) {
  const values = [];
  for (const column of def.columns) {
    if (column.readOnly) continue;
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

endpoint("adminListLookup", { methods: ["GET"], route: "manage/lookups/{table}" }, async (request, context, user) => {
  const def = getDef(request, user);
  const pool = await getConnection();
  const result = await pool.request().query(`SELECT ${columnList(def)} FROM ${def.table} ORDER BY ${orderBy(def)}`);
  return { jsonBody: { label: def.label, columns: def.columns, rows: result.recordset } };
});

endpoint(
  "adminCreateLookup",
  { methods: ["POST"], route: "manage/lookups/{table}", failMessage: "Could not add the entry" },
  async (request, context, user) => {
    const def = getDef(request, user);
    if (def.noAdd) throw new HttpError(400, `${def.label} can be renamed but not added to`);
    const values = readValues(def, await readJson(request), true);
    try {
      const id = await withTransaction(async (tx) => {
        const result = await bind(tx.request(), values).query(`
          INSERT INTO ${def.table} (${values.map((v) => `[${v.column.name}]`).join(", ")})
          OUTPUT INSERTED.Id
          VALUES (${values.map((v, i) => `@v${i}`).join(", ")})
        `);
        const name = values.find((v) => v.column.name === "Name")?.value;
        const day = values.find((v) => v.column.name === "HolidayDate")?.value;
        await logChange(tx, { area: "settings", section: request.params.table, actorId: user.Id, summary: `Added ${[name, day].filter(Boolean).join(", ")}` });
        return result.recordset[0].Id;
      });
      return { status: 201, jsonBody: { Id: id } };
    } catch (error) {
      throw friendlyError(error);
    }
  }
);

endpoint(
  "adminUpdateLookup",
  { methods: ["PATCH"], route: "manage/lookups/{table}/{id:int}", failMessage: "Could not save the entry" },
  async (request, context, user) => {
    const def = getDef(request, user);
    const values = readValues(def, await readJson(request), false);
    if (!values.length) throw new HttpError(400, "Nothing to change");
    const id = Number(request.params.id);
    try {
      await withTransaction(async (tx) => {
        const found = await tx.request().input("Id", sql.Int, id).query(`SELECT ${columnList(def)} FROM ${def.table} WHERE Id = @Id`);
        const before = found.recordset[0];
        if (!before) throw new HttpError(404, "Entry not found");
        await bind(tx.request(), values)
          .input("Id", sql.Int, id)
          .query(`UPDATE ${def.table} SET ${values.map((v, i) => `[${v.column.name}] = @v${i}`).join(", ")} WHERE Id = @Id`);
        const summary = describeChange(def, before, values);
        // Reordering changes two rows; the history only needs the one moved
        if (summary && !(request.query.get("quiet") === "1")) {
          await logChange(tx, { area: "settings", section: request.params.table, actorId: user.Id, summary });
        }
      });
      return { jsonBody: { ok: true } };
    } catch (error) {
      throw friendlyError(error);
    }
  }
);

// Replaces the form fields shown for one ticket type, or with ?categoryId=
// for one of its categories (shown when that category is picked).
// Body: [{ fieldKey, label, isRequired, sortOrder }]
endpoint(
  "adminSaveTicketTypeFields",
  { methods: ["PUT"], route: "manage/ticket-type-fields/{typeId:int}", role: "admin", failMessage: "Could not save the form fields" },
  async (request, context, user) => {
    const typeId = Number(request.params.typeId);
    const categoryRaw = request.query.get("categoryId");
    const categoryId = categoryRaw ? Number(categoryRaw) : null;
    if (categoryRaw && !Number.isInteger(categoryId)) throw new HttpError(400, "Category must be a valid id");
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
    if (categoryId && (seen.has("category") || seen.has("subcategory"))) {
      throw new HttpError(400, "Category and Subcategory are set for the whole ticket type, not per category");
    }
    if (!categoryId && seen.has("subcategory") && !seen.has("category")) throw new HttpError(400, "Subcategory needs Category on the form too");

    await withTransaction(async (tx) => {
      const exists = await tx.request().input("Id", sql.Int, typeId).query("SELECT 1 AS x FROM dbo.TicketTypes WHERE Id = @Id");
      if (!exists.recordset.length) throw new HttpError(404, "Ticket type not found");
      if (categoryId) {
        const category = await tx.request().input("Id", sql.Int, categoryId).input("TypeId", sql.Int, typeId)
          .query("SELECT 1 AS x FROM dbo.Categories WHERE Id = @Id AND TicketTypeId = @TypeId");
        if (!category.recordset.length) throw new HttpError(400, "That category isn't under this ticket type");
      }
      const names = await tx.request().input("Id", sql.Int, typeId).input("CategoryId", sql.Int, categoryId).query(`
        SELECT t.Name AS TypeName, c.Name AS CategoryName FROM dbo.TicketTypes t
        LEFT JOIN dbo.Categories c ON c.Id = @CategoryId WHERE t.Id = @Id`);
      const { TypeName, CategoryName } = names.recordset[0];
      await logChange(tx, {
        area: "settings",
        section: "formFields",
        actorId: user.Id,
        summary: `Changed the ${TypeName}${CategoryName ? ` (${CategoryName})` : ""} form: ${fields.map((f) => `${f.label}${f.isRequired ? " (required)" : ""}`).join(", ") || "no extra fields"}`
      });
      await tx.request().input("Id", sql.Int, typeId).input("CategoryId", sql.Int, categoryId)
        .query("DELETE FROM dbo.TicketTypeFields WHERE TicketTypeId = @Id AND (CategoryId = @CategoryId OR (CategoryId IS NULL AND @CategoryId IS NULL))");
      for (const f of fields) {
        await tx
          .request()
          .input("TypeId", sql.Int, typeId)
          .input("CategoryId", sql.Int, categoryId)
          .input("FieldKey", sql.NVarChar(50), f.fieldKey)
          .input("Label", sql.NVarChar(100), f.label)
          .input("IsRequired", sql.Bit, f.isRequired)
          .input("SortOrder", sql.Int, f.sortOrder)
          .query(`
            INSERT INTO dbo.TicketTypeFields (TicketTypeId, CategoryId, FieldKey, Label, IsRequired, SortOrder)
            VALUES (@TypeId, @CategoryId, @FieldKey, @Label, @IsRequired, @SortOrder)
          `);
      }
    });
    return { jsonBody: { ok: true } };
  }
);
