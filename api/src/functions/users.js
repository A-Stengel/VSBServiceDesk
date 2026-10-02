const {
  endpoint,
  readJson,
  optionalId,
  optionalText,
  requiredText,
  EMAIL_PATTERN,
  isUniqueViolation,
  isForeignKeyViolation
} = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { USER_SELECT } = require("../shared/auth");
const { getSettings } = require("../shared/settings");

const PEOPLE_SELECT = `
  SELECT x.*, ut.Name AS UserTypeName, d.Name AS DepartmentName,
         (SELECT STRING_AGG(CAST(m.DepartmentId AS NVARCHAR(20)), ',')
          FROM dbo.DepartmentManagers m WHERE m.UserId = x.Id) AS ManagedDepartmentIds
  FROM (${USER_SELECT}) x
  LEFT JOIN dbo.UserTypes ut ON ut.Id = x.UserTypeId
  LEFT JOIN dbo.Departments d ON d.Id = x.DepartmentId
`;

function shape(row) {
  return {
    ...row,
    ManagedDepartmentIds: row.ManagedDepartmentIds ? row.ManagedDepartmentIds.split(",").map(Number) : []
  };
}

// The People page and the technician pickers.
// ?search=text  ?technicians=1 (technicians and admins only)  ?includeInactive=1
endpoint("listUsers", { methods: ["GET"], route: "users", role: "technician" }, async (request) => {
  const search = (request.query.get("search") || "").trim().slice(0, 100);
  const techniciansOnly = request.query.get("technicians") === "1";
  const includeInactive = request.query.get("includeInactive") === "1";
  const where = [];
  if (search) where.push("(p.DisplayName LIKE @Search OR p.Email LIKE @Search)");
  if (techniciansOnly) where.push("p.IsTechnician = 1");
  if (!includeInactive) where.push("p.IsActive = 1");
  const pool = await getConnection();
  const result = await pool
    .request()
    .input("Search", sql.NVarChar(110), `%${search.replace(/[%_[]/g, "[$&]")}%`)
    .query(`SELECT TOP (500) * FROM (${PEOPLE_SELECT}) p ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY p.DisplayName`);
  return { jsonBody: result.recordset.map(shape) };
});

// Lets anyone signed in pick a colleague ("Who is it for?"). Staff only, and
// only the fields a picker needs.
endpoint("searchPeople", { methods: ["GET"], route: "people/search" }, async (request) => {
  const search = (request.query.get("q") || "").trim().slice(0, 100);
  if (search.length < 2) return { jsonBody: [] };
  const settings = await getSettings();
  const pool = await getConnection();
  const result = await pool
    .request()
    .input("Search", sql.NVarChar(110), `%${search.replace(/[%_[]/g, "[$&]")}%`)
    .input("StaffTypeId", sql.Int, settings.StaffUserTypeId)
    .query(`
      SELECT TOP (20) p.Id, p.DisplayName, p.Email, p.DepartmentName
      FROM (${PEOPLE_SELECT}) p
      WHERE p.IsActive = 1 AND p.UserTypeId = @StaffTypeId
        AND (p.DisplayName LIKE @Search OR p.Email LIKE @Search)
      ORDER BY p.DisplayName
    `);
  return { jsonBody: result.recordset };
});

