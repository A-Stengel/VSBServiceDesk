const { endpoint, readJson, requiredText } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { personName } = require("../shared/tickets");

// Saved list views: the tab, search, filters and sort someone saved on a list
// (tickets, events or people). An admin can share a ticket view with every
// technician; shared views show as "Team:" tabs.

const LISTS = ["tickets", "events", "people"];

function listKey(value) {
  if (!LISTS.includes(value)) throw new HttpError(400, "Unknown list");
  return value;
}

const VIEW_SELECT = `
  SELECT v.Id, v.OwnerId, ${personName("u")} AS OwnerName, v.ListKey, v.Name, v.Settings, v.IsShared, v.CreatedAt
  FROM dbo.SavedViews v
  JOIN dbo.Users u ON u.Id = v.OwnerId
`;

const shape = (row) => {
  let settings = {};
  try {
    settings = JSON.parse(row.Settings);
  } catch {
    // a damaged view just opens with no filters
  }
  return { ...row, Settings: settings };
};

// ?list=tickets  Your own views, plus the team's shared views for technicians.
endpoint("listViews", { methods: ["GET"], route: "views" }, async (request, context, user) => {
  const list = listKey(request.query.get("list"));
  const pool = await getConnection();
  const result = await pool
    .request()
    .input("Me", sql.Int, user.Id)
    .input("List", sql.NVarChar(20), list)
    .input("Tech", sql.Bit, !!user.IsTechnician)
    .query(`${VIEW_SELECT} WHERE v.ListKey = @List AND (v.OwnerId = @Me OR (v.IsShared = 1 AND @Tech = 1)) ORDER BY v.IsShared DESC, v.Name`);
  return { jsonBody: result.recordset.map(shape) };
});

// Body: { list, name, settings, isShared }
endpoint("createView", { methods: ["POST"], route: "views", failMessage: "Could not save the view" }, async (request, context, user) => {
  const body = await readJson(request);
  const list = listKey(body.list);
  const name = requiredText(body.name, "View name", 100);
  const settings = JSON.stringify(body.settings ?? {});
  if (settings.length > 2000) throw new HttpError(400, "That view has too many filters to save");
  const isShared = !!body.isShared;
  if (isShared && !user.IsAdmin) throw new HttpError(403, "Only admins can share a view with the team");
  if (isShared && list !== "tickets") throw new HttpError(400, "Only ticket views can be shared with the team");
  if (list === "people" && !user.IsTechnician) {
    throw new HttpError(403, "Only technicians can save people views");
  }
  const pool = await getConnection();
  const created = await pool
    .request()
    .input("Me", sql.Int, user.Id)
    .input("List", sql.NVarChar(20), list)
    .input("Name", sql.NVarChar(100), name)
    .input("Settings", sql.NVarChar(2000), settings)
    .input("IsShared", sql.Bit, isShared)
    .query(`
      INSERT INTO dbo.SavedViews (OwnerId, ListKey, Name, Settings, IsShared)
      OUTPUT INSERTED.Id
      VALUES (@Me, @List, @Name, @Settings, @IsShared)
    `);
  const row = await pool.request().input("Id", sql.Int, created.recordset[0].Id).query(`${VIEW_SELECT} WHERE v.Id = @Id`);
  return { status: 201, jsonBody: shape(row.recordset[0]) };
});

// Your own views; admins can also delete shared team views.
endpoint("deleteView", { methods: ["DELETE"], route: "views/{id:int}" }, async (request, context, user) => {
  const pool = await getConnection();
  const found = await pool.request().input("Id", sql.Int, Number(request.params.id)).query("SELECT OwnerId, IsShared FROM dbo.SavedViews WHERE Id = @Id");
  const view = found.recordset[0];
  if (!view) throw new HttpError(404, "View not found");
  if (view.OwnerId !== user.Id && !(view.IsShared && user.IsAdmin)) throw new HttpError(403, "You can only delete your own views");
  await pool.request().input("Id", sql.Int, Number(request.params.id)).query("DELETE FROM dbo.SavedViews WHERE Id = @Id");
  return { jsonBody: { ok: true } };
});

// Settings, Shared views: every team view, for admins to manage.
endpoint("sharedViews", { methods: ["GET"], route: "manage/shared-views", role: "admin" }, async () => {
  const pool = await getConnection();
  const result = await pool.request().query(`${VIEW_SELECT} WHERE v.IsShared = 1 ORDER BY v.Name`);
  return { jsonBody: result.recordset.map(shape) };
});
