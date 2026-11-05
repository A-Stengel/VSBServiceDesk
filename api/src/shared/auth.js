const { getConnection, sql } = require("./db");
const { HttpError } = require("./errors");
const { getSettings } = require("./settings");

// The Static Web App signs people in and forwards who they are to the linked
// Function App in the x-ms-client-principal header (base64 JSON). The Function
// App only accepts requests that come through the Static Web App, so the header
// can be trusted.
function getPrincipal(request) {
  const header = request.headers.get("x-ms-client-principal");
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function claim(principal, ...types) {
  for (const type of types) {
    const match = (principal.claims || []).find((c) => c.typ === type);
    if (match?.val) return match.val;
  }
  return undefined;
}

// The staff email domains (the StaffEmailDomains setting, comma separated).
// The ALLOWED_EMAIL_DOMAINS app setting is only a fallback for a database
// that doesn't have the setting yet.
function staffDomains(settings) {
  return String(settings.StaffEmailDomains || process.env.ALLOWED_EMAIL_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

const isStaffEmail = (settings, email) => staffDomains(settings).includes(email.split("@")[1]);

function namesFor(principal, email) {
  const first = claim(principal, "given_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname");
  const last = claim(principal, "family_name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname");
  const full = claim(principal, "name");
  if (first || last) return { firstName: first || "", lastName: last || "", displayName: full || `${first || ""} ${last || ""}`.trim() };
  if (full && full.includes(" ")) {
    const [firstName, ...rest] = full.split(" ");
    return { firstName, lastName: rest.join(" "), displayName: full };
  }
  const local = email.split("@")[0];
  return { firstName: local, lastName: "", displayName: full || local };
}

const USER_SELECT = `
  SELECT u.Id, u.FirstName, u.LastName, u.Email,
         COALESCE(NULLIF(u.DisplayName, ''), CONCAT(u.FirstName, ' ', u.LastName)) AS DisplayName,
         u.DepartmentId, u.UserTypeId, u.RoleId, u.IsActive,
         r.Name AS RoleName,
         CAST(COALESCE(r.IsTechnician, 0) | COALESCE(r.IsAdmin, 0) AS BIT) AS IsTechnician,
         CAST(COALESCE(r.IsAdmin, 0) AS BIT) AS IsAdmin,
         CAST(COALESCE(r.IsEventManager, 0) | COALESCE(r.IsTechnician, 0) | COALESCE(r.IsAdmin, 0) AS BIT) AS IsEventManager
  FROM dbo.Users u
  LEFT JOIN dbo.Roles r ON r.Id = u.RoleId
`;

async function findUserByEmail(db, email) {
  const result = await db.request().input("Email", sql.NVarChar(320), email).query(`${USER_SELECT} WHERE u.Email = @Email`);
  return result.recordset[0];
}

// Returns the signed-in person's dbo.Users row, creating it (as Staff with the
// default role) the first time they sign in.
async function getCurrentUser(request) {
  const principal = getPrincipal(request);
  const email = principal?.userDetails?.trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpError(401, "Please sign in");
  const settings = await getSettings();
  if (!isStaffEmail(settings, email)) {
    throw new HttpError(403, `Only ${settings.OrganizationName ? `${settings.OrganizationName} ` : ""}staff accounts can use this site`);
  }

  const pool = await getConnection();
  let user = await findUserByEmail(pool, email);

  if (!user) {
    const { firstName, lastName, displayName } = namesFor(principal, email);
    try {
      await pool
        .request()
        .input("FirstName", sql.NVarChar(100), firstName)
        .input("LastName", sql.NVarChar(100), lastName)
        .input("DisplayName", sql.NVarChar(200), displayName)
        .input("Email", sql.NVarChar(320), email)
        .input("UserTypeId", sql.Int, settings.StaffUserTypeId)
        .input("RoleId", sql.Int, settings.DefaultRoleId)
        .query(`
          INSERT INTO dbo.Users (FirstName, LastName, DisplayName, Email, UserTypeId, RoleId)
          VALUES (@FirstName, @LastName, @DisplayName, @Email, @UserTypeId, @RoleId)
        `);
    } catch (error) {
      // Two first requests raced and the other one created the row
      if (error.number !== 2627 && error.number !== 2601) throw error;
    }
    user = await findUserByEmail(pool, email);
  }

  if (!user.IsActive) throw new HttpError(403, "Your account has been deactivated");
  // The departments they manage (they can see and reply on those people's
  // tickets) and whether their "Show my departments' tickets" switch is on.
  const managed = await pool.request().input("Id", sql.Int, user.Id).query(`
    SELECT (SELECT STRING_AGG(CAST(m.DepartmentId AS NVARCHAR(20)), ',') FROM dbo.DepartmentManagers m WHERE m.UserId = u.Id) AS Managed,
           u.ShowDepartmentTickets
    FROM dbo.Users u WHERE u.Id = @Id
  `);
  const row = managed.recordset[0] || {};
  user.ManagedDepartmentIds = row.Managed ? row.Managed.split(",").map(Number) : [];
  user.ShowDepartmentTickets = !!row.ShowDepartmentTickets;
  return user;
}

module.exports = { getCurrentUser, USER_SELECT, isStaffEmail };
