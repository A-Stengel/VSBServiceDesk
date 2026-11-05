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
const { ticketCreated, ticketClosed } = require("../shared/notify");
const { ACCESS_KINDS, IMIS_KINDS, readAccess, accessName, accessLabel, grantAccess } = require("../shared/access");
const { loadSet, firstLicense, addTitle } = require("../shared/onboarding");
const {
  TICKET_SELECT,
  FOR_IT_SQL,
  MINE_SQL,
  departmentSql,
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
    .input("ApplicationId", sql.Int, links.applicationId || null)
    .input("AccessKind", sql.NVarChar(20), links.access?.kind || null)
    .input("AccessRefId", sql.Int, links.access?.refId ?? null)
    .input("AccessText", sql.NVarChar(200), links.access?.text ?? null)
    .input("AccessLevel", sql.TinyInt, links.access?.level ?? null)
    .input("PersonAccessId", sql.Int, links.personAccessId || null)
    .input("SortOrder", sql.Int, sortOrder)
    .query(`
      INSERT INTO dbo.ChecklistItems (TicketId, Label, InventoryItemId, SoftwareId, LicenseAssignmentId, TicketItemId,
        ApplicationId, AccessKind, AccessRefId, AccessText, AccessLevel, PersonAccessId, SortOrder, IsRemoval)
      VALUES (@TicketId, @Label, @InventoryItemId, @SoftwareId, @LicenseAssignmentId, @TicketItemId,
        @ApplicationId, @AccessKind, @AccessRefId, @AccessText, @AccessLevel, @PersonAccessId, @SortOrder, @IsRemoval)
    `);
}

// "Grant access: Adobe Acrobat (Adobe Pro)". The license is what a
// technician hands out; without one the line asks for it.
async function appLabel(db, applicationId, softwareId) {
  const app = await one(db, "SELECT Name FROM dbo.Applications WHERE Id = @Id", { Id: [sql.Int, applicationId] });
  if (!app) throw new HttpError(400, "That software doesn't exist");
  if (!softwareId) return `Grant access: ${app.Name} (pick a license)`;
  const lic = await one(db, "SELECT Name FROM dbo.Software WHERE Id = @Id AND ApplicationId = @AppId AND IsDeleted = 0", {
    Id: [sql.Int, softwareId],
    AppId: [sql.Int, applicationId]
  });
  if (!lic) throw new HttpError(400, "That license isn't linked to the software. Link it on the Inventory page.");
  return lic.Name === app.Name ? `Grant access: ${app.Name}` : `Grant access: ${app.Name} (${lic.Name})`;
}

const giveAccessLabel = (entry, name) => `Give access: ${accessLabel(entry, name)}`;
const removeAccessLabel = (held) => `Remove access: ${held.Label}`;

