const { endpoint, gateFor } = require("../shared/endpoint");
const { getSettings } = require("../shared/settings");

// Who is signed in, and what they can do. Gate says when the web app is
// closed to them ("maintenance" or "closed"), so the site shows that page.
endpoint("me", { methods: ["GET"], route: "me", open: true }, async (request, context, user) => {
  const settings = await getSettings();
  return { jsonBody: { ...user, Gate: gateFor(settings, user), MailboxAddress: settings.MailboxAddress || "" } };
});
