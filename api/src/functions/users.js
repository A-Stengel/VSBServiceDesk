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
const { USER_SELECT, isStaffEmail } = require("../shared/auth");
const { getSettings } = require("../shared/settings");
const { getHoldings } = require("../shared/holdings");
const { readItems, addTicketItem, assertSeats } = require("../shared/inventory");
const { logChange, listChanges } = require("../shared/changelog");
const { resetTabs } = require("../shared/tabs");
const { TICKET_SELECT, withNumber, recordEvents } = require("../shared/tickets");

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
    const userTypeId = optionalId(body.userTypeId, "User type") ||
      (isStaffEmail(settings, email) ? settings.StaffUserTypeId : settings.ExternalUserTypeId);
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

async function loadPerson(db, id) {
  const result = await db.request().input("Id", sql.Int, id).query(`${PEOPLE_SELECT} WHERE x.Id = @Id`);
  if (!result.recordset[0]) throw new HttpError(404, "Person not found");
  return shape(result.recordset[0]);
}

// The person page: who they are, what they hold, their tickets and their
// history.
endpoint("getUser", { methods: ["GET"], route: "users/{id:int}", role: "technician" }, async (request) => {
  const id = Number(request.params.id);
  const pool = await getConnection();
  const person = await loadPerson(pool, id);
  const tickets = await pool.request().input("Id", sql.Int, id).query(`
    SELECT TOP (50) * FROM (${TICKET_SELECT} WHERE t.RequesterId = @Id OR t.ForUserId = @Id) x
    ORDER BY x.IsClosed, x.CreatedAt DESC
  `);
  return {
    jsonBody: {
      person,
      holdings: await getHoldings(pool, id),
      tickets: tickets.recordset.map(({ Description, ...t }) => withNumber(t)),
      history: await listChanges(pool, { area: "person", entityId: id, top: 50 })
    }
  };
});

// Technicians hand something straight to a person from their page.
// Body: { inventoryItemId, quantity } or { softwareId }
endpoint(
  "assignHolding",
  { methods: ["POST"], route: "users/{id:int}/holdings", role: "technician", failMessage: "Could not assign it" },
  async (request, context, me) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    await withTransaction(async (tx) => {
      const person = await loadPerson(tx, id);
      if (!person.IsActive) throw new HttpError(400, "This account is off. Start onboarding to bring them back first.");
      let summary;
      if (body.softwareId) {
        const softwareId = optionalId(body.softwareId, "Software");
        const seat = await tx.request().input("UserId", sql.Int, id).input("SoftwareId", sql.Int, softwareId).query(`
          INSERT INTO dbo.LicenseAssignments (UserId, SoftwareId, CostPerSeatAtTime)
          OUTPUT INSERTED.Id
          SELECT @UserId, Id, CostPerSeat FROM dbo.Software WHERE Id = @SoftwareId AND IsActive = 1
        `);
        if (!seat.recordset.length) throw new HttpError(400, "That software doesn't exist");
        await assertSeats(tx, [softwareId]);
        const name = await tx.request().input("Id", sql.Int, softwareId).query("SELECT Name FROM dbo.Software WHERE Id = @Id");
        summary = `Assigned a ${name.recordset[0].Name} seat`;
      } else {
        const [item] = readItems([body]);
        const added = await addTicketItem(tx, null, item.inventoryItemId, item.quantity, id);
        summary = `Handed out ${added.name}${item.quantity > 1 ? ` (x${item.quantity})` : ""}`;
      }
      await logChange(tx, { area: "person", entityId: id, actorId: me.Id, summary });
    });
    return { status: 201, jsonBody: { ok: true } };
  }
);