// A technician adds a person (for example an outside caller) so a ticket can be
// logged for them.
endpoint(
  "createUser",
  { methods: ["POST"], route: "users", role: "technician", failMessage: "Could not add the person" },
  async (request) => {
    const body = await readJson(request);
    const email = requiredText(body.email, "Email", 320).toLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new HttpError(400, "Enter a valid email address");
    const firstName = requiredText(body.firstName, "First name", 100);
    const lastName = optionalText(body.lastName, "Last name", 100) || "";
    const settings = await getSettings();
    const domains = (process.env.ALLOWED_EMAIL_DOMAINS || "vsb.org").split(",").map((d) => d.trim().toLowerCase());
    const userTypeId = optionalId(body.userTypeId, "User type") ||
      (domains.includes(email.split("@")[1]) ? settings.StaffUserTypeId : settings.ExternalUserTypeId);
    const pool = await getConnection();
    try {
      const result = await pool
        .request()
        .input("FirstName", sql.NVarChar(100), firstName)
        .input("LastName", sql.NVarChar(100), lastName)
        .input("DisplayName", sql.NVarChar(200), `${firstName} ${lastName}`.trim())
        .input("Email", sql.NVarChar(320), email)
        .input("UserTypeId", sql.Int, userTypeId)
        .input("RoleId", sql.Int, settings.DefaultRoleId)
        .input("DepartmentId", sql.Int, optionalId(body.departmentId, "Department"))
        .query(`
          INSERT INTO dbo.Users (FirstName, LastName, DisplayName, Email, UserTypeId, RoleId, DepartmentId)
          OUTPUT INSERTED.Id
          VALUES (@FirstName, @LastName, @DisplayName, @Email, @UserTypeId, @RoleId, @DepartmentId)
        `);
      const created = await pool.request().input("Id", sql.Int, result.recordset[0].Id).query(`${PEOPLE_SELECT} WHERE x.Id = @Id`);
      return { status: 201, jsonBody: shape(created.recordset[0]) };
    } catch (error) {
      if (isUniqueViolation(error)) throw new HttpError(409, "Someone with that email already exists");
      if (isForeignKeyViolation(error)) throw new HttpError(400, "That department or user type doesn't exist");
      throw error;
    }
  }
);

// Admins change someone's role, department, the departments they manage,
// their type, name, or switch them off.
endpoint(
  "updateUser",
  { methods: ["PATCH"], route: "users/{id:int}", role: "admin", failMessage: "Could not save the person" },
  async (request, context, me) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    const sets = [];
    const inputs = [];
    const add = (column, type, value) => {
      inputs.push([column, type, value]);
      sets.push(`${column} = @${column}`);
    };
    if ("roleId" in body) add("RoleId", sql.Int, optionalId(body.roleId, "Role"));
    if ("departmentId" in body) add("DepartmentId", sql.Int, optionalId(body.departmentId, "Department"));
    if ("userTypeId" in body) add("UserTypeId", sql.Int, optionalId(body.userTypeId, "User type"));
    if ("firstName" in body) add("FirstName", sql.NVarChar(100), requiredText(body.firstName, "First name", 100));
    if ("lastName" in body) add("LastName", sql.NVarChar(100), optionalText(body.lastName, "Last name", 100) || "");
    if ("displayName" in body) add("DisplayName", sql.NVarChar(200), optionalText(body.displayName, "Display name", 200));
    if ("isActive" in body) add("IsActive", sql.Bit, !!body.isActive);
    if (id === me.Id && (("isActive" in body && !body.isActive) || "roleId" in body)) {
      throw new HttpError(400, "You can't change your own role or switch yourself off");
    }
    let managed;
    if ("managedDepartmentIds" in body) {
      if (!Array.isArray(body.managedDepartmentIds)) throw new HttpError(400, "Managed departments must be a list");
      managed = [...new Set(body.managedDepartmentIds.map((d) => optionalId(d, "Department")).filter(Boolean))];
    }

    try {
      await withTransaction(async (tx) => {
        if (sets.length) {
          const req = tx.request().input("Id", sql.Int, id);
          inputs.forEach(([column, type, value]) => req.input(column, type, value));
          const result = await req.query(`UPDATE dbo.Users SET ${sets.join(", ")} WHERE Id = @Id`);
          if (!result.rowsAffected[0]) throw new HttpError(404, "Person not found");
        }
        if (managed) {
          await tx.request().input("Id", sql.Int, id).query("DELETE FROM dbo.DepartmentManagers WHERE UserId = @Id");
          for (const departmentId of managed) {
            await tx
              .request()
              .input("Id", sql.Int, id)
              .input("DepartmentId", sql.Int, departmentId)
              .query("INSERT INTO dbo.DepartmentManagers (UserId, DepartmentId) VALUES (@Id, @DepartmentId)");
          }
        }
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new HttpError(400, "That role, department or user type doesn't exist");
      throw error;
    }
    const pool = await getConnection();
    const updated = await pool.request().input("Id", sql.Int, id).query(`${PEOPLE_SELECT} WHERE x.Id = @Id`);
    if (!updated.recordset[0]) throw new HttpError(404, "Person not found");
    return { jsonBody: shape(updated.recordset[0]) };
  }
);
