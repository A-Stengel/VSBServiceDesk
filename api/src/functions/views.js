const { endpoint, readJson, requiredText, requiredId } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { logChange } = require("../shared/changelog");
const { resetTabs } = require("../shared/tabs");

// Each person's own tabs on a list (tickets, events or people). A tab is a
// saved view: a name plus its settings (what it loads, its filters and sort).
// The first time someone opens a list they get a copy of the default tabs
// for their group, which admins set in Settings > Default tabs. They can then
// add, rename, reorder, change and remove their tabs, or reset to the
// defaults. dbo.TabSetup records who already has their copy.

const LISTS = ["tickets", "events", "people"];
const AUDIENCES = ["requester", "eventManager", "technician"];
const MAX_TABS = 30;
const LIST_NAMES = { tickets: "Tickets", events: "Rentals and events", people: "People" };
const AUDIENCE_NAMES = { requester: "requesters", eventManager: "event managers", technician: "technicians" };

function listKey(value) {
  if (!LISTS.includes(value)) throw new HttpError(400, "Unknown list");
  return value;
}

function audienceKey(value) {
  if (!AUDIENCES.includes(value)) throw new HttpError(400, "Unknown group");
  return value;
}

// Which set of default tabs this person starts with on a list.
function audienceOf(user, list) {
  if (user.IsTechnician) return "technician";
  if (list === "events" && user.IsEventManager) return "eventManager";
  return "requester";
}

function canUse(user, list) {
  return list !== "people" || !!user.IsTechnician;
}

function settingsText(value) {
  const text = JSON.stringify(value && typeof value === "object" ? value : {});
  if (text.length > 2000) throw new HttpError(400, "That tab has too many filters to save");
  return text;
}

const shape = (row) => {
  let settings = {};
  try {
    settings = JSON.parse(row.Settings);
  } catch {
    // a damaged tab just opens with no filters
  }
  return { Id: row.Id, Name: row.Name, Position: row.Position, Settings: settings };
};

// Copies the defaults to this person if they don't have their tabs yet.
// Tabs they saved before (or team views copied to them) go after the
// defaults.
async function ensureTabs(tx, user, list) {
  const setup = await tx.request().input("Me", sql.Int, user.Id).input("List", sql.NVarChar(20), list)
    .query("SELECT 1 AS Done FROM dbo.TabSetup WITH (UPDLOCK, HOLDLOCK) WHERE UserId = @Me AND ListKey = @List");
  if (setup.recordset.length) return;
  const defaults = await tx.request().input("List", sql.NVarChar(20), list).input("Audience", sql.NVarChar(20), audienceOf(user, list))
    .query("SELECT COUNT(*) AS N FROM dbo.DefaultTabs WHERE ListKey = @List AND Audience = @Audience");
  const count = defaults.recordset[0].N;
  await tx.request().input("Me", sql.Int, user.Id).input("List", sql.NVarChar(20), list).input("Shift", sql.Int, count)
    .query(`
      ;WITH ordered AS (
        SELECT Position, ROW_NUMBER() OVER (ORDER BY Position, Id) AS N
        FROM dbo.SavedViews WHERE OwnerId = @Me AND ListKey = @List
      )
      UPDATE ordered SET Position = @Shift + N
    `);
  await tx.request().input("Me", sql.Int, user.Id).input("List", sql.NVarChar(20), list).input("Audience", sql.NVarChar(20), audienceOf(user, list))
    .query(`
      INSERT INTO dbo.SavedViews (OwnerId, ListKey, Name, Settings, Position)
      SELECT @Me, ListKey, Name, Settings, ROW_NUMBER() OVER (ORDER BY Position, Id)
      FROM dbo.DefaultTabs WHERE ListKey = @List AND Audience = @Audience;
      INSERT INTO dbo.TabSetup (UserId, ListKey) VALUES (@Me, @List);
    `);
}

async function myTabs(db, userId, list) {
  const result = await db.request().input("Me", sql.Int, userId).input("List", sql.NVarChar(20), list)
    .query("SELECT Id, Name, Settings, Position FROM dbo.SavedViews WHERE OwnerId = @Me AND ListKey = @List ORDER BY Position, Id");
  return result.recordset.map(shape);
}

async function loadOwn(db, id, userId) {
  const found = await db.request().input("Id", sql.Int, id).query("SELECT Id, OwnerId, ListKey FROM dbo.SavedViews WHERE Id = @Id");
  const view = found.recordset[0];
  if (!view || view.OwnerId !== userId) throw new HttpError(404, "Tab not found");
  return view;
}

