const { app } = require("@azure/functions");
const { getSettings, isOn } = require("../shared/settings");
const { recordRun, getMarker, setMarker } = require("../shared/health");
const { checkMailbox } = require("../shared/inbound");
const { getConnection, sql } = require("../shared/db");

// Reads the desk's mailbox (the testing mailbox in maintenance mode) every
// "Minutes between mailbox checks", while either "Create tickets from new
// emails" or "Add replies to existing tickets" is on. See shared/inbound.js.
app.timer("checkMailbox", {
  schedule: "0 * * * * *", // wakes every minute; checks on the set interval
  handler: async (timer, context) => {
    const settings = await getSettings();
    if (!isOn(settings, "InCreateTickets") && !isOn(settings, "InAddReplies")) return;
    const every = Math.max(1, settings.MailboxCheckMinutes || 2);
    const pool = await getConnection();
    const last = (await pool.request().input("Name", sql.NVarChar(50), "mailbox")
      .query("SELECT LastRunAt FROM dbo.SystemHealth WHERE Name = @Name")).recordset[0]?.LastRunAt;
    if (last && Date.now() - new Date(last).getTime() < every * 60 * 1000 - 5000) return;
    try {
      const { counts, failures } = await checkMailbox({ getMarker, setMarker });
      const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
      if (summary) context.log(`Mailbox check: ${summary}`);
      await recordRun("mailbox", failures.length ? new Error(`${failures.length} email(s) could not be handled: ${failures[0]}`) : null, context);
    } catch (error) {
      context.error(error);
      await recordRun("mailbox", error, context);
    }
  }
});
