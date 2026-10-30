const { endpoint } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { listHealth } = require("../shared/health");
const { processMessage } = require("../shared/inbound");
const { formatNumber } = require("../shared/tickets");
const { activeMailbox } = require("../shared/mailer");

// The Email status line in Settings > Email: the last mailbox check, the
// last error of each job, and how much mail went out today.
endpoint("emailStatus", { methods: ["GET"], route: "manage/email-status", role: "admin" }, async () => {
  const settings = await getSettings();
  const pool = await getConnection();
  const counts = await pool.request().query(`
    SELECT
      (SELECT COUNT(*) FROM dbo.OutboundEmails WHERE SentAt >= DATEADD(HOUR, -24, SYSUTCDATETIME()) AND Error IS NULL) AS SentToday,
      (SELECT COUNT(*) FROM dbo.OutboundEmails WHERE SentAt >= DATEADD(HOUR, -24, SYSUTCDATETIME()) AND Error IS NOT NULL) AS FailedToday,
      (SELECT COUNT(*) FROM dbo.InboundEmails WHERE ReceivedAt >= DATEADD(HOUR, -24, SYSUTCDATETIME()) AND Outcome IN ('ticket', 'reply')) AS ReadToday,
      (SELECT COUNT(*) FROM dbo.InboundEmails WHERE Outcome IN ('held', 'failed')) AS Held
  `);
  return {
    jsonBody: {
      mailbox: activeMailbox(settings) || "",
      maintenance: settings.MaintenanceMode === "On",
      jobs: await listHealth(pool),
      ...counts.recordset[0]
    }
  };
});

// Held mail: email from people the desk doesn't know yet (while "Create
// accounts for new senders" is off), and email that couldn't be handled.
// A technician accepts it (the sender's account is made and the email
// becomes a ticket or a reply) or dismisses it.
endpoint("heldMail", { methods: ["GET"], route: "mail/held", role: "technician" }, async () => {
  const pool = await getConnection();
  const result = await pool.request().query(`
    SELECT TOP (200) Id, ReceivedAt, Outcome, Detail, FromEmail, FromName, Subject, Preview, TicketId
    FROM dbo.InboundEmails
    WHERE Outcome IN ('held', 'failed')
    ORDER BY ReceivedAt DESC
  `);
  return { jsonBody: result.recordset.map((r) => ({ ...r, TicketNumber: r.TicketId ? formatNumber(r.TicketId) : null })) };
});

async function loadHeld(pool, id) {
  const row = (await pool.request().input("Id", sql.Int, id)
    .query("SELECT Id, Outcome, Mailbox, GraphMessageId, EmailMessageId FROM dbo.InboundEmails WHERE Id = @Id")).recordset[0];
  if (!row) throw new HttpError(404, "That email isn't in Held mail");
  if (row.Outcome !== "held" && row.Outcome !== "failed") throw new HttpError(400, "That email was already dealt with");
  return row;
}

async function decided(pool, id, user) {
  await pool.request().input("Id", sql.Int, id).input("By", sql.Int, user.Id)
    .query("UPDATE dbo.InboundEmails SET DecidedById = @By, DecidedAt = SYSUTCDATETIME() WHERE Id = @Id");
}

endpoint(
  "acceptHeldMail",
  { methods: ["POST"], route: "mail/held/{id:int}/accept", role: "technician", failMessage: "Could not accept the email" },
  async (request, context, user) => {
    const pool = await getConnection();
    const row = await loadHeld(pool, Number(request.params.id));
    let outcome;
    try {
      outcome = await processMessage(row.Mailbox, { id: row.GraphMessageId, internetMessageId: row.EmailMessageId }, { accept: true, inboundId: row.Id });
    } catch (error) {
      context.error(error);
      if (error.status === 404) throw new HttpError(400, "That email is no longer in the mailbox, so it can't be read again");
      throw new HttpError(500, `Could not read the email: ${String(error.message).slice(0, 200)}`);
    }
    await decided(pool, row.Id, user);
    const after = (await pool.request().input("Id", sql.Int, row.Id).query("SELECT TicketId, Outcome FROM dbo.InboundEmails WHERE Id = @Id")).recordset[0];
    return { jsonBody: { outcome, ticketId: after?.TicketId || null } };
  }
);

endpoint(
  "dismissHeldMail",
  { methods: ["POST"], route: "mail/held/{id:int}/dismiss", role: "technician", failMessage: "Could not dismiss the email" },
  async (request, context, user) => {
    const pool = await getConnection();
    const row = await loadHeld(pool, Number(request.params.id));
    await pool.request().input("Id", sql.Int, row.Id).query("UPDATE dbo.InboundEmails SET Outcome = 'dismissed' WHERE Id = @Id");
    await decided(pool, row.Id, user);
    return { jsonBody: { ok: true } };
  }
);
