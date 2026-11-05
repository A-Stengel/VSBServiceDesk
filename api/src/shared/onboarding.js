const { sql } = require("./db");
const { HttpError } = require("./errors");
const { ACCESS_KINDS, readAccess } = require("./access");

// Onboarding defaults: what a job title gets, in dbo.OnboardingDefaults.
// A set is
//   items   [{ inventoryItemId, isRequired }]
//   apps    [{ applicationId, softwareId, isRequired }]  softwareId: the exact license
//   access  [{ kind, refId, text, level }]                mailboxes, printers, iMIS...
// The general defaults (jobTitleId null) are used when no title is picked,
// and are where a title added from the form starts.

async function loadSet(db, jobTitleId) {
  const req = db.request();
  let where = "d.JobTitleId IS NULL";
  if (jobTitleId) {
    req.input("JobTitleId", sql.Int, jobTitleId);
    where = "d.JobTitleId = @JobTitleId";
  }
  const rows = (await req.query(`
    SELECT d.Kind, d.RefId, d.SoftwareId, d.[Level], d.[Text], d.IsRequired
    FROM dbo.OnboardingDefaults d
    LEFT JOIN dbo.InventoryItems i ON d.Kind = 'item' AND i.Id = d.RefId
    LEFT JOIN dbo.Applications a ON d.Kind = 'app' AND a.Id = d.RefId
    WHERE ${where}
      AND (d.Kind <> 'item' OR (i.IsActive = 1 AND i.IsDeleted = 0))
      AND (d.Kind <> 'app' OR a.IsActive = 1)
    ORDER BY d.SortOrder, d.Id
  `)).recordset;
  const set = { items: [], apps: [], access: [] };
  for (const r of rows) {
    if (r.Kind === "item") set.items.push({ inventoryItemId: r.RefId, isRequired: !!r.IsRequired });
    else if (r.Kind === "app") set.apps.push({ applicationId: r.RefId, softwareId: r.SoftwareId, isRequired: !!r.IsRequired });
    else set.access.push({ kind: r.Kind, refId: r.RefId, text: r.Text, level: r.Level });
  }
  return set;
}

