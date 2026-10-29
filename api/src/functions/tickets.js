const {
  endpoint,
  readJson,
  readBodyWithFiles,
  optionalId,
  requiredId,
  optionalText,
  requiredText,
  optionalDate,
  emailList,
  isForeignKeyViolation
} = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { USER_SELECT } = require("../shared/auth");
const { saveAttachments, finishRichText, readInlineNames } = require("../shared/attachments");
const { hasContent } = require("../shared/richtext");
const { getAvailability, assertStock, assertTicketStock, assertSeats, readItems, addTicketItem } = require("../shared/inventory");
const { getHoldings } = require("../shared/holdings");
const { logChange } = require("../shared/changelog");
const {
  TICKET_SELECT,
  FOR_IT_SQL,
  ROOM_FIELDS,
  accessOf,
  forViewer,
  personName,
  formatNumber,
  loadTicket,
  loadVisibleTicket,
  getStatus,
  statusTimingSql,
  recordEvents,
  accountOnClose
} = require("../shared/tickets");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function one(db, query, inputs = {}) {
  const request = db.request();
  for (const [name, [type, value]] of Object.entries(inputs)) request.input(name, type, value);
  const result = await request.query(query);
  return result.recordset[0];
}

function readIdList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${field} must be a list`);
  return [...new Set(value.map((v) => requiredId(v, field)))];
}

// links.isRemoval marks a line that takes something back (collect equipment,
// remove a license) rather than hands it out.
async function addChecklistItem(db, ticketId, sortOrder, label, links = {}) {
  await db
    .request()
    .input("TicketId", sql.Int, ticketId)
    .input("Label", sql.NVarChar(255), label.slice(0, 255))
    .input("IsRemoval", sql.Bit, !!links.isRemoval)
    .input("InventoryItemId", sql.Int, links.inventoryItemId || null)
    .input("SoftwareId", sql.Int, links.softwareId || null)
    .input("LicenseAssignmentId", sql.Int, links.licenseAssignmentId || null)
    .input("TicketItemId", sql.Int, links.ticketItemId || null)
    .input("SortOrder", sql.Int, sortOrder)
    .query(`
      INSERT INTO dbo.ChecklistItems (TicketId, Label, InventoryItemId, SoftwareId, LicenseAssignmentId, TicketItemId, SortOrder, IsRemoval)
      VALUES (@TicketId, @Label, @InventoryItemId, @SoftwareId, @LicenseAssignmentId, @TicketItemId, @SortOrder, @IsRemoval)
    `);
}

async function softwareNames(db, ids) {
  const names = new Map();
  for (const id of ids) {
    const row = await one(db, "SELECT Name FROM dbo.Software WHERE Id = @Id AND IsActive = 1", { Id: [sql.Int, id] });
    if (!row) throw new HttpError(400, "That software doesn't exist");
    names.set(id, row.Name);
  }
  return names;
}

const removeSeatLabel = (seat) => `Remove license: ${seat.Name}`;
const collectLabel = (item) => `Collect: ${item.Name}${item.Quantity > 1 ? ` (x${item.Quantity})` : ""}`;

// Adds removal lines for what the person holds. With "only", just the seats
// and items picked on the form (Access & Equipment Change); without it,
// everything (Off Boarding).
async function addRemovalChecklist(db, ticketId, personId, order, only) {
  const holdings = await getHoldings(db, personId);
  const seats = only ? holdings.seats.filter((s) => only.seatIds.includes(s.Id)) : holdings.seats;
  const items = only ? holdings.items.filter((i) => only.ticketItemIds.includes(i.Id)) : holdings.items;
  if (only && seats.length + items.length < only.seatIds.length + only.ticketItemIds.length) {
    throw new HttpError(400, "Something picked to remove isn't held by that person any more");
  }
  for (const seat of seats) {
    await addChecklistItem(db, ticketId, order, removeSeatLabel(seat), { licenseAssignmentId: seat.Id, isRemoval: true });
    order += 10;
  }
  for (const item of items) {
    await addChecklistItem(db, ticketId, order, collectLabel(item), { ticketItemId: item.Id, inventoryItemId: item.InventoryItemId, isRemoval: true });
    order += 10;
  }
  return order;
}

// Body "removals": { seatIds: [...], ticketItemIds: [...] }
function readRemovals(value) {
  if (value === undefined || value === null) return { seatIds: [], ticketItemIds: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Removals must be an object");
  return { seatIds: readIdList(value.seatIds, "License"), ticketItemIds: readIdList(value.ticketItemIds, "Item") };
}

// Technicians, or the person themselves, can see what someone holds (for the
// "to remove" list on an Access & Equipment Change).
endpoint("personHoldings", { methods: ["GET"], route: "people/{id:int}/holdings" }, async (request, context, user) => {
  const id = Number(request.params.id);
  if (!user.IsTechnician && id !== user.Id) throw new HttpError(403, "Only technicians can see what someone else holds");
  const pool = await getConnection();
  return { jsonBody: await getHoldings(pool, id) };
});

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

// ?scope=mine|queue  ?state=open|closed|all  ?statusId  ?technicianId=me|none|<id>
// ?ticketTypeId  ?priorityId  ?search
endpoint("listTickets", { methods: ["GET"], route: "tickets" }, async (request, context, user) => {
  const q = request.query;
  const scope = user.IsTechnician && q.get("scope") === "queue" ? "queue" : "mine";
  const where = [];
  const pool = await getConnection();
  const req = pool.request();

  if (scope === "mine") {
    where.push("(t.RequesterId = @Me OR t.ForUserId = @Me)");
  } else {
    where.push(FOR_IT_SQL);
  }
  req.input("Me", sql.Int, user.Id);

  const state = q.get("state") || "open";
  if (state === "open") where.push("s.IsClosed = 0");
  if (state === "closed") where.push("s.IsClosed = 1");

  const statusId = optionalId(q.get("statusId"), "Status");
  if (statusId) {
    where.push("t.StatusId = @StatusId");
    req.input("StatusId", sql.Int, statusId);
  }
  const technician = q.get("technicianId");
  if (technician === "me") where.push("t.TechnicianId = @Me");
  else if (technician === "none") where.push("t.TechnicianId IS NULL");
  else if (technician) {
    where.push("t.TechnicianId = @TechnicianId");
    req.input("TechnicianId", sql.Int, requiredId(technician, "Technician"));
  }
  const typeId = optionalId(q.get("ticketTypeId"), "Ticket type");
  if (typeId) {
    where.push("t.TicketTypeId = @TypeId");
    req.input("TypeId", sql.Int, typeId);
  }
  const priorityId = optionalId(q.get("priorityId"), "Priority");
  if (priorityId) {
    where.push("t.PriorityId = @PriorityId");
    req.input("PriorityId", sql.Int, priorityId);
  }
  const search = (q.get("search") || "").trim().slice(0, 100);
  if (search) {
    const number = /^\d+$/.test(search) ? Number(search) : null;
    where.push(`(t.Subject LIKE @Search OR r.Email LIKE @Search OR ${personName("r")} LIKE @Search${number ? " OR t.Id = @Number" : ""})`);
    req.input("Search", sql.NVarChar(110), `%${search.replace(/[%_[]/g, "[$&]")}%`);
    if (number) req.input("Number", sql.Int, number);
  }

  const result = await req.query(`
    SELECT TOP (500) * FROM (${TICKET_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}) x
    ORDER BY x.IsClosed, x.CreatedAt DESC
  `);
  return { jsonBody: result.recordset.map(({ Description, ...t }) => forViewer(t, user)) };
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

endpoint(
  "createTicket",
  { methods: ["POST"], route: "tickets", failMessage: "Could not create the ticket" },
  async (request, context, user) => {
    const { data, files } = await readBodyWithFiles(request);
    const settings = await getSettings();
    const pool = await getConnection();

    const typeId = requiredId(data.ticketTypeId, "Ticket type");
    const type = await one(pool, "SELECT * FROM dbo.TicketTypes WHERE Id = @Id AND IsActive = 1", { Id: [sql.Int, typeId] });
    if (!type) throw new HttpError(400, "Pick a ticket type");
    const fieldsFor = async (categoryId) => {
      const rows = await pool.request().input("Id", sql.Int, typeId).input("CategoryId", sql.Int, categoryId).query(`
        SELECT FieldKey, Label, IsRequired FROM dbo.TicketTypeFields
        WHERE TicketTypeId = @Id AND (CategoryId IS NULL OR CategoryId = @CategoryId)
      `);
      return new Map(rows.recordset.map((f) => [f.FieldKey, f]));
    };
    // Type-level fields first; the category's own fields join once it's known
    let fields = await fieldsFor(null);
    const shown = (key) => fields.has(key);
    const need = (key, value) => {
      const f = fields.get(key);
      const empty = value === null || value === undefined || (Array.isArray(value) && !value.length);
      if (f && f.IsRequired && empty) throw new HttpError(400, `${f.Label} is required`);
      return value;
    };

    const subject = requiredText(data.subject, "Subject", 255);
    const draft = typeof data.description === "string" ? data.description : "";
    if (!hasContent(draft)) throw new HttpError(400, "Description is required");
    if (draft.length > 200000) throw new HttpError(400, "The description is too long");
    const inlineNames = readInlineNames(data.inline);
    const priorityId = optionalId(data.priorityId, "Priority") || settings.DefaultPriorityId;
    const cc = emailList(data.cc, "CC");

    const categoryId = shown("category") ? need("category", optionalId(data.categoryId, "Category")) : null;
    let category = null;
    if (categoryId) {
      category = await one(pool, "SELECT Id, Name, ChecklistSource FROM dbo.Categories WHERE Id = @Id AND TicketTypeId = @TypeId AND IsActive = 1", {
        Id: [sql.Int, categoryId],
        TypeId: [sql.Int, typeId]
      });
      if (!category) throw new HttpError(400, "That category isn't under the chosen ticket type");
      fields = await fieldsFor(categoryId);
    }
    const checklistSource = category?.ChecklistSource || null;
    const subcategoryId = shown("subcategory") ? need("subcategory", optionalId(data.subcategoryId, "Subcategory")) : null;
    if (subcategoryId) {
      const sub = await one(pool, "SELECT CategoryId FROM dbo.Subcategories WHERE Id = @Id", { Id: [sql.Int, subcategoryId] });
      if (!sub || sub.CategoryId !== categoryId) throw new HttpError(400, "That subcategory isn't under the chosen category");
    }
    const startDate = shown("startDate") ? need("startDate", optionalDate(data.startDate, "Start date")) : null;
    const endDate = shown("endDate") ? need("endDate", optionalDate(data.endDate, "End date")) : null;
    if (startDate && endDate && endDate < startDate) throw new HttpError(400, "The end date is before the start date");
    // Onboarding someone who already has an account (coming back after off
    // boarding) links the ticket to them, so closing it turns the account on.
    const rehire = checklistSource === "onboarding" && user.IsTechnician && !shown("forUser");
    const forUserId = shown("forUser") ? need("forUser", optionalId(data.forUserId, "Person"))
      : rehire ? optionalId(data.forUserId, "Person") : null;
    const forPersonName = shown("newHire") ? need("newHire", optionalText(data.newHireName, "New hire", 200)) : null;
    const forDepartmentId = shown("newHire") ? optionalId(data.newHireDepartmentId, "Department") : null;

    // Onboarding always shows the equipment and license pick list
    const onboarding = checklistSource === "onboarding";
    const items = shown("items") || onboarding ? need("items", readItems(data.items)) : [];
    const softwareIds = shown("software") || onboarding ? need("software", readIdList(data.softwareIds, "Software")) : [];
    const removals = shown("removals") ? readRemovals(data.removals) : { seatIds: [], ticketItemIds: [] };
    if (removals.seatIds.length + removals.ticketItemIds.length) {
      if (!forUserId) throw new HttpError(400, "Pick who the equipment or software is being removed from");
      if (!user.IsTechnician && forUserId !== user.Id) throw new HttpError(403, "Only technicians can pick what to remove from someone else");
    }
    if (fields.get("removals")?.IsRequired && !removals.seatIds.length && !removals.ticketItemIds.length) {
      throw new HttpError(400, `${fields.get("removals").Label} is required`);
    }

    // Technicians can log a ticket for someone else and say how it came in
    let requesterId = user.Id;
    let sourceId = settings.WebSourceId;
    let technicianId = null;
    if (user.IsTechnician) {
      requesterId = optionalId(data.requesterId, "Requester") || user.Id;
      sourceId = optionalId(data.sourceId, "Source") || settings.WebSourceId;
      technicianId = optionalId(data.technicianId, "Technician");
    }
    const requester = await one(pool, "SELECT Id, DepartmentId, IsActive FROM dbo.Users WHERE Id = @Id", { Id: [sql.Int, requesterId] });
    if (!requester || !requester.IsActive) throw new HttpError(400, "That requester doesn't exist");
    if (checklistSource === "offboarding" && !forUserId) throw new HttpError(400, "Pick who is leaving");

    const warnings = [];
    const statusId = technicianId && settings.AssignedStatusId ? settings.AssignedStatusId : settings.NewStatusId;

    let ticketId;
    try {
      ticketId = await withTransaction(async (tx) => {
        const created = await one(
          tx,
          `INSERT INTO dbo.Tickets
             (TicketTypeId, StatusId, PriorityId, CategoryId, SubcategoryId, SourceId, RequesterId, ForUserId,
              ForPersonName, ForDepartmentId, TechnicianId, DepartmentId, Subject, Description, StartDate, EndDate)
           OUTPUT INSERTED.Id
           VALUES
             (@TypeId, @StatusId, @PriorityId, @CategoryId, @SubcategoryId, @SourceId, @RequesterId, @ForUserId,
              @ForPersonName, @ForDepartmentId, @TechnicianId, @DepartmentId, @Subject, @Description, @StartDate, @EndDate)`,
          {
            TypeId: [sql.Int, typeId],
            StatusId: [sql.Int, statusId],
            PriorityId: [sql.Int, priorityId],
            CategoryId: [sql.Int, categoryId],
            SubcategoryId: [sql.Int, subcategoryId],
            SourceId: [sql.Int, sourceId],
            RequesterId: [sql.Int, requesterId],
            ForUserId: [sql.Int, forUserId],
            ForPersonName: [sql.NVarChar(200), forPersonName],
            ForDepartmentId: [sql.Int, forDepartmentId],
            TechnicianId: [sql.Int, technicianId],
            DepartmentId: [sql.Int, requester.DepartmentId],
            Subject: [sql.NVarChar(255), subject],
            Description: [sql.NVarChar(sql.MAX), ""],
            StartDate: [sql.Date, startDate],
            EndDate: [sql.Date, endDate]
          }
        );
        const id = created.Id;

        for (const email of cc) {
          await tx.request().input("TicketId", sql.Int, id).input("Email", sql.NVarChar(320), email)
            .query("INSERT INTO dbo.TicketCc (TicketId, Email) VALUES (@TicketId, @Email)");
        }

        // Equipment, and the checklist for types that use one
        let order = 10;
        for (const item of items) {
          const added = await addTicketItem(tx, id, item.inventoryItemId, item.quantity);
          if (type.UsesChecklist) {
            const label = `Hand out: ${added.name}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`;
            await addChecklistItem(tx, id, order, label, { ticketItemId: added.id, inventoryItemId: item.inventoryItemId });
            order += 10;
          }
        }
        if (type.UsesChecklist) {
          const names = await softwareNames(tx, softwareIds);
          for (const softwareId of softwareIds) {
            await addChecklistItem(tx, id, order, `Grant access: ${names.get(softwareId)}`, { softwareId });
            order += 10;
          }
        }
        if (type.UsesChecklist && checklistSource === "offboarding") await addRemovalChecklist(tx, id, forUserId, order);
        else if (type.UsesChecklist && forUserId) await addRemovalChecklist(tx, id, forUserId, order, removals);

        const saved = await saveAttachments(tx, id, null, files, user.Id, inlineNames);
        const description = await finishRichText(tx, id, draft, saved);
        if (!description) throw new HttpError(400, "Description is required");
        await tx.request().input("Id", sql.Int, id).input("Description", sql.NVarChar(sql.MAX), description)
          .query("UPDATE dbo.Tickets SET Description = @Description WHERE Id = @Id");
        await recordEvents(tx, id, user.Id, [{ field: "Created", oldValue: null, newValue: type.Name }]);
        if (forUserId) {
          await logChange(tx, {
            area: "person",
            entityId: forUserId,
            actorId: user.Id,
            summary: `Request ${formatNumber(id)} started: ${category?.Name || type.Name}`
          });
        }
        return id;
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new HttpError(400, "One of the choices on the form no longer exists");
      throw error;
    }

    // Outgoing email ("ticket received", IT team notice) comes with the email
    // step of the build; see the README.
    const ticket = await loadTicket(pool, ticketId);
    return { status: 201, jsonBody: { ticket: forViewer(ticket, user), warnings } };
  }
);

// ---------------------------------------------------------------------------
// Read one
// ---------------------------------------------------------------------------

endpoint("getTicket", { methods: ["GET"], route: "tickets/{id:int}" }, async (request, context, user) => {
  const pool = await getConnection();
  const ticket = await loadVisibleTicket(pool, Number(request.params.id), user);
  const id = ticket.Id;
  const tech = user.IsTechnician;
  const access = accessOf(user, ticket);
  // Notes this person may read: technicians all of them, HR their own kind
  const notes = access.technicianNotes ? "" : access.hrNotes ? "AND (c.IsTechnicianNote = 0 OR c.VisibleToEventManagers = 1)" : "AND c.IsTechnicianNote = 0";

  const conversations = await pool.request().input("Id", sql.Int, id).query(`
    SELECT c.Id, c.AuthorId, ${personName("u")} AS AuthorName, u.Email AS AuthorEmail,
           c.Body, c.IsTechnicianNote, c.VisibleToEventManagers, c.Direction, c.CreatedAt
    FROM dbo.TicketConversations c
    JOIN dbo.Users u ON u.Id = c.AuthorId
    WHERE c.TicketId = @Id ${notes}
    ORDER BY c.CreatedAt, c.Id
  `);
  const attachments = await pool.request().input("Id", sql.Int, id).query(`
    SELECT a.Id, a.ConversationId, a.FileName, a.ContentType, a.SizeBytes, a.CreatedAt
    FROM dbo.Attachments a
    LEFT JOIN dbo.TicketConversations c ON c.Id = a.ConversationId
    WHERE a.TicketId = @Id AND a.IsInline = 0 AND (c.Id IS NULL OR (1 = 1 ${notes}))
    ORDER BY a.CreatedAt, a.Id
  `);
  const cc = await pool.request().input("Id", sql.Int, id).query("SELECT Email FROM dbo.TicketCc WHERE TicketId = @Id ORDER BY Email");
  const items = access.equipment
    ? (await pool.request().input("Id", sql.Int, id).query(`
        SELECT ti.Id, ti.InventoryItemId, i.Name, ti.Quantity,
               ${tech ? "ti.UnitCostAtTime, ti.Quantity * ti.UnitCostAtTime AS TotalCost," : ""} ti.OutAt, ti.ReturnedAt
        FROM dbo.TicketItems ti
        JOIN dbo.InventoryItems i ON i.Id = ti.InventoryItemId
        WHERE ti.TicketId = @Id
        ORDER BY i.Name
      `)).recordset
    : [];
  const checklist = access.equipment
    ? (await pool.request().input("Id", sql.Int, id).query(`
        SELECT ci.Id, ci.Label, ci.IsDone, ci.IsRemoval, ci.DoneAt, ${personName("u")} AS DoneByName, ci.SortOrder
        FROM dbo.ChecklistItems ci
        LEFT JOIN dbo.Users u ON u.Id = ci.DoneById
        WHERE ci.TicketId = @Id
        ORDER BY ci.SortOrder, ci.Id
      `)).recordset
    : [];
  // Technicians see the whole history; HR the lines about the room and event
  let events = [];
  if (tech || access.roomOnlyView) {
    const req = pool.request().input("Id", sql.Int, id);
    const only = tech ? "" : `AND e.Field IN (${ROOM_FIELDS.map((f, i) => { req.input(`F${i}`, sql.NVarChar(50), f); return `@F${i}`; }).join(", ")})`;
    events = (await req.query(`
      SELECT e.Id, e.Field, e.OldValue, e.NewValue, e.[At], CASE WHEN u.Id IS NOT NULL THEN ${personName("u")} END AS ActorName
      FROM dbo.TicketEvents e
      LEFT JOIN dbo.Users u ON u.Id = e.ActorId
      WHERE e.TicketId = @Id ${only}
      ORDER BY e.[At], e.Id
    `)).recordset;
  }
  // Another active booking for the same room at an overlapping time: a hint
  // for HR, who decide
  let hasOverlap = false;
  if (ticket.HasRoom && ticket.IsActiveBooking && user.IsEventManager) {
    const overlap = await pool.request().input("Id", sql.Int, id).query(`
      SELECT TOP (1) 1 AS X
      FROM dbo.TicketRooms me
      JOIN dbo.Tickets mt ON mt.Id = me.TicketId
      JOIN dbo.TicketRooms o ON o.RoomId = me.RoomId AND o.TicketId <> me.TicketId
      JOIN dbo.BookingStatuses os ON os.Id = o.BookingStatusId AND os.IsActiveBooking = 1
      JOIN dbo.Tickets ot ON ot.Id = o.TicketId
      WHERE me.TicketId = @Id AND ot.StartAt < mt.EndAt AND ot.EndAt > mt.StartAt
    `);
    hasOverlap = overlap.recordset.length > 0;
  }

  return {
    jsonBody: {
      ticket: { ...forViewer(ticket, user), HasOverlap: hasOverlap },
      access: {
        equipment: access.equipment,
        technicianNotes: access.technicianNotes,
        hrNotes: access.hrNotes,
        roomOnlyView: access.roomOnlyView,
        canDecideRoom: !!user.IsAdmin || (!!user.IsEventManager && !user.IsTechnician)
      },
      conversations: conversations.recordset,
      attachments: attachments.recordset,
      cc: cc.recordset.map((r) => r.Email),
      items,
      checklist,
      events
    }
  };
});

// ---------------------------------------------------------------------------
// Update (technicians)
// ---------------------------------------------------------------------------

const EDITABLE = [
  // [body key, column, sql type, read, event label, name lookup table]
  ["statusId", "StatusId", sql.Int, (v) => requiredId(v, "Status"), "Status", "dbo.Statuses"],
  ["priorityId", "PriorityId", sql.Int, (v) => requiredId(v, "Priority"), "Priority", "dbo.Priorities"],
  ["ticketTypeId", "TicketTypeId", sql.Int, (v) => requiredId(v, "Ticket type"), "Type", "dbo.TicketTypes"],
  ["sourceId", "SourceId", sql.Int, (v) => requiredId(v, "Source"), "Source", "dbo.Sources"],
  ["categoryId", "CategoryId", sql.Int, (v) => optionalId(v, "Category"), "Category", "dbo.Categories"],
  ["subcategoryId", "SubcategoryId", sql.Int, (v) => optionalId(v, "Subcategory"), "Subcategory", "dbo.Subcategories"],
  ["departmentId", "DepartmentId", sql.Int, (v) => optionalId(v, "Department"), "Department", "dbo.Departments"],
  ["technicianId", "TechnicianId", sql.Int, (v) => optionalId(v, "Technician"), "Assigned To", "users"],
  ["forUserId", "ForUserId", sql.Int, (v) => optionalId(v, "Person"), "For", "users"],
  ["subject", "Subject", sql.NVarChar(255), (v) => requiredText(v, "Subject", 255), "Subject"],
  ["startDate", "StartDate", sql.Date, (v) => optionalDate(v, "Start date"), "Start date"],
  ["endDate", "EndDate", sql.Date, (v) => optionalDate(v, "End date"), "End date"]
];

async function nameOf(db, table, id) {
  if (id === null || id === undefined) return null;
  if (table === "users") {
    const row = await one(db, `SELECT ${personName("u")} AS Name, u.IsActive FROM dbo.Users u WHERE u.Id = @Id`, { Id: [sql.Int, id] });
    if (!row) throw new HttpError(400, "That person doesn't exist");
    return row.Name;
  }
  const row = await one(db, `SELECT Name FROM ${table} WHERE Id = @Id`, { Id: [sql.Int, id] });
  if (!row) throw new HttpError(400, "One of the choices no longer exists");
  return row.Name;
}

endpoint(
  "updateTicket",
  { methods: ["PATCH"], route: "tickets/{id:int}", role: "technician", failMessage: "Could not save the ticket" },
  async (request, context, user) => {
    const body = await readJson(request);
    const settings = await getSettings();
    const id = Number(request.params.id);

    const warnings = [];
    await withTransaction(async (tx) => {
      const ticket = await loadTicket(tx, id);
      if (!ticket) throw new HttpError(404, "Ticket not found");

      const changes = {};
      for (const [key, column, type, read, label, table] of EDITABLE) {
        if (!(key in body)) continue;
        const value = read(body[key]);
        const old = ticket[column] instanceof Date ? ticket[column].toISOString().slice(0, 10) : ticket[column];
        if (value === old) continue;
        changes[column] = { type, value, label, table, old };
      }
      // Giving a New ticket a technician moves it to Assigned
      if (changes.TechnicianId?.value && !changes.StatusId && ticket.StatusId === settings.NewStatusId && settings.AssignedStatusId) {
        changes.StatusId = { type: sql.Int, value: settings.AssignedStatusId, label: "Status", table: "dbo.Statuses", old: ticket.StatusId };
      }
      if (changes.TechnicianId?.value) {
        const tech = await one(tx, `${USER_SELECT} WHERE u.Id = @Id`, { Id: [sql.Int, changes.TechnicianId.value] });
        if (!tech || !tech.IsTechnician) throw new HttpError(400, "Tickets can only be assigned to technicians");
      }
      const finalSub = "SubcategoryId" in changes ? changes.SubcategoryId.value : ticket.SubcategoryId;
      const finalCategory = "CategoryId" in changes ? changes.CategoryId.value : ticket.CategoryId;
      const finalType = "TicketTypeId" in changes ? changes.TicketTypeId.value : ticket.TicketTypeId;
      if (finalCategory && ("CategoryId" in changes || "TicketTypeId" in changes)) {
        const category = await one(tx, "SELECT TicketTypeId FROM dbo.Categories WHERE Id = @Id", { Id: [sql.Int, finalCategory] });
        if (!category || category.TicketTypeId !== finalType) throw new HttpError(400, "That category isn't under the ticket's type");
      }
      if (finalSub) {
        const sub = await one(tx, "SELECT CategoryId FROM dbo.Subcategories WHERE Id = @Id", { Id: [sql.Int, finalSub] });
        if (!sub || sub.CategoryId !== finalCategory) throw new HttpError(400, "That subcategory isn't under the ticket's category");
      }
      const columns = Object.keys(changes);
      if (!columns.length) return;

      const sets = columns.map((c) => `${c} = @${c}`);
      if (changes.StatusId) sets.push(statusTimingSql(await getStatus(tx, changes.StatusId.value)));
      const req = tx.request().input("Id", sql.Int, id);
      for (const c of columns) req.input(c, changes[c].type, changes[c].value);
      await req.query(`UPDATE dbo.Tickets SET ${sets.join(", ")}, UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id`);

      const events = [];
      for (const c of columns) {
        const { label, table, old, value } = changes[c];
        events.push({
          field: label,
          oldValue: table ? await nameOf(tx, table, old) : old,
          newValue: table ? await nameOf(tx, table, value) : value
        });
      }
      await recordEvents(tx, id, user.Id, events);
      // New dates, or reopening, can need equipment that's already taken.
      const reopened = changes.StatusId && ticket.IsClosed && !(await getStatus(tx, changes.StatusId.value)).IsClosed;
      if (changes.StartDate || changes.EndDate || reopened) await assertTicketStock(tx, id);
      if (changes.StatusId) await accountOnClose(tx, ticket, await getStatus(tx, changes.StatusId.value), user.Id, warnings);
    });

    // The survey email on close comes with the email step of the build.
    const pool = await getConnection();
    return { jsonBody: { ticket: forViewer(await loadTicket(pool, id), user), warnings } };
  }
);

// ---------------------------------------------------------------------------
// Equipment on a ticket (technicians)
// ---------------------------------------------------------------------------

endpoint("inventoryAvailability", { methods: ["GET"], route: "inventory/availability" }, async (request, context, user) => {
  const pool = await getConnection();
  const rows = await getAvailability(pool, {
    startDate: optionalDate(request.query.get("startDate"), "Start date"),
    endDate: optionalDate(request.query.get("endDate"), "End date"),
    excludeTicketId: optionalId(request.query.get("excludeTicketId"), "Ticket")
  });
  // Prices are for technicians only.
  if (!user.IsTechnician) for (const row of rows) delete row.UnitCost;
  return { jsonBody: rows };
});

endpoint(
  "addTicketItem",
  { methods: ["POST"], route: "tickets/{id:int}/items", role: "technician", failMessage: "Could not add the item" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const [item] = readItems([await readJson(request)]);
    const pool = await getConnection();
    const ticket = await loadTicket(pool, id);
    if (!ticket) throw new HttpError(404, "Ticket not found");
    const warnings = [];
    await withTransaction(async (tx) => {
      const added = await addTicketItem(tx, id, item.inventoryItemId, item.quantity);
      await recordEvents(tx, id, user.Id, [{ field: "Item added", newValue: `${added.name} x${item.quantity}` }]);
    });
    return { status: 201, jsonBody: { warnings } };
  }
);

// Body: { out: true|false } and/or { returned: true|false }
endpoint(
  "updateTicketItem",
  { methods: ["PATCH"], route: "tickets/{id:int}/items/{itemId:int}", role: "technician", failMessage: "Could not save the item" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const itemId = Number(request.params.itemId);
    const body = await readJson(request);
    const sets = [];
    if ("out" in body) sets.push(body.out ? "OutAt = COALESCE(OutAt, SYSUTCDATETIME())" : "OutAt = NULL");
    if ("returned" in body) sets.push(body.returned ? "ReturnedAt = COALESCE(ReturnedAt, SYSUTCDATETIME())" : "ReturnedAt = NULL");
    if (!sets.length) throw new HttpError(400, "Nothing to change");
    await withTransaction(async (tx) => {
      const item = await one(tx, `
        SELECT i.Name, ti.InventoryItemId FROM dbo.TicketItems ti JOIN dbo.InventoryItems i ON i.Id = ti.InventoryItemId
        WHERE ti.Id = @ItemId AND ti.TicketId = @Id`, { Id: [sql.Int, id], ItemId: [sql.Int, itemId] });
      if (!item) throw new HttpError(404, "Item not found on this ticket");
      await tx.request().input("ItemId", sql.Int, itemId).query(`UPDATE dbo.TicketItems SET ${sets.join(", ")} WHERE Id = @ItemId`);
      if (body.out || body.returned === false) await assertStock(tx, [item.InventoryItemId]);
      const events = [];
      if ("out" in body) events.push({ field: body.out ? "Item handed out" : "Item not handed out", newValue: item.Name });
      if ("returned" in body) events.push({ field: body.returned ? "Item returned" : "Item not returned", newValue: item.Name });
      await recordEvents(tx, id, user.Id, events);
    });
    return { jsonBody: { ok: true } };
  }
);

// ---------------------------------------------------------------------------
// Checklist (technicians)
// Ticking an item does the work it describes: hands out or collects
// equipment, assigns or frees a license seat. Unticking undoes it.
// ---------------------------------------------------------------------------

// Adds a line to a ticket's checklist, for what the form didn't cover.
// Body, one of: { inventoryItemId, quantity } hand out equipment to keep,
// { softwareId } grant a license, { seatId } remove a license the person
// holds, { ticketItemId } collect equipment the person holds.
endpoint(
  "addChecklistItem",
  { methods: ["POST"], route: "tickets/{id:int}/checklist", role: "technician", failMessage: "Could not add the checklist line" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    await withTransaction(async (tx) => {
      const ticket = await loadTicket(tx, id);
      if (!ticket) throw new HttpError(404, "Ticket not found");
      if (!ticket.UsesChecklist) throw new HttpError(400, "This ticket type doesn't use a checklist");
      const last = await one(tx, "SELECT MAX(SortOrder) AS M FROM dbo.ChecklistItems WHERE TicketId = @Id", { Id: [sql.Int, id] });
      const order = (last?.M || 0) + 10;
      const personId = ticket.ForUserId || (ticket.ForPersonName ? null : ticket.RequesterId);
      let label;
      if (body.inventoryItemId) {
        const [item] = readItems([body]);
        const added = await addTicketItem(tx, id, item.inventoryItemId, item.quantity);
        label = `Hand out: ${added.name}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`;
        await addChecklistItem(tx, id, order, label, { ticketItemId: added.id, inventoryItemId: item.inventoryItemId });
      } else if (body.softwareId) {
        const softwareId = requiredId(body.softwareId, "Software");
        const names = await softwareNames(tx, [softwareId]);
        label = `Grant access: ${names.get(softwareId)}`;
        await addChecklistItem(tx, id, order, label, { softwareId });
      } else if (body.seatId || body.ticketItemId) {
        if (!personId) throw new HttpError(400, "Link the ticket to the person (the For field) first");
        const only = { seatIds: body.seatId ? [requiredId(body.seatId, "License")] : [], ticketItemIds: body.ticketItemId ? [requiredId(body.ticketItemId, "Item")] : [] };
        const holdings = await getHoldings(tx, personId);
        const seat = holdings.seats.find((s) => only.seatIds.includes(s.Id));
        const held = holdings.items.find((i) => only.ticketItemIds.includes(i.Id));
        label = seat ? removeSeatLabel(seat) : held ? collectLabel(held) : null;
        await addRemovalChecklist(tx, id, personId, order, only);
      } else {
        throw new HttpError(400, "Say what the line is for");
      }
      await recordEvents(tx, id, user.Id, [{ field: "Checklist line added", newValue: label }]);
    });
    return { status: 201, jsonBody: { ok: true } };
  }
);

endpoint(
  "updateChecklistItem",
  { methods: ["PATCH"], route: "tickets/{id:int}/checklist/{itemId:int}", role: "technician", failMessage: "Could not save the checklist" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const itemId = Number(request.params.itemId);
    const done = !!(await readJson(request)).isDone;

    await withTransaction(async (tx) => {
      const ticket = await loadTicket(tx, id);
      if (!ticket) throw new HttpError(404, "Ticket not found");
      const item = await one(tx, "SELECT * FROM dbo.ChecklistItems WHERE Id = @ItemId AND TicketId = @Id", {
        Id: [sql.Int, id],
        ItemId: [sql.Int, itemId]
      });
      if (!item) throw new HttpError(404, "Checklist item not found");
      if (item.IsDone === done) return;
      const leaving = item.IsRemoval;
      const now = done ? "SYSUTCDATETIME()" : "NULL";

      if (item.TicketItemId) {
        const column = leaving ? "ReturnedAt" : "OutAt";
        await tx.request().input("TicketItemId", sql.Int, item.TicketItemId)
          .query(`UPDATE dbo.TicketItems SET ${column} = ${now} WHERE Id = @TicketItemId`);
        // Un-collecting, or handing out on a closed ticket, puts it back in use
        if (leaving !== done) {
          const line = await one(tx, "SELECT InventoryItemId FROM dbo.TicketItems WHERE Id = @Id", { Id: [sql.Int, item.TicketItemId] });
          await assertStock(tx, [line?.InventoryItemId]);
        }
      }

      if (leaving && item.LicenseAssignmentId) {
        await tx.request()
          .input("SeatId", sql.Int, item.LicenseAssignmentId)
          .input("TicketId", sql.Int, done ? id : null)
          .query(`UPDATE dbo.LicenseAssignments SET RemovedAt = ${now}, RemovedTicketId = @TicketId WHERE Id = @SeatId`);
        if (!done) {
          const seat = await one(tx, "SELECT SoftwareId FROM dbo.LicenseAssignments WHERE Id = @Id", { Id: [sql.Int, item.LicenseAssignmentId] });
          await assertSeats(tx, [seat?.SoftwareId]);
        }
      }

      let seatId = item.LicenseAssignmentId;
      if (!leaving && item.SoftwareId) {
        if (done) {
          const personId = ticket.ForUserId || (ticket.ForPersonName ? null : ticket.RequesterId);
          if (!personId) throw new HttpError(400, "Link the new hire to their account (the For field) before granting licenses");
          const seat = await one(tx, `
            INSERT INTO dbo.LicenseAssignments (UserId, SoftwareId, CostPerSeatAtTime, AssignedTicketId)
            OUTPUT INSERTED.Id
            SELECT @UserId, Id, CostPerSeat, @TicketId FROM dbo.Software WHERE Id = @SoftwareId`, {
            UserId: [sql.Int, personId],
            SoftwareId: [sql.Int, item.SoftwareId],
            TicketId: [sql.Int, id]
          });
          seatId = seat.Id;
          await assertSeats(tx, [item.SoftwareId]);
        } else if (item.LicenseAssignmentId) {
          await tx.request().input("ItemId", sql.Int, itemId).query("UPDATE dbo.ChecklistItems SET LicenseAssignmentId = NULL WHERE Id = @ItemId");
          await tx.request().input("SeatId", sql.Int, item.LicenseAssignmentId).query("DELETE FROM dbo.LicenseAssignments WHERE Id = @SeatId");
          seatId = null;
        }
      }

      await tx.request()
        .input("ItemId", sql.Int, itemId)
        .input("IsDone", sql.Bit, done)
        .input("DoneById", sql.Int, done ? user.Id : null)
        .input("SeatId", sql.Int, seatId)
        .query(`
          UPDATE dbo.ChecklistItems
          SET IsDone = @IsDone, DoneById = @DoneById, DoneAt = ${now}, LicenseAssignmentId = @SeatId
          WHERE Id = @ItemId
        `);
      await recordEvents(tx, id, user.Id, [{ field: done ? "Checklist done" : "Checklist undone", newValue: item.Label }]);
    });
    return { jsonBody: { ok: true } };
  }
);