// Body: { ticketItemId } (equipment comes back) or { seatId } (seat removed)
endpoint(
  "returnHolding",
  { methods: ["POST"], route: "users/{id:int}/holdings/return", role: "technician", failMessage: "Could not save it" },
  async (request, context, me) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    await withTransaction(async (tx) => {
      const holdings = await getHoldings(tx, id);
      let summary;
      if (body.seatId) {
        const seat = holdings.seats.find((s) => s.Id === Number(body.seatId));
        if (!seat) throw new HttpError(400, "They don't hold that seat any more");
        await tx.request().input("Id", sql.Int, seat.Id).query("UPDATE dbo.LicenseAssignments SET RemovedAt = SYSUTCDATETIME() WHERE Id = @Id");
        summary = `Removed their ${seat.Name} seat`;
      } else {
        const item = holdings.items.find((i) => i.Id === Number(body.ticketItemId));
        if (!item) throw new HttpError(400, "They don't hold that item any more");
        await tx.request().input("Id", sql.Int, item.Id).query("UPDATE dbo.TicketItems SET ReturnedAt = SYSUTCDATETIME() WHERE Id = @Id");
        summary = `${item.Name}${item.Quantity > 1 ? ` (x${item.Quantity})` : ""} returned`;
        if (item.TicketId) await recordEvents(tx, item.TicketId, me.Id, [{ field: "Item returned", newValue: item.Name }]);
      }
      await logChange(tx, { area: "person", entityId: id, actorId: me.Id, summary });
    });
    return { jsonBody: { ok: true } };
  }
);

// Technicians set someone's department. Admins also change their role (staff
// accounts only), the departments they manage, their type and name. An
// account is turned off and on by closing an Off Boarding or Onboarding
// ticket, not here.
endpoint(
  "updateUser",
  { methods: ["PATCH"], route: "users/{id:int}", role: "technician", failMessage: "Could not save the person" },
  async (request, context, me) => {
    const id = Number(request.params.id);
    const body = await readJson(request);
    const adminOnly = ["roleId", "userTypeId", "firstName", "lastName", "displayName", "isActive", "managedDepartmentIds"];
    if (!me.IsAdmin && adminOnly.some((key) => key in body)) throw new HttpError(403, "Only admins can change that");
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

    const settings = await getSettings();
    try {
      await withTransaction(async (tx) => {
        const before = await loadPerson(tx, id);
        if ("roleId" in body && before.UserTypeId !== settings.StaffUserTypeId) {
          throw new HttpError(400, "Only staff accounts can have a role. Outside people and shared mailboxes use email only.");
        }
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
        const after = await loadPerson(tx, id);
        const names = async (ids) => {
          if (!ids.length) return "none";
          const rows = await tx.request().query(`SELECT Name FROM dbo.Departments WHERE Id IN (${ids.map(Number).join(",")}) ORDER BY Name`);
          return rows.recordset.map((r) => r.Name).join(", ");
        };
        const notes = [];
        if (before.RoleName !== after.RoleName) notes.push(`Role: ${before.RoleName || "none"} to ${after.RoleName || "none"}`);
        if (before.DepartmentName !== after.DepartmentName) notes.push(`Department: ${before.DepartmentName || "none"} to ${after.DepartmentName || "none"}`);
        if (before.UserTypeName !== after.UserTypeName) notes.push(`Account type: ${before.UserTypeName} to ${after.UserTypeName}`);
        if (before.DisplayName !== after.DisplayName) notes.push(`Name: ${before.DisplayName} to ${after.DisplayName}`);
        if (before.IsActive !== after.IsActive) notes.push(after.IsActive ? "Account turned on" : "Account turned off");
        const sameManaged = before.ManagedDepartmentIds.length === after.ManagedDepartmentIds.length &&
          before.ManagedDepartmentIds.every((d) => after.ManagedDepartmentIds.includes(d));
        if (!sameManaged) notes.push(`Manager of: ${await names(after.ManagedDepartmentIds)}`);
        for (const summary of notes) await logChange(tx, { area: "person", entityId: id, actorId: me.Id, summary });
        // Moving to or from Technician (or Event Manager) gives them that
        // group's default tabs the next time they open each list.
        if (!!before.IsTechnician !== !!after.IsTechnician || !!before.IsEventManager !== !!after.IsEventManager) {
          await resetTabs(tx, id);
        }
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new HttpError(400, "That role, department or user type doesn't exist");
      throw error;
    }
    const pool = await getConnection();
    return { jsonBody: await loadPerson(pool, id) };
  }
);
