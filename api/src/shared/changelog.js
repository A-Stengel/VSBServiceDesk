const { sql } = require("./db");

// Same as tickets.js personName; kept here so the two modules don't load each other.
const personName = (alias) => `COALESCE(NULLIF(${alias}.DisplayName, ''), CONCAT(${alias}.FirstName, ' ', ${alias}.LastName))`;

// One line of history in dbo.ChangeLog. Area is 'settings', 'inventory' or
// 'person'; Section names the Settings section or the Inventory tab;
// EntityId is the person (or item) the line is about.
async function logChange(db, { area, section = null, entityId = null, actorId = null, summary }) {
  await db
    .request()
    .input("Area", sql.NVarChar(20), area)
    .input("Section", sql.NVarChar(50), section)
    .input("EntityId", sql.Int, entityId)
    .input("ActorId", sql.Int, actorId)
    .input("Summary", sql.NVarChar(400), String(summary).slice(0, 400))
    .query(`
      INSERT INTO dbo.ChangeLog (Area, Section, EntityId, ActorId, Summary)
      VALUES (@Area, @Section, @EntityId, @ActorId, @Summary)
    `);
}

// The newest history lines first. Section can be one section or a list. Leave
// section or entityId out to get every line in the area.
async function listChanges(db, { area, section, entityId, top = 100 }) {
  const request = db.request().input("Area", sql.NVarChar(20), area).input("Top", sql.Int, top);
  const where = ["c.Area = @Area"];
  if (section !== undefined) {
    const sections = Array.isArray(section) ? section : [section];
    where.push(`c.Section IN (${sections.map((_, i) => `@Section${i}`).join(", ")})`);
    sections.forEach((s, i) => request.input(`Section${i}`, sql.NVarChar(50), s));
  }
  if (entityId !== undefined) {
    where.push("c.EntityId = @EntityId");
    request.input("EntityId", sql.Int, entityId);
  }
  const result = await request.query(`
    SELECT TOP (@Top) c.Id, c.Section, c.EntityId, c.Summary, c.[At],
           CASE WHEN u.Id IS NULL THEN N'System' ELSE ${personName("u")} END AS ActorName
    FROM dbo.ChangeLog c
    LEFT JOIN dbo.Users u ON u.Id = c.ActorId
    WHERE ${where.join(" AND ")}
    ORDER BY c.[At] DESC, c.Id DESC
  `);
  return result.recordset;
}

module.exports = { logChange, listChanges };