const idOf = (value, field) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${field} is missing`);
  return n;
};

// Checks a set sent from Settings. Throws on anything that doesn't fit.
function readSet(value) {
  if (!value || typeof value !== "object") throw new HttpError(400, "Send the defaults to save");
  const list = (v, field) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new HttpError(400, `${field} must be a list`);
    return v;
  };
  const items = [];
  for (const i of list(value.items, "Equipment")) {
    const inventoryItemId = idOf(i.inventoryItemId, "Equipment");
    if (!items.some((x) => x.inventoryItemId === inventoryItemId)) items.push({ inventoryItemId, isRequired: !!i.isRequired });
  }
  const apps = [];
  for (const a of list(value.apps, "Software")) {
    const applicationId = idOf(a.applicationId, "Software");
    const softwareId = a.softwareId ? idOf(a.softwareId, "License") : null;
    if (!apps.some((x) => x.applicationId === applicationId)) apps.push({ applicationId, softwareId, isRequired: !!a.isRequired });
  }
  const access = [];
  for (const entry of list(value.access, "Access")) {
    const e = readAccess(entry);
    const same = access.some((x) => x.kind === e.kind && (ACCESS_KINDS[e.kind].text ? x.text.toLowerCase() === e.text.toLowerCase() : x.refId === e.refId));
    if (!same) access.push(e);
  }
  if (items.length + apps.length + access.length > 500) throw new HttpError(400, "That's too many defaults for one title");
  return { items, apps, access };
}

// Checks that every license belongs to its software, then replaces the
// title's rows.
async function saveSet(tx, jobTitleId, set) {
  for (const a of set.apps) {
    const app = (await tx.request().input("Id", sql.Int, a.applicationId).query("SELECT Id FROM dbo.Applications WHERE Id = @Id")).recordset[0];
    if (!app) throw new HttpError(400, "One of the software choices no longer exists");
    if (a.softwareId) {
      const lic = (await tx.request().input("Id", sql.Int, a.softwareId).input("AppId", sql.Int, a.applicationId)
        .query("SELECT Id FROM dbo.Software WHERE Id = @Id AND ApplicationId = @AppId AND IsDeleted = 0")).recordset[0];
      if (!lic) throw new HttpError(400, "A license picked isn't linked to that software. Link it on the Inventory page.");
    }
  }
  const del = tx.request();
  if (jobTitleId) del.input("JobTitleId", sql.Int, jobTitleId);
  await del.query(`DELETE FROM dbo.OnboardingDefaults WHERE ${jobTitleId ? "JobTitleId = @JobTitleId" : "JobTitleId IS NULL"}`);
  let order = 10;
  const insert = (row) => tx.request()
    .input("JobTitleId", sql.Int, jobTitleId || null)
    .input("Kind", sql.NVarChar(20), row.kind)
    .input("RefId", sql.Int, row.refId ?? null)
    .input("SoftwareId", sql.Int, row.softwareId ?? null)
    .input("Level", sql.TinyInt, row.level ?? null)
    .input("Text", sql.NVarChar(200), row.text ?? null)
    .input("IsRequired", sql.Bit, !!row.isRequired)
    .input("SortOrder", sql.Int, (order += 10))
    .query(`
      INSERT INTO dbo.OnboardingDefaults (JobTitleId, Kind, RefId, SoftwareId, [Level], [Text], IsRequired, SortOrder)
      VALUES (@JobTitleId, @Kind, @RefId, @SoftwareId, @Level, @Text, @IsRequired, @SortOrder)
    `);
  for (const i of set.items) await insert({ kind: "item", refId: i.inventoryItemId, isRequired: i.isRequired });
  for (const a of set.apps) await insert({ kind: "app", refId: a.applicationId, softwareId: a.softwareId, isRequired: a.isRequired });
  for (const e of set.access) await insert(e);
}

// Copies the general defaults to a new title, so it starts from them.
async function copyGeneralTo(tx, jobTitleId) {
  await tx.request().input("JobTitleId", sql.Int, jobTitleId).query(`
    INSERT INTO dbo.OnboardingDefaults (JobTitleId, Kind, RefId, SoftwareId, [Level], [Text], IsRequired, SortOrder)
    SELECT @JobTitleId, Kind, RefId, SoftwareId, [Level], [Text], IsRequired, SortOrder
    FROM dbo.OnboardingDefaults WHERE JobTitleId IS NULL
  `);
}

// The license a piece of software gets when the defaults don't name one:
// its first active license.
async function firstLicense(db, applicationId) {
  const row = (await db.request().input("AppId", sql.Int, applicationId).query(`
    SELECT TOP (1) Id FROM dbo.Software
    WHERE ApplicationId = @AppId AND IsActive = 1 AND IsDeleted = 0
    ORDER BY SortOrder, Name
  `)).recordset[0];
  return row ? row.Id : null;
}

// Adds a job title to a department, starting from the general defaults.
// Returns its id.
async function addTitle(tx, departmentId, name) {
  const row = (await tx.request()
    .input("DepartmentId", sql.Int, departmentId)
    .input("Name", sql.NVarChar(150), name)
    .query(`
      INSERT INTO dbo.JobTitles (DepartmentId, Name, SortOrder)
      OUTPUT INSERTED.Id
      SELECT @DepartmentId, @Name, COALESCE(MAX(SortOrder), 0) + 10 FROM dbo.JobTitles WHERE DepartmentId = @DepartmentId
    `)).recordset[0];
  await copyGeneralTo(tx, row.Id);
  return row.Id;
}

module.exports = { loadSet, readSet, saveSet, copyGeneralTo, firstLicense, addTitle };