const esc = (text) => String(text ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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
  const accessIds = only?.accessIds || [];
  const access = only ? holdings.access.filter((a) => accessIds.includes(a.Id)) : holdings.access;
  if (only && seats.length + items.length + access.length < only.seatIds.length + only.ticketItemIds.length + accessIds.length) {
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
  for (const held of access) {
    await addChecklistItem(db, ticketId, order, removeAccessLabel(held), { personAccessId: held.Id, isRemoval: true });
    order += 10;
  }
  return order;
}

// Body "removals": { seatIds: [...], ticketItemIds: [...], accessIds: [...] }
function readRemovals(value) {
  if (value === undefined || value === null) return { seatIds: [], ticketItemIds: [], accessIds: [] };
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Removals must be an object");
  return {
    seatIds: readIdList(value.seatIds, "License"),
    ticketItemIds: readIdList(value.ticketItemIds, "Item"),
    accessIds: readIdList(value.accessIds, "Access")
  };
}

// The new hire part of an onboarding form:
// { firstName, lastName, displayName, departmentId, jobTitleId | jobTitleName }
function readNewHire(value) {
  if (!value || typeof value !== "object") throw new HttpError(400, "Fill in the new hire's details");
  const firstName = requiredText(value.firstName, "First name", 100);
  const lastName = requiredText(value.lastName, "Last name", 100);
  const displayName = optionalText(value.displayName, "Display name", 200);
  const departmentId = requiredId(value.departmentId, "Department");
  const jobTitleId = optionalId(value.jobTitleId, "Job title");
  const jobTitleName = jobTitleId ? null : optionalText(value.jobTitleName, "Job title", 150);
  return { firstName, lastName, displayName, departmentId, jobTitleId, jobTitleName, name: displayName || `${firstName} ${lastName}` };
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
// ?departments=1 also brings tickets from the departments a manager manages
// (on "mine"; the queue already has everything).
endpoint("listTickets", { methods: ["GET"], route: "tickets" }, async (request, context, user) => {
  const q = request.query;
  const scope = user.IsTechnician && q.get("scope") === "queue" ? "queue" : "mine";
  const where = [];
  const pool = await getConnection();
  const req = pool.request();

  if (scope === "mine") {
    const departments = q.get("departments") === "1" && user.ManagedDepartmentIds?.length;
    where.push(departments ? `(${MINE_SQL} OR ${departmentSql(user.ManagedDepartmentIds)})` : MINE_SQL);
  } else {
    where.push(FOR_IT_SQL);
  }
  req.input("Me", sql.Int, user.Id);
  req.input("MyEmail", sql.NVarChar(320), String(user.Email || "").toLowerCase());

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

    // Onboarding and low ink forms can leave these blank; they're written
    // from the form further down
    let subject = optionalText(data.subject, "Subject", 255);
    let draft = typeof data.description === "string" ? data.description : "";
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
    let subcategory = null;
    if (subcategoryId) {
      subcategory = await one(pool, "SELECT CategoryId, Name, AsksForInk FROM dbo.Subcategories WHERE Id = @Id", { Id: [sql.Int, subcategoryId] });
      if (!subcategory || subcategory.CategoryId !== categoryId) throw new HttpError(400, "That subcategory isn't under the chosen category");
    }

    // Low ink: which printer, and which of its cartridges are low
    let printer = null;
    let inks = [];
    if (subcategory?.AsksForInk) {
      printer = await one(pool, "SELECT Id, Name, Location FROM dbo.Printers WHERE Id = @Id AND IsActive = 1 AND IsDeleted = 0", {
        Id: [sql.Int, requiredId(data.printerId, "Printer")]
      });
      if (!printer) throw new HttpError(400, "Pick a printer from the list");
      const fits = (await pool.request().input("PrinterId", sql.Int, printer.Id).query(`
        SELECT c.Id, c.Name, c.Color FROM dbo.InkCartridgePrinters cp
        JOIN dbo.InkCartridges c ON c.Id = cp.InkCartridgeId
        WHERE cp.PrinterId = @PrinterId AND c.IsActive = 1 AND c.IsDeleted = 0
      `)).recordset;
      const picked = readIdList(data.inkCartridgeIds, "Ink");
      inks = fits.filter((c) => picked.includes(c.Id));
      if (inks.length < picked.length) throw new HttpError(400, "One of the cartridges picked doesn't fit that printer");
      if (fits.length && !inks.length) throw new HttpError(400, "Pick which colors are low");
    }
    const startDate = shown("startDate") ? need("startDate", optionalDate(data.startDate, "Start date")) : null;
    const endDate = shown("endDate") ? need("endDate", optionalDate(data.endDate, "End date")) : null;
    if (startDate && endDate && endDate < startDate) throw new HttpError(400, "The end date is before the start date");
    // Onboarding someone who already has an account (coming back after off
    // boarding) links the ticket to them, so closing it turns the account on.
    const rehire = checklistSource === "onboarding" && user.IsTechnician && !shown("forUser");
    const forUserId = shown("forUser") ? need("forUser", optionalId(data.forUserId, "Person"))
      : rehire ? optionalId(data.forUserId, "Person") : null;
    const newHire = shown("newHire") && (data.newHire || fields.get("newHire").IsRequired) ? readNewHire(data.newHire) : null;
    const forPersonName = newHire?.name || null;
    const forDepartmentId = newHire?.departmentId || null;
    // The new hire's title: one of the department's, or a new one typed on
    // the form (added to the department in the transaction below)
    let jobTitleId = null;
    let newTitleName = null;
    let newHireDepartment = null;
    let jobTitleLabel = null;
    if (newHire) {
      newHireDepartment = await one(pool, "SELECT Id, Name FROM dbo.Departments WHERE Id = @Id", { Id: [sql.Int, newHire.departmentId] });
      if (!newHireDepartment) throw new HttpError(400, "That department doesn't exist");
      if (newHire.jobTitleId) {
        const title = await one(pool, "SELECT Id, Name FROM dbo.JobTitles WHERE Id = @Id AND DepartmentId = @DepartmentId", {
          Id: [sql.Int, newHire.jobTitleId],
          DepartmentId: [sql.Int, newHire.departmentId]
        });
        if (!title) throw new HttpError(400, "That job title isn't under the department");
        jobTitleId = title.Id;
        jobTitleLabel = title.Name;
      } else if (newHire.jobTitleName) {
        const title = await one(pool, "SELECT Id, Name FROM dbo.JobTitles WHERE DepartmentId = @DepartmentId AND LOWER(Name) = LOWER(@Name)", {
          DepartmentId: [sql.Int, newHire.departmentId],
          Name: [sql.NVarChar(150), newHire.jobTitleName]
        });
        if (title) jobTitleId = title.Id;
        else newTitleName = newHire.jobTitleName;
        jobTitleLabel = title ? title.Name : newHire.jobTitleName;
      }
    }

    // Onboarding always shows the equipment and software pick lists, and
    // fills in what the job title's defaults require
    const onboarding = checklistSource === "onboarding";
    const items = shown("items") || onboarding ? readItems(data.items) : [];
    const softwareIds = shown("software") && !onboarding ? need("software", readIdList(data.softwareIds, "Software")) : [];
    const apps = [];
    const access = [];
    if (onboarding) {
      // A new title starts from the general defaults, so those apply
      const set = await loadSet(pool, jobTitleId);
      for (const required of set.items.filter((i) => i.isRequired)) {
        if (!items.some((i) => i.inventoryItemId === required.inventoryItemId)) items.push({ inventoryItemId: required.inventoryItemId, quantity: 1 });
      }
      const applicationIds = readIdList(data.applicationIds, "Software");
      for (const required of set.apps.filter((a) => a.isRequired)) {
        if (!applicationIds.includes(required.applicationId)) applicationIds.push(required.applicationId);
      }
      for (const applicationId of applicationIds) {
        const app = await one(pool, "SELECT Id, IsImis FROM dbo.Applications WHERE Id = @Id AND IsActive = 1", { Id: [sql.Int, applicationId] });
        if (!app) throw new HttpError(400, "One of the software choices isn't available");
        const fromSet = set.apps.find((a) => a.applicationId === applicationId);
        const softwareId = fromSet?.softwareId || (await firstLicense(pool, applicationId));
        apps.push({ applicationId, softwareId, isImis: !!app.IsImis });
      }
      // Mailboxes, calendars, phone lines and printers from the form
      if (data.access !== undefined && data.access !== null && !Array.isArray(data.access)) throw new HttpError(400, "Access must be a list");
      for (const value of data.access || []) {
        const entry = readAccess(value);
        if (IMIS_KINDS.includes(entry.kind)) throw new HttpError(400, "iMIS access is set by IT on the ticket");
        const same = access.some((x) => x.kind === entry.kind && (ACCESS_KINDS[entry.kind].text ? x.text.toLowerCase() === entry.text.toLowerCase() : x.refId === entry.refId));
        if (!same) access.push({ ...entry, name: await accessName(pool, entry) });
      }
      if (access.length > 200) throw new HttpError(400, "That's too much access for one form");
      // iMIS details come from the title's defaults when iMIS is asked for.
      // A read only license gets the StaffReadOnly role and no module levels.
      const imis = apps.find((a) => a.isImis);
      if (imis) {
        const license = imis.softwareId ? await one(pool, "SELECT ImisAccess FROM dbo.Software WHERE Id = @Id", { Id: [sql.Int, imis.softwareId] }) : null;
        const readOnly = license?.ImisAccess === "read";
        const entries = set.access.filter((a) => IMIS_KINDS.includes(a.kind) && !(readOnly && a.kind === "imisModule"));
        if (readOnly) {
          const role = await one(pool, "SELECT Id FROM dbo.ImisRoles WHERE Name = N'StaffReadOnly' AND IsActive = 1");
          if (role && !entries.some((a) => a.kind === "imisRole" && a.refId === role.Id)) entries.unshift({ kind: "imisRole", refId: role.Id, text: null, level: null });
        }
        for (const entry of entries) {
          // Anything turned off since the defaults were saved is left out
          const name = await accessName(pool, entry).catch(() => null);
          if (name) access.push({ ...entry, name });
        }
      }
    }
    need("items", items);
    if (onboarding) need("software", apps);

    // What the onboarding and low ink forms leave blank
    if (!subject && newHire) subject = `Onboarding: ${newHire.name}`;
    if (!subject && printer) subject = `Low ink: ${printer.Name}`;
    if (!subject) throw new HttpError(400, "Subject is required");
    if (!hasContent(draft) && newHire) {
      draft = `<p>New hire: ${esc(newHire.name)}</p><p>Department: ${esc(newHireDepartment.Name)}${jobTitleLabel ? `<br />Job title: ${esc(jobTitleLabel)}` : ""}${startDate ? `<br />Start date: ${startDate}` : ""}</p>`;
    }
    if (!hasContent(draft) && printer) {
      draft = `<p>${esc(printer.Name)}${printer.Location ? ` (${esc(printer.Location)})` : ""} is low on ${inks.length ? esc(inks.map((c) => `${c.Name} ${c.Color}`).join(", ")) : "ink"}.</p>`;
    }
    if (!hasContent(draft)) throw new HttpError(400, "Description is required");

    const removals = shown("removals") ? readRemovals(data.removals) : { seatIds: [], ticketItemIds: [], accessIds: [] };
    if (removals.seatIds.length + removals.ticketItemIds.length + removals.accessIds.length) {
      if (!forUserId) throw new HttpError(400, "Pick who the equipment or software is being removed from");
      if (!user.IsTechnician && forUserId !== user.Id) throw new HttpError(403, "Only technicians can pick what to remove from someone else");
    }
    if (fields.get("removals")?.IsRequired && !removals.seatIds.length && !removals.ticketItemIds.length && !removals.accessIds.length) {
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
    // Anyone else can submit a request for a coworker (not on Access &
    // Equipment, which asks who it's for itself). The coworker becomes the
    // requester and the person submitting it is CC'd, so they still see it.
    const forColleague = !user.IsTechnician && !type.UsesChecklist && !shown("forUser") && !shown("newHire") && !checklistSource
      ? optionalId(data.onBehalfOfId, "Person") : null;
    if (forColleague && forColleague !== user.Id) {
      const colleague = await one(pool, "SELECT Id, UserTypeId, IsActive FROM dbo.Users WHERE Id = @Id", { Id: [sql.Int, forColleague] });
      if (!colleague || !colleague.IsActive || colleague.UserTypeId !== settings.StaffUserTypeId) {
        throw new HttpError(400, "Pick a coworker from the list");
      }
      requesterId = colleague.Id;
      const mine = String(user.Email || "").toLowerCase();
      if (mine && !cc.includes(mine)) cc.push(mine);
    }
    const requester = await one(pool, "SELECT Id, Email, DepartmentId, IsActive FROM dbo.Users WHERE Id = @Id", { Id: [sql.Int, requesterId] });
    if (!requester || !requester.IsActive) throw new HttpError(400, "That requester doesn't exist");
    // The requester gets the emails anyway, so they aren't CC'd too
    const requesterEmail = String(requester.Email || "").toLowerCase();
    if (cc.includes(requesterEmail)) cc.splice(cc.indexOf(requesterEmail), 1);
    if (checklistSource === "offboarding" && !forUserId) throw new HttpError(400, "Pick who is leaving");

    const warnings = [];
    const statusId = technicianId && settings.AssignedStatusId ? settings.AssignedStatusId : settings.NewStatusId;

    let ticketId;
    try {
      ticketId = await withTransaction(async (tx) => {
        if (newTitleName) {
          jobTitleId = await addTitle(tx, newHire.departmentId, newTitleName);
          await logChange(tx, {
            area: "settings",
            section: "onboarding",
            entityId: jobTitleId,
            actorId: user.Id,
            summary: `Added the job title ${newTitleName} to ${newHireDepartment.Name} from an onboarding request`
          });
        }
        const created = await one(
          tx,
          `INSERT INTO dbo.Tickets
             (TicketTypeId, StatusId, PriorityId, CategoryId, SubcategoryId, SourceId, RequesterId, ForUserId,
              ForPersonName, ForDepartmentId, TechnicianId, DepartmentId, Subject, Description, StartDate, EndDate,
              NewHireFirstName, NewHireLastName, JobTitleId, PrinterId)
           OUTPUT INSERTED.Id
           VALUES
             (@TypeId, @StatusId, @PriorityId, @CategoryId, @SubcategoryId, @SourceId, @RequesterId, @ForUserId,
              @ForPersonName, @ForDepartmentId, @TechnicianId, @DepartmentId, @Subject, @Description, @StartDate, @EndDate,
              @NewHireFirstName, @NewHireLastName, @JobTitleId, @PrinterId)`,
          {
            NewHireFirstName: [sql.NVarChar(100), newHire?.firstName || null],
            NewHireLastName: [sql.NVarChar(100), newHire?.lastName || null],
            JobTitleId: [sql.Int, jobTitleId],
            PrinterId: [sql.Int, printer?.Id || null],
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
          for (const app of apps) {
            await addChecklistItem(tx, id, order, await appLabel(tx, app.applicationId, app.softwareId), app);
            order += 10;
          }
          for (const entry of access) {
            await addChecklistItem(tx, id, order, giveAccessLabel(entry, entry.name), { access: entry });
            order += 10;
          }
        }
        for (const ink of inks) {
          await tx.request().input("TicketId", sql.Int, id).input("InkCartridgeId", sql.Int, ink.Id)
            .query("INSERT INTO dbo.TicketInk (TicketId, InkCartridgeId) VALUES (@TicketId, @InkCartridgeId)");
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

    await ticketCreated(ticketId, context);
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
           c.Body, c.IsTechnicianNote, c.IsResolution, c.VisibleToEventManagers, c.Direction, c.CreatedAt,
           ${tech || access.hr ? "c.EmailedAt, c.EmailNote, CASE WHEN c.EmailMessageId IS NOT NULL THEN 1 ELSE 0 END AS CameByEmail," : ""}
           c.MergedFromTicketId
    FROM dbo.TicketConversations c
    JOIN dbo.Users u ON u.Id = c.AuthorId
    WHERE c.TicketId = @Id ${notes}
    ORDER BY c.CreatedAt DESC, c.Id DESC
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
        SELECT ci.Id, ci.Label, ci.IsDone, ci.IsRemoval, ci.DoneAt, ${personName("u")} AS DoneByName, ci.SortOrder,
               ci.ApplicationId, ci.SoftwareId, ci.AccessKind, ci.AccessRefId, ci.AccessLevel, ci.AccessText
        FROM dbo.ChecklistItems ci
        LEFT JOIN dbo.Users u ON u.Id = ci.DoneById
        WHERE ci.TicketId = @Id
        ORDER BY ci.SortOrder, ci.Id
      `)).recordset
    : [];
  // Low ink: the cartridges reported, with their stock for technicians
  const ink = (await pool.request().input("Id", sql.Int, id).query(`
    SELECT ti.Id, ti.InkCartridgeId, c.Name, c.Color, ti.TakenAt, CASE WHEN u.Id IS NOT NULL THEN ${personName("u")} END AS TakenByName
           ${tech ? ", c.QuantityOnHand, c.LowStockAt" : ""}
    FROM dbo.TicketInk ti
    JOIN dbo.InkCartridges c ON c.Id = ti.InkCartridgeId
    LEFT JOIN dbo.Users u ON u.Id = ti.TakenById
    WHERE ti.TicketId = @Id
    ORDER BY c.Name, c.Color
  `)).recordset;
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

  // The satisfaction survey's answer, for technicians
  const survey = tech
    ? (await pool.request().input("Id", sql.Int, id).query("SELECT Rating, Comment, SentAt, AnsweredAt FROM dbo.Surveys WHERE TicketId = @Id")).recordset[0] || null
    : null;

  return {
    jsonBody: {
      ticket: { ...forViewer(ticket, user), HasOverlap: hasOverlap, MergedIntoNumber: ticket.MergedIntoId ? formatNumber(ticket.MergedIntoId) : null },
      survey,
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
      ink,
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
    let closedNow = false;
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
      if (changes.StatusId && !ticket.IsClosed && (await getStatus(tx, changes.StatusId.value)).IsClosed) {
        throw new HttpError(400, "Use Close ticket to close it, so it gets a resolution");
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
      if (changes.StatusId) {
        const status = await getStatus(tx, changes.StatusId.value);
        closedNow = status.IsClosed && !ticket.IsClosed;
        await accountOnClose(tx, ticket, status, user.Id, warnings);
      }
    });

    if (closedNow) await ticketClosed(id, context);
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
// { softwareId } grant a license, { applicationId, softwareId } grant
// software with the license picked, { access: { kind, refId, text, level } }
// give access (mailbox, printer, iMIS...), { seatId } remove a license the
// person holds, { ticketItemId } collect equipment the person holds,
// { accessId } take away access the person has.
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
      } else if (body.applicationId) {
        const applicationId = requiredId(body.applicationId, "Software");
        const softwareId = optionalId(body.softwareId, "License") || (await firstLicense(tx, applicationId));
        label = await appLabel(tx, applicationId, softwareId);
        await addChecklistItem(tx, id, order, label, { applicationId, softwareId });
      } else if (body.access) {
        const entry = readAccess(body.access);
        label = giveAccessLabel(entry, await accessName(tx, entry));
        await addChecklistItem(tx, id, order, label, { access: entry });
      } else if (body.softwareId) {
        const softwareId = requiredId(body.softwareId, "Software");
        const names = await softwareNames(tx, [softwareId]);
        label = `Grant access: ${names.get(softwareId)}`;
        await addChecklistItem(tx, id, order, label, { softwareId });
      } else if (body.seatId || body.ticketItemId || body.accessId) {
        if (!personId) throw new HttpError(400, "Link the ticket to the person (the For field) first");
        const only = {
          seatIds: body.seatId ? [requiredId(body.seatId, "License")] : [],
          ticketItemIds: body.ticketItemId ? [requiredId(body.ticketItemId, "Item")] : [],
          accessIds: body.accessId ? [requiredId(body.accessId, "Access")] : []
        };
        const holdings = await getHoldings(tx, personId);
        const seat = holdings.seats.find((s) => only.seatIds.includes(s.Id));
        const held = holdings.items.find((i) => only.ticketItemIds.includes(i.Id));
        const given = holdings.access.find((a) => only.accessIds.includes(a.Id));
        label = seat ? removeSeatLabel(seat) : held ? collectLabel(held) : given ? removeAccessLabel(given) : null;
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
    const body = await readJson(request);

    await withTransaction(async (tx) => {
      const ticket = await loadTicket(tx, id);
      if (!ticket) throw new HttpError(404, "Ticket not found");
      const item = await one(tx, "SELECT * FROM dbo.ChecklistItems WHERE Id = @ItemId AND TicketId = @Id", {
        Id: [sql.Int, id],
        ItemId: [sql.Int, itemId]
      });
      if (!item) throw new HttpError(404, "Checklist item not found");

      // Changing the license or iMIS level, before the line is done
      if ("softwareId" in body || "level" in body) {
        if (item.IsDone) throw new HttpError(400, "Untick the line before changing it");
        let label = item.Label;
        if ("softwareId" in body) {
          if (!item.ApplicationId) throw new HttpError(400, "This line isn't for software");
          item.SoftwareId = optionalId(body.softwareId, "License");
          label = await appLabel(tx, item.ApplicationId, item.SoftwareId);
        }
        if ("level" in body) {
          if (item.AccessKind !== "imisModule") throw new HttpError(400, "Only iMIS module lines have a level");
          const entry = readAccess({ kind: item.AccessKind, refId: item.AccessRefId, level: body.level });
          item.AccessLevel = entry.level;
          label = giveAccessLabel(entry, await accessName(tx, entry, true));
        }
        await tx.request()
          .input("ItemId", sql.Int, itemId)
          .input("SoftwareId", sql.Int, item.SoftwareId)
          .input("Level", sql.TinyInt, item.AccessLevel)
          .input("Label", sql.NVarChar(255), label.slice(0, 255))
          .query("UPDATE dbo.ChecklistItems SET SoftwareId = @SoftwareId, AccessLevel = @Level, Label = @Label WHERE Id = @ItemId");
        if (label !== item.Label) await recordEvents(tx, id, user.Id, [{ field: "Checklist line changed", oldValue: item.Label, newValue: label }]);
        item.Label = label;
      }

      if (!("isDone" in body)) return;
      const done = !!body.isDone;
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

      // Access (mailboxes, printers, iMIS...): ticking gives it to the person
      // or takes it away; unticking undoes that
      let accessId = item.PersonAccessId;
      if (leaving && item.PersonAccessId) {
        await tx.request()
          .input("AccessId", sql.Int, item.PersonAccessId)
          .input("TicketId", sql.Int, done ? id : null)
          .query(`UPDATE dbo.PersonAccess SET RemovedAt = ${now}, RemovedTicketId = @TicketId WHERE Id = @AccessId`);
      }
      if (!leaving && item.AccessKind) {
        if (done) {
          const personId = ticket.ForUserId || (ticket.ForPersonName ? null : ticket.RequesterId);
          if (!personId) throw new HttpError(400, "Link the new hire to their account (the For field) before giving access");
          accessId = await grantAccess(tx, personId, {
            kind: item.AccessKind,
            refId: item.AccessRefId,
            text: item.AccessText,
            level: item.AccessLevel
          }, id);
        } else if (item.PersonAccessId) {
          await tx.request().input("ItemId", sql.Int, itemId).query("UPDATE dbo.ChecklistItems SET PersonAccessId = NULL WHERE Id = @ItemId");
          await tx.request().input("AccessId", sql.Int, item.PersonAccessId).query("DELETE FROM dbo.PersonAccess WHERE Id = @AccessId");
          accessId = null;
        }
      }
      if (!leaving && done && item.ApplicationId && !item.SoftwareId) throw new HttpError(400, "Pick the license first");

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
        .input("AccessId", sql.Int, leaving ? item.PersonAccessId : accessId)
        .query(`
          UPDATE dbo.ChecklistItems
          SET IsDone = @IsDone, DoneById = @DoneById, DoneAt = ${now}, LicenseAssignmentId = @SeatId, PersonAccessId = @AccessId
          WHERE Id = @ItemId
        `);
      await recordEvents(tx, id, user.Id, [{ field: done ? "Checklist done" : "Checklist undone", newValue: item.Label }]);
    });
    return { jsonBody: { ok: true } };
  }
);

// Takes a line off the checklist, while it isn't done. Equipment the line
// would have handed out comes off the ticket too, unless it's already out.
endpoint(
  "deleteChecklistItem",
  { methods: ["DELETE"], route: "tickets/{id:int}/checklist/{itemId:int}", role: "technician", failMessage: "Could not remove the checklist line" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const itemId = Number(request.params.itemId);
    await withTransaction(async (tx) => {
      const item = await one(tx, "SELECT * FROM dbo.ChecklistItems WHERE Id = @ItemId AND TicketId = @Id", {
        Id: [sql.Int, id],
        ItemId: [sql.Int, itemId]
      });
      if (!item) throw new HttpError(404, "Checklist item not found");
      if (item.IsDone) throw new HttpError(400, "Untick the line before removing it");
      await tx.request().input("ItemId", sql.Int, itemId).query("DELETE FROM dbo.ChecklistItems WHERE Id = @ItemId");
      if (item.TicketItemId && !item.IsRemoval) {
        await tx.request().input("TicketItemId", sql.Int, item.TicketItemId).input("TicketId", sql.Int, id).query(`
          DELETE FROM dbo.TicketItems
          WHERE Id = @TicketItemId AND TicketId = @TicketId AND OutAt IS NULL
            AND NOT EXISTS (SELECT 1 FROM dbo.ChecklistItems WHERE TicketItemId = @TicketItemId)
        `);
      }
      await recordEvents(tx, id, user.Id, [{ field: "Checklist line removed", newValue: item.Label }]);
    });
    return { jsonBody: { ok: true } };
  }
);
