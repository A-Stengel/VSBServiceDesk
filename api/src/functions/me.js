const { endpoint, gateFor, readJson } = require("../shared/endpoint");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");

// Who is signed in, and what they can do. Gate says when the web app is
// closed to them ("maintenance" or "closed"), so the site shows that page.
endpoint("me", { methods: ["GET"], route: "me", open: true }, async (request, context, user) => {
  const settings = await getSettings();
  return { jsonBody: { ...user, Gate: gateFor(settings, user), MailboxAddress: settings.MailboxAddress || "" } };
});

// Body: { on }  The "Show my departments' tickets" switch on the ticket list,
// remembered for department managers.
endpoint("setDepartmentTickets", { methods: ["PUT"], route: "me/department-tickets" }, async (request, context, user) => {
  const body = await readJson(request);
  const pool = await getConnection();
  await pool.request().input("Id", sql.Int, user.Id).input("On", sql.Bit, !!body.on && user.ManagedDepartmentIds.length > 0)
    .query("UPDATE dbo.Users SET ShowDepartmentTickets = @On WHERE Id = @Id");
  return { jsonBody: { on: !!body.on && user.ManagedDepartmentIds.length > 0 } };
});
