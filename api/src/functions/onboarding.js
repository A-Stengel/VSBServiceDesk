const { endpoint, readJson, requiredId, optionalId, requiredText, isUniqueViolation } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { logChange } = require("../shared/changelog");
const { IMIS_KINDS } = require("../shared/access");
const { loadSet, readSet, saveSet, addTitle } = require("../shared/onboarding");

// Onboarding defaults by job title. Admins set them in Settings > Onboarding
// defaults; the Onboarding form reads them to fill itself in.

async function titleOf(db, id) {
  const row = (await db.request().input("Id", sql.Int, id).query(`
    SELECT jt.Id, jt.Name, jt.DepartmentId, d.Name AS DepartmentName
    FROM dbo.JobTitles jt JOIN dbo.Departments d ON d.Id = jt.DepartmentId
    WHERE jt.Id = @Id
  `)).recordset[0];
  if (!row) throw new HttpError(404, "That job title doesn't exist");
  return row;
}

// The defaults for one title (?jobTitleId=), or the general defaults. The
// form only needs what's picked and what's required: the exact licenses and
// iMIS access are for technicians and admins (who edit the defaults).
endpoint("onboardingDefaults", { methods: ["GET"], route: "onboarding/defaults" }, async (request, context, user) => {
  const jobTitleId = optionalId(request.query.get("jobTitleId"), "Job title");
  const pool = await getConnection();
  if (jobTitleId) await titleOf(pool, jobTitleId);
  const set = await loadSet(pool, jobTitleId);
  if (!user.IsTechnician && !user.IsAdmin) {
    set.apps = set.apps.map((a) => ({ applicationId: a.applicationId, isRequired: a.isRequired }));
    set.access = set.access.filter((a) => !IMIS_KINDS.includes(a.kind));
  }
  return { jsonBody: set };
});

// Body: { jobTitleId (empty for the general defaults), items, apps, access }
endpoint(
  "saveOnboardingDefaults",
  { methods: ["PUT"], route: "manage/onboarding", role: "admin", failMessage: "Could not save the defaults" },
  async (request, context, user) => {
    const body = await readJson(request);
    const jobTitleId = optionalId(body.jobTitleId, "Job title");
    const set = readSet(body);
    await withTransaction(async (tx) => {
      const title = jobTitleId ? await titleOf(tx, jobTitleId) : null;
      await saveSet(tx, jobTitleId, set);
      const what = title ? `${title.Name} (${title.DepartmentName})` : "the general defaults";
      const counts = `${set.items.length} equipment, ${set.apps.length} software, ${set.access.length} access`;
      await logChange(tx, { area: "settings", section: "onboarding", entityId: jobTitleId, actorId: user.Id, summary: `Saved the onboarding defaults for ${what}: ${counts}` });
    });
    return { jsonBody: { ok: true } };
  }
);

// A new job title for a department, starting from the general defaults.
// Renaming and turning titles off use the Settings lists (jobTitles).
// Body: { departmentId, name }
endpoint(
  "addJobTitle",
  { methods: ["POST"], route: "manage/job-titles", role: "admin", failMessage: "Could not add the job title" },
  async (request, context, user) => {
    const body = await readJson(request);
    const departmentId = requiredId(body.departmentId, "Department");
    const name = requiredText(body.name, "Job title", 150);
    let id;
    try {
      id = await withTransaction(async (tx) => {
        const dept = (await tx.request().input("Id", sql.Int, departmentId).query("SELECT Name FROM dbo.Departments WHERE Id = @Id")).recordset[0];
        if (!dept) throw new HttpError(400, "That department doesn't exist");
        const newId = await addTitle(tx, departmentId, name);
        await logChange(tx, { area: "settings", section: "onboarding", entityId: newId, actorId: user.Id, summary: `Added the job title ${name} to ${dept.Name}` });
        return newId;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, `${name} is already a job title in that department`);
      throw error;
    }
    return { status: 201, jsonBody: { id } };
  }
);