// ?list=tickets  Your tabs, in order.
endpoint("listViews", { methods: ["GET"], route: "views" }, async (request, context, user) => {
  const list = listKey(request.query.get("list"));
  if (!canUse(user, list)) return { jsonBody: [] };
  await withTransaction((tx) => ensureTabs(tx, user, list));
  const pool = await getConnection();
  return { jsonBody: await myTabs(pool, user.Id, list) };
});

// Body: { list, name, settings }  Adds a tab at the end.
endpoint("createView", { methods: ["POST"], route: "views", failMessage: "Could not add the tab" }, async (request, context, user) => {
  const body = await readJson(request);
  const list = listKey(body.list);
  if (!canUse(user, list)) throw new HttpError(403, "Only technicians can save people tabs");
  const name = requiredText(body.name, "Tab name", 100);
  const settings = settingsText(body.settings);
  let id;
  await withTransaction(async (tx) => {
    await ensureTabs(tx, user, list);
    const count = await tx.request().input("Me", sql.Int, user.Id).input("List", sql.NVarChar(20), list)
      .query("SELECT COUNT(*) AS N, COALESCE(MAX(Position), 0) AS Last FROM dbo.SavedViews WHERE OwnerId = @Me AND ListKey = @List");
    if (count.recordset[0].N >= MAX_TABS) throw new HttpError(400, `You can have up to ${MAX_TABS} tabs on a list`);
    const created = await tx.request()
      .input("Me", sql.Int, user.Id)
      .input("List", sql.NVarChar(20), list)
      .input("Name", sql.NVarChar(100), name)
      .input("Settings", sql.NVarChar(2000), settings)
      .input("Position", sql.Int, count.recordset[0].Last + 1)
      .query(`
        INSERT INTO dbo.SavedViews (OwnerId, ListKey, Name, Settings, Position)
        OUTPUT INSERTED.Id
        VALUES (@Me, @List, @Name, @Settings, @Position)
      `);
    id = created.recordset[0].Id;
  });
  const pool = await getConnection();
  const row = await pool.request().input("Id", sql.Int, id).query("SELECT Id, Name, Settings, Position FROM dbo.SavedViews WHERE Id = @Id");
  return { status: 201, jsonBody: shape(row.recordset[0]) };
});

// Body: { name?, settings? }  Renames a tab or saves its filters.
endpoint("updateView", { methods: ["PATCH"], route: "views/{id:int}", failMessage: "Could not save the tab" }, async (request, context, user) => {
  const id = Number(request.params.id);
  const body = await readJson(request);
  const pool = await getConnection();
  await loadOwn(pool, id, user.Id);
  const sets = [];
  const req = pool.request().input("Id", sql.Int, id);
  if ("name" in body) {
    sets.push("Name = @Name");
    req.input("Name", sql.NVarChar(100), requiredText(body.name, "Tab name", 100));
  }
  if ("settings" in body) {
    sets.push("Settings = @Settings");
    req.input("Settings", sql.NVarChar(2000), settingsText(body.settings));
  }
  if (sets.length) await req.query(`UPDATE dbo.SavedViews SET ${sets.join(", ")} WHERE Id = @Id`);
  const row = await pool.request().input("Id", sql.Int, id).query("SELECT Id, Name, Settings, Position FROM dbo.SavedViews WHERE Id = @Id");
  return { jsonBody: shape(row.recordset[0]) };
});

// Your own tabs. The last tab on a list can't be removed.
endpoint("deleteView", { methods: ["DELETE"], route: "views/{id:int}" }, async (request, context, user) => {
  const id = Number(request.params.id);
  await withTransaction(async (tx) => {
    const view = await loadOwn(tx, id, user.Id);
    const count = await tx.request().input("Me", sql.Int, user.Id).input("List", sql.NVarChar(20), view.ListKey)
      .query("SELECT COUNT(*) AS N FROM dbo.SavedViews WHERE OwnerId = @Me AND ListKey = @List");
    if (count.recordset[0].N <= 1) throw new HttpError(400, "Keep at least one tab");
    await tx.request().input("Id", sql.Int, id).query("DELETE FROM dbo.SavedViews WHERE Id = @Id");
  });
  return { jsonBody: { ok: true } };
});

