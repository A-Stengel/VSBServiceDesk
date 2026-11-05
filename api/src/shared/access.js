const { sql } = require("./db");
const { HttpError } = require("./errors");

// Access a person can be given besides equipment and license seats: shared
// mailboxes, calendars and phone queues (typed text), printers, and iMIS
// module levels, roles and security groups. Onboarding defaults, checklist
// lines and dbo.PersonAccess all use these kinds.
const ACCESS_KINDS = {
  mailbox: { label: "Shared mailbox", text: true },
  calendar: { label: "Shared calendar", text: true },
  phone: { label: "Phone queue or line", text: true },
  printer: { label: "Printer", table: "dbo.Printers" },
  imisModule: { label: "iMIS module", table: "dbo.ImisModules", level: true },
  imisRole: { label: "iMIS role", table: "dbo.ImisRoles" },
  imisGroup: { label: "iMIS security group", table: "dbo.ImisGroups" }
};
const IMIS_KINDS = ["imisModule", "imisRole", "imisGroup"];

// The levels iMIS uses for each module. 7 isn't used in iMIS.
const IMIS_LEVELS = {
  0: "No Access",
  1: "Basic Display Only",
  2: "Reports",
  3: "Limited Entry/Edit",
  4: "Full Entry/Edit",
  5: "Table Maintenance",
  6: "Report Changes",
  8: "System Setup"
};
const levelName = (level) => `${level} - ${IMIS_LEVELS[level] || "Unknown"}`;

// Checks one access entry from a request: { kind, refId } or { kind, text },
// plus level for iMIS modules.
function readAccess(value) {
  if (!value || typeof value !== "object") throw new HttpError(400, "Say what access to give");
  const kind = ACCESS_KINDS[value.kind];
  if (!kind) throw new HttpError(400, "Unknown kind of access");
  if (kind.text) {
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (!text) throw new HttpError(400, `Type the ${kind.label.toLowerCase()}`);
    if (text.length > 200) throw new HttpError(400, `The ${kind.label.toLowerCase()} is too long`);
    return { kind: value.kind, refId: null, text, level: null };
  }
  const refId = Number(value.refId);
  if (!Number.isInteger(refId) || refId <= 0) throw new HttpError(400, `Pick the ${kind.label.toLowerCase()}`);
  let level = null;
  if (kind.level) {
    level = Number(value.level ?? 0);
    if (!(level in IMIS_LEVELS)) throw new HttpError(400, "Pick an iMIS level from 0 to 8");
  }
  return { kind: value.kind, refId, text: null, level };
}

// The name of what an entry points at, or the text typed. Throws when the
// printer or iMIS entry doesn't exist (or is turned off, unless allowOff).
async function accessName(db, entry, allowOff = false) {
  const kind = ACCESS_KINDS[entry.kind];
  if (kind.text) return entry.text;
  const row = (await db.request().input("Id", sql.Int, entry.refId)
    .query(`SELECT Name, IsActive FROM ${kind.table} WHERE Id = @Id${kind.table === "dbo.Printers" ? " AND IsDeleted = 0" : ""}`)).recordset[0];
  if (!row || (!row.IsActive && !allowOff)) throw new HttpError(400, `That ${kind.label.toLowerCase()} isn't available`);
  return row.Name;
}

// "Shared mailbox: finance@example.org", "iMIS module: Dues, 4 - Full Entry/Edit"
function accessLabel(entry, name) {
  const kind = ACCESS_KINDS[entry.kind];
  return `${kind.label}: ${name}${kind.level ? `, ${levelName(entry.level ?? 0)}` : ""}`;
}

// SQL that gives the name of what an access row points at. Alias is the
// table holding Kind, RefId and Text (as columns prefixed with "prefix").
function accessNameSql(alias, prefix = "") {
  return `CASE ${alias}.${prefix}Kind
    WHEN 'printer' THEN (SELECT x.Name FROM dbo.Printers x WHERE x.Id = ${alias}.${prefix}RefId)
    WHEN 'imisModule' THEN (SELECT x.Name FROM dbo.ImisModules x WHERE x.Id = ${alias}.${prefix}RefId)
    WHEN 'imisRole' THEN (SELECT x.Name FROM dbo.ImisRoles x WHERE x.Id = ${alias}.${prefix}RefId)
    WHEN 'imisGroup' THEN (SELECT x.Name FROM dbo.ImisGroups x WHERE x.Id = ${alias}.${prefix}RefId)
    ELSE ${alias}.${prefix}Text END`;
}

// Everything a person has been given and still has.
async function getAccessHoldings(db, personId) {
  const result = await db.request().input("UserId", sql.Int, personId).query(`
    SELECT pa.Id, pa.Kind, pa.RefId, pa.[Text], pa.[Level], pa.GrantedAt, pa.GrantedTicketId,
           ${accessNameSql("pa")} AS Name
    FROM dbo.PersonAccess pa
    WHERE pa.UserId = @UserId AND pa.RemovedAt IS NULL
    ORDER BY pa.Kind, Name
  `);
  return result.recordset.map((r) => ({ ...r, Label: accessLabel({ kind: r.Kind, level: r.Level }, r.Name) }));
}

// Gives a person access. Returns the new dbo.PersonAccess id.
async function grantAccess(db, personId, entry, ticketId = null) {
  const row = (await db.request()
    .input("UserId", sql.Int, personId)
    .input("Kind", sql.NVarChar(20), entry.kind)
    .input("RefId", sql.Int, entry.refId)
    .input("Text", sql.NVarChar(200), entry.text)
    .input("Level", sql.TinyInt, entry.level)
    .input("TicketId", sql.Int, ticketId)
    .query(`
      INSERT INTO dbo.PersonAccess (UserId, Kind, RefId, [Text], [Level], GrantedTicketId)
      OUTPUT INSERTED.Id
      VALUES (@UserId, @Kind, @RefId, @Text, @Level, @TicketId)
    `)).recordset[0];
  return row.Id;
}

module.exports = {
  ACCESS_KINDS,
  IMIS_KINDS,
  IMIS_LEVELS,
  levelName,
  readAccess,
  accessName,
  accessLabel,
  accessNameSql,
  getAccessHoldings,
  grantAccess
};