// Body: { list, ids: [tab ids in the new order] }
endpoint("orderViews", { methods: ["PUT"], route: "views/order", failMessage: "Could not reorder the tabs" }, async (request, context, user) => {
  const body = await readJson(request);
  const list = listKey(body.list);
  if (!Array.isArray(body.ids)) throw new HttpError(400, "Send the tabs in order");
  const ids = body.ids.map((v) => requiredId(v, "Tab"));
  await withTransaction(async (tx) => {
    const mine = await myTabs(tx, user.Id, list);
    if (ids.length !== mine.length || !mine.every((t) => ids.includes(t.Id))) throw new HttpError(400, "Your tabs changed. Reload the page and try again.");
    for (const [index, id] of ids.entries()) {
      await tx.request().input("Id", sql.Int, id).input("Position", sql.Int, index + 1)
        .query("UPDATE dbo.SavedViews SET Position = @Position WHERE Id = @Id");
    }
  });
  const pool = await getConnection();
  return { jsonBody: await myTabs(pool, user.Id, list) };
});

// Body: { list }  Puts your tabs back to the current defaults.
endpoint("resetViews", { methods: ["POST"], route: "views/reset", failMessage: "Could not reset the tabs" }, async (request, context, user) => {
  const body = await readJson(request);
  const list = listKey(body.list);
  await withTransaction(async (tx) => {
    await resetTabs(tx, user.Id, list);
    await ensureTabs(tx, user, list);
  });
  const pool = await getConnection();
  return { jsonBody: await myTabs(pool, user.Id, list) };
});

// ---------------------------------------------------------------------------
// Settings > Default tabs (admins)
// ---------------------------------------------------------------------------

// ?list=tickets&audience=technician
endpoint("defaultTabs", { methods: ["GET"], route: "manage/default-tabs", role: "admin" }, async (request) => {
  const list = listKey(request.query.get("list"));
  const audience = audienceKey(request.query.get("audience"));
  const pool = await getConnection();
  const result = await pool.request().input("List", sql.NVarChar(20), list).input("Audience", sql.NVarChar(20), audience)
    .query("SELECT Id, Name, Settings, Position FROM dbo.DefaultTabs WHERE ListKey = @List AND Audience = @Audience ORDER BY Position, Id");
  return { jsonBody: result.recordset.map(shape) };
});

// Body: { list, audience, tabs: [{ name, settings }] }  Replaces that set.
// People who already have their tabs keep them until they reset.
endpoint("saveDefaultTabs", { methods: ["PUT"], route: "manage/default-tabs", role: "admin", failMessage: "Could not save the default tabs" },
  async (request, context, user) => {
    const body = await readJson(request);
    const list = listKey(body.list);
    const audience = audienceKey(body.audience);
    if (!Array.isArray(body.tabs) || !body.tabs.length) throw new HttpError(400, "Keep at least one tab");
    if (body.tabs.length > MAX_TABS) throw new HttpError(400, `Up to ${MAX_TABS} tabs`);
    const tabs = body.tabs.map((t) => ({ name: requiredText(t?.name, "Tab name", 100), settings: settingsText(t?.settings) }));
    await withTransaction(async (tx) => {
      await tx.request().input("List", sql.NVarChar(20), list).input("Audience", sql.NVarChar(20), audience)
        .query("DELETE FROM dbo.DefaultTabs WHERE ListKey = @List AND Audience = @Audience");
      for (const [index, tab] of tabs.entries()) {
        await tx.request()
          .input("List", sql.NVarChar(20), list)
          .input("Audience", sql.NVarChar(20), audience)
          .input("Name", sql.NVarChar(100), tab.name)
          .input("Settings", sql.NVarChar(2000), tab.settings)
          .input("Position", sql.Int, index + 1)
          .query("INSERT INTO dbo.DefaultTabs (ListKey, Audience, Name, Settings, Position) VALUES (@List, @Audience, @Name, @Settings, @Position)");
      }
      await logChange(tx, { area: "settings", entityId: null, section: "defaultTabs", actorId: user.Id, summary: `Default tabs saved: ${LIST_NAMES[list]}, ${AUDIENCE_NAMES[audience]}` });
    });
    const pool = await getConnection();
    const result = await pool.request().input("List", sql.NVarChar(20), list).input("Audience", sql.NVarChar(20), audience)
      .query("SELECT Id, Name, Settings, Position FROM dbo.DefaultTabs WHERE ListKey = @List AND Audience = @Audience ORDER BY Position, Id");
    return { jsonBody: result.recordset.map(shape) };
  }
);

