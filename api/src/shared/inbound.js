const { getConnection, withTransaction, sql } = require("./db");
const { getSettings, isOn, addressList } = require("./settings");
const { USER_SELECT, isStaffEmail } = require("./auth");
const { graph } = require("./graph");
const { saveAttachments, finishRichText } = require("./attachments");
const { plainToRich, toPlain, hasContent } = require("./richtext");
const { loadTicket, setStatus, recordEvents, formatNumber } = require("./tickets");
const { activeMailbox } = require("./mailer");
const { ticketCreated, replyAdded } = require("./notify");

// Turns one email in the desk's mailbox into a reply on its ticket or a new
// ticket, as the Settings > Email > Incoming switches allow. The mailbox is
// only read: nothing is moved, deleted or marked as read. Every message is
// written to dbo.InboundEmails by its Internet message ID, so none is ever
// handled twice.

const MESSAGE_FIELDS = [
  "id", "internetMessageId", "subject", "from", "sender", "toRecipients", "ccRecipients", "receivedDateTime",
  "body", "uniqueBody", "bodyPreview", "hasAttachments", "internetMessageHeaders"
].join(",");

const header = (message, name) =>
  (message.internetMessageHeaders || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";

// Out-of-office replies, bounces and other mail written by a machine.
function isAutomatic(message) {
  const auto = header(message, "Auto-Submitted").toLowerCase();
  if (auto && auto !== "no") return true;
  if (/^(bulk|junk|auto_reply|list)$/i.test(header(message, "Precedence").trim())) return true;
  if (header(message, "X-Autoreply") || header(message, "X-Autorespond")) return true;
  if (/multipart\/report/i.test(header(message, "Content-Type"))) return true;
  const from = (message.from?.emailAddress?.address || "").toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|microsoftexchange[0-9a-f]*)@/.test(from)) return true;
  return /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery failed)\b/i.test(message.subject || "");
}

// "RE: FW: [EXT] Printer jam" becomes "Printer jam".
function cleanSubject(subject) {
  let text = String(subject || "").trim();
  for (;;) {
    const next = text.replace(/^\s*((re|fw|fwd|ext|external)\s*:|\[(ext|external)\])\s*/i, "");
    if (next === text) break;
    text = next;
  }
  return text.slice(0, 255) || "(no subject)";
}

// The ticket an email is about: "Ticket #0010023" (this app), "##0005854##"
// (the old desk, matched on the imported number too), or a reply to an
// email this app sent. A merged ticket hands over to the one it went into.
async function findTicket(db, message) {
  const subject = message.subject || "";
  let id = null;
  const ours = /Ticket #(\d{4,})/i.exec(subject);
  const old = /##(\d+)##/.exec(subject);
  if (ours) {
    id = (await db.request().input("Id", sql.Int, Number(ours[1])).query("SELECT Id FROM dbo.Tickets WHERE Id = @Id")).recordset[0]?.Id;
  }
  if (!id && old) {
    id = (await db.request().input("N", sql.Int, Number(old[1])).input("Text", sql.NVarChar(50), old[1]).query(`
      SELECT TOP (1) Id FROM dbo.Tickets
      WHERE LegacyId = @Text OR TRY_CAST(LegacyId AS INT) = @N OR Id = @N
      ORDER BY CASE WHEN LegacyId = @Text THEN 0 ELSE 1 END
    `)).recordset[0]?.Id;
  }
  if (!id) {
    const refs = `${header(message, "In-Reply-To")} ${header(message, "References")}`.match(/<[^>]+>/g) || [];
    for (const ref of refs.reverse()) {
      const found = await db.request().input("Ref", sql.NVarChar(400), ref).query(`
        SELECT TOP (1) TicketId FROM (
          SELECT TicketId FROM dbo.OutboundEmails WHERE InternetMessageId = @Ref AND TicketId IS NOT NULL
          UNION ALL SELECT TicketId FROM dbo.TicketConversations WHERE EmailMessageId = @Ref
          UNION ALL SELECT TicketId FROM dbo.InboundEmails WHERE EmailMessageId = @Ref AND TicketId IS NOT NULL
        ) x
      `);
      if (found.recordset[0]) {
        id = found.recordset[0].TicketId;
        break;
      }
    }
  }
  for (let hops = 0; id && hops < 10; hops += 1) {
    const row = (await db.request().input("Id", sql.Int, id).query("SELECT MergedIntoId FROM dbo.Tickets WHERE Id = @Id")).recordset[0];
    if (!row?.MergedIntoId) break;
    id = row.MergedIntoId;
  }
  return id || null;
}

function splitName(name, email) {
  const clean = String(name || "").replace(/["']/g, "").trim();
  if (!clean || clean.includes("@")) return { first: email.split("@")[0], last: "", display: email.split("@")[0] };
  if (clean.includes(",")) {
    const [last, first] = clean.split(",").map((p) => p.trim());
    return { first: first || last, last: first ? last : "", display: `${first} ${last}`.trim() };
  }
  const [first, ...rest] = clean.split(/\s+/);
  return { first, last: rest.join(" "), display: clean };
}

// A shared mailbox has no sign-in of its own. Telling it apart needs the
// optional Graph permission User.Read.All; without it the sender counts as
// staff.
async function isSharedMailbox(email) {
  try {
    const user = await graph("GET", `/users/${encodeURIComponent(email)}?$select=accountEnabled,userType`);
    return user && user.accountEnabled === false;
  } catch {
    return false;
  }
}

async function findSender(db, email) {
  return (await db.request().input("Email", sql.NVarChar(320), email).query(`${USER_SELECT} WHERE u.Email = @Email`)).recordset[0] || null;
}

// The sender's account, created when it's new: staff domains become Staff
// (or Shared Mailbox), everyone else an outside person. Turned-off accounts
// are used as they are.
async function senderFor(db, settings, address, name) {
  const email = address.toLowerCase();
  const found = await findSender(db, email);
  if (found) return found;
  const staff = isStaffEmail(settings, email);
  const shared = staff && (await isSharedMailbox(email));
  const names = splitName(name, email);
  try {
    await db.request()
      .input("FirstName", sql.NVarChar(100), names.first.slice(0, 100))
      .input("LastName", sql.NVarChar(100), names.last.slice(0, 100))
      .input("DisplayName", sql.NVarChar(200), names.display.slice(0, 200))
      .input("Email", sql.NVarChar(320), email)
      .input("UserTypeId", sql.Int, shared ? settings.SharedMailboxUserTypeId : staff ? settings.StaffUserTypeId : settings.ExternalUserTypeId)
      .input("RoleId", sql.Int, staff && !shared ? settings.DefaultRoleId : null)
      .query(`
        INSERT INTO dbo.Users (FirstName, LastName, DisplayName, Email, UserTypeId, RoleId)
        VALUES (@FirstName, @LastName, @DisplayName, @Email, @UserTypeId, @RoleId)
      `);
  } catch (error) {
    if (error.number !== 2627 && error.number !== 2601) throw error;
  }
  return findSender(db, email);
}

// The files on an email: { files, inline: Map(contentId -> file), tooBig }.
async function readAttachments(mailbox, message, settings) {
  const result = { files: [], inline: [], tooBig: [] };
  if (!isOn(settings, "InSaveAttachments")) return result;
  const limit = (settings.MaxEmailMB || 25) * 1024 * 1024;
  const list = await graph("GET", `/users/${encodeURIComponent(mailbox)}/messages/${message.id}/attachments`);
  for (const a of list?.value || []) {
    if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || !a.contentBytes) {
      result.tooBig.push(`${a.name} (not a file)`);
      continue;
    }
    if (a.size > limit) {
      result.tooBig.push(`${a.name} (${(a.size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    const file = { name: String(a.name || "file").slice(-200), type: a.contentType || "application/octet-stream", buffer: Buffer.from(a.contentBytes, "base64") };
    if (a.isInline && a.contentId) result.inline.push({ ...file, contentId: a.contentId.replace(/^<|>$/g, "") });
    else result.files.push(file);
  }
  return result;
}

// Saves the files and returns the message as stored rich text, with pasted
// images pointing at their saved copies.
async function saveBody(tx, ticketId, conversationId, html, files, authorId) {
  const cidMap = new Map();
  for (const image of files.inline) {
    const saved = await saveAttachments(tx, ticketId, conversationId, [image], authorId, [image.name]);
    if (saved.get(image.name)) cidMap.set(image.contentId, saved.get(image.name));
  }
  await saveAttachments(tx, ticketId, conversationId, files.files, authorId);
  let body = await finishRichText(tx, ticketId, html, cidMap);
  if (files.tooBig.length) {
    body += `<p><em>Not saved (too large or not a file, still in the mailbox): ${files.tooBig.map((n) => n.replace(/[<>&]/g, "")).join(", ")}</em></p>`;
  }
  return body || "<p>(no message)</p>";
}

function messageHtml(message, part) {
  const body = message[part];
  if (!body?.content) return "";
  return body.contentType === "text" ? plainToRich(body.content) : body.content;
}

async function recordInbound(db, message, mailbox, outcome, { ticketId = null, detail = null, inboundId = null } = {}) {
  const from = message.from?.emailAddress || {};
  const request = db.request()
    .input("MessageId", sql.NVarChar(400), message.internetMessageId)
    .input("ReceivedAt", sql.DateTime2(0), new Date(message.receivedDateTime))
    .input("TicketId", sql.Int, ticketId)
    .input("Outcome", sql.NVarChar(20), outcome)
    .input("Detail", sql.NVarChar(400), detail ? String(detail).slice(0, 400) : null)
    .input("Mailbox", sql.NVarChar(320), mailbox)
    .input("GraphId", sql.NVarChar(400), message.id)
    .input("FromEmail", sql.NVarChar(320), (from.address || "").toLowerCase().slice(0, 320))
    .input("FromName", sql.NVarChar(200), (from.name || "").slice(0, 200))
    .input("Subject", sql.NVarChar(400), (message.subject || "").slice(0, 400))
    .input("Preview", sql.NVarChar(500), (message.bodyPreview || "").slice(0, 500));
  if (inboundId) {
    await request.input("Id", sql.Int, inboundId).query("UPDATE dbo.InboundEmails SET Outcome = @Outcome, TicketId = @TicketId, Detail = @Detail WHERE Id = @Id");
    return;
  }
  await request.query(`
    INSERT INTO dbo.InboundEmails (EmailMessageId, ReceivedAt, TicketId, Outcome, Detail, Mailbox, GraphMessageId, FromEmail, FromName, Subject, Preview)
    VALUES (@MessageId, @ReceivedAt, @TicketId, @Outcome, @Detail, @Mailbox, @GraphId, @FromEmail, @FromName, @Subject, @Preview)
  `);
}

// A reply on an existing ticket. A reply always reopens a closed ticket,
// however old. If reopening would over-book its equipment, the reply is
// still added and a note tells the technician.
async function addReply(db, settings, mailbox, message, ticketId, sender, inboundId) {
  const files = await readAttachments(mailbox, message, settings);
  const html = messageHtml(message, "uniqueBody") || messageHtml(message, "body");
  let conversationId;
  await withTransaction(async (tx) => {
    const created = await tx.request()
      .input("TicketId", sql.Int, ticketId)
      .input("AuthorId", sql.Int, sender.Id)
      .input("MessageId", sql.NVarChar(400), message.internetMessageId)
      .query(`
        INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, Direction, EmailMessageId)
        OUTPUT INSERTED.Id
        VALUES (@TicketId, @AuthorId, N'', 0, 'in', @MessageId)
      `);
    conversationId = created.recordset[0].Id;
    const body = await saveBody(tx, ticketId, conversationId, html, files, sender.Id);
    await tx.request().input("Id", sql.Int, conversationId).input("Body", sql.NVarChar(sql.MAX), body)
      .query("UPDATE dbo.TicketConversations SET Body = @Body WHERE Id = @Id");
    await tx.request().input("Id", sql.Int, ticketId).query("UPDATE dbo.Tickets SET UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id");
    await recordInbound(tx, message, mailbox, "reply", { ticketId, inboundId });
  });

  const ticket = await loadTicket(db, ticketId);
  const nextStatusId = settings.RequesterReplyStatusId || settings.NewStatusId;
  if (!sender.IsTechnician && nextStatusId && (ticket.IsClosed || ticket.IsWaitingOnRequester)) {
    try {
      await withTransaction(async (tx) => {
        if (ticket.IsClosed) await recordEvents(tx, ticketId, null, [{ field: "Reopened", newValue: `Email from ${sender.Email}` }]);
        await setStatus(tx, ticket, nextStatusId, null);
      });
    } catch (error) {
      await db.request()
        .input("TicketId", sql.Int, ticketId)
        .input("AuthorId", sql.Int, sender.Id)
        .input("Body", sql.NVarChar(sql.MAX), `<p>A reply came in by email, but the ticket couldn't be reopened: ${String(error.message).replace(/[<>&]/g, "")}</p>`)
        .query("INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, Direction) VALUES (@TicketId, @AuthorId, @Body, 1, NULL)");
    }
  }
  if (!sender.IsTechnician) await replyAdded(ticketId, conversationId, "requester");
  return ticketId;
}

// A new ticket from an email: the email's subject (without RE:, FW: and
// EXT:), its message and files, and everyone else on it as CCs.
async function createTicket(db, settings, mailbox, message, sender, inboundId) {
  const files = await readAttachments(mailbox, message, settings);
  const html = messageHtml(message, "body");
  const subject = cleanSubject(message.subject);
  const desk = addressList(`${settings.MailboxAddress},${settings.TestingMailboxAddress || ""}`);
  const cc = [...new Set([...(message.toRecipients || []), ...(message.ccRecipients || [])]
    .map((r) => (r.emailAddress?.address || "").toLowerCase())
    .filter((e) => e.includes("@") && !desk.includes(e) && e !== sender.Email))].slice(0, 20);
  const typeId = settings.EmailTicketTypeId;
  if (!typeId || !settings.NewStatusId || !settings.DefaultPriorityId) {
    throw new Error("Settings is missing the ticket type for emailed tickets, the New status or the default priority");
  }

  let ticketId;
  await withTransaction(async (tx) => {
    const created = await tx.request()
      .input("TypeId", sql.Int, typeId)
      .input("StatusId", sql.Int, settings.NewStatusId)
      .input("PriorityId", sql.Int, settings.DefaultPriorityId)
      .input("SourceId", sql.Int, settings.EmailSourceId || settings.WebSourceId)
      .input("RequesterId", sql.Int, sender.Id)
      .input("DepartmentId", sql.Int, sender.DepartmentId ?? null)
      .input("Subject", sql.NVarChar(255), subject)
      .query(`
        INSERT INTO dbo.Tickets (TicketTypeId, StatusId, PriorityId, SourceId, RequesterId, DepartmentId, Subject, Description)
        OUTPUT INSERTED.Id
        VALUES (@TypeId, @StatusId, @PriorityId, @SourceId, @RequesterId, @DepartmentId, @Subject, N'')
      `);
    ticketId = created.recordset[0].Id;
    for (const email of cc) {
      await tx.request().input("TicketId", sql.Int, ticketId).input("Email", sql.NVarChar(320), email)
        .query("INSERT INTO dbo.TicketCc (TicketId, Email) VALUES (@TicketId, @Email)");
    }
    let description = await saveBody(tx, ticketId, null, html, files, sender.Id);
    if (!hasContent(description)) description = "<p>(no message)</p>";
    await tx.request().input("Id", sql.Int, ticketId).input("Description", sql.NVarChar(sql.MAX), description)
      .query("UPDATE dbo.Tickets SET Description = @Description WHERE Id = @Id");
    const type = (await tx.request().input("Id", sql.Int, typeId).query("SELECT Name FROM dbo.TicketTypes WHERE Id = @Id")).recordset[0];
    await recordEvents(tx, ticketId, sender.Id, [
      { field: "Created", newValue: type?.Name || "Email" },
      { field: "Email subject", newValue: message.subject || "(no subject)" }
    ]);
    await recordInbound(tx, message, mailbox, "ticket", { ticketId, inboundId });
  });
  await ticketCreated(ticketId);
  return ticketId;
}

// Handles one message. "accept" is set when a technician accepts held mail:
// the sender's account is then created whatever the switch says. Returns
// the outcome.
async function processMessage(mailbox, summary, { accept = false, inboundId = null } = {}) {
  const settings = await getSettings();
  const db = await getConnection();
  if (!inboundId) {
    const seen = await db.request().input("Id", sql.NVarChar(400), summary.internetMessageId)
      .query("SELECT 1 AS X FROM dbo.InboundEmails WHERE EmailMessageId = @Id");
    if (seen.recordset.length) return "seen";
  }
  const message = await graph("GET", `/users/${encodeURIComponent(mailbox)}/messages/${summary.id}?$select=${MESSAGE_FIELDS}`, undefined, {
    headers: { Prefer: 'outlook.body-content-type="html"' }
  });
  const from = (message.from?.emailAddress?.address || "").toLowerCase();
  const sentByUs = (await db.request().input("Id", sql.NVarChar(400), message.internetMessageId)
    .query("SELECT 1 AS X FROM dbo.OutboundEmails WHERE InternetMessageId = @Id")).recordset.length > 0;
  // The live mailbox's own mail is never read back. In maintenance mode the
  // testers' replies come from the testing mailbox, so only what the app
  // itself sent is skipped there.
  const ownAddress = from === String(settings.MailboxAddress || "").toLowerCase() && !isOn(settings, "MaintenanceMode");
  if (!from || sentByUs || ownAddress || isAutomatic(message)) {
    await recordInbound(db, message, mailbox, "skipped", { detail: sentByUs || ownAddress ? "Sent by the desk" : "Automatic email", inboundId });
    return "skipped";
  }

  const ticketId = await findTicket(db, message);
  const switchName = ticketId ? "InAddReplies" : "InCreateTickets";
  if (!accept && !isOn(settings, switchName)) {
    await recordInbound(db, message, mailbox, "skipped", {
      ticketId,
      detail: ticketId ? `Reply to ${formatNumber(ticketId)}, but adding replies is switched off` : "Creating tickets from email is switched off",
      inboundId
    });
    return "skipped";
  }
  let sender = await findSender(db, from);
  if (!sender) {
    if (!accept && !isOn(settings, "InCreateSenders")) {
      await recordInbound(db, message, mailbox, "held", {
        ticketId,
        detail: ticketId ? `New sender replying to ${formatNumber(ticketId)}` : "New sender",
        inboundId
      });
      return "held";
    }
    sender = await senderFor(db, settings, from, message.from?.emailAddress?.name);
  }
  if (ticketId) {
    await addReply(db, settings, mailbox, message, ticketId, sender, inboundId);
    return "reply";
  }
  await createTicket(db, settings, mailbox, message, sender, inboundId);
  return "ticket";
}

// One check of the mailbox: messages received since the last check (and
// after "Only read mail received after"), oldest first. Returns counts.
async function checkMailbox({ getMarker, setMarker }) {
  const settings = await getSettings();
  const mailbox = activeMailbox(settings);
  if (!mailbox) throw new Error(isOn(settings, "MaintenanceMode") ? "Maintenance mode is on but there is no testing mailbox" : "There is no mailbox address in Settings");
  const markerName = `mark:${mailbox.toLowerCase()}`;
  const floor = settings.InProcessAfter ? new Date(settings.InProcessAfter) : new Date();
  const marker = await getMarker(markerName);
  // A few minutes of overlap, because mail can arrive with an earlier time
  // than mail already seen; InboundEmails stops any repeats.
  let since = marker ? new Date(new Date(marker).getTime() - 10 * 60 * 1000) : floor;
  if (since < floor) since = floor;

  const counts = {};
  const failures = [];
  let newest = marker ? new Date(marker) : null;
  let url = `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages?$select=id,internetMessageId,receivedDateTime,subject,from,bodyPreview` +
    `&$filter=receivedDateTime ge ${since.toISOString()}&$orderby=receivedDateTime asc&$top=50`;
  for (let page = 0; url && page < 10; page += 1) {
    const list = await graph("GET", url);
    for (const summary of list.value || []) {
      if (!summary.internetMessageId) continue;
      let outcome;
      try {
        outcome = await processMessage(mailbox, summary);
      } catch (error) {
        // One bad message mustn't stop the rest. It waits in Held mail with
        // the error, where a technician can try it again.
        outcome = "failed";
        failures.push(error.message);
        const pool = await getConnection();
        const seen = await pool.request().input("Id", sql.NVarChar(400), summary.internetMessageId)
          .query("SELECT 1 AS X FROM dbo.InboundEmails WHERE EmailMessageId = @Id");
        if (!seen.recordset.length) {
          await recordInbound(pool, { ...summary, subject: summary.subject || "(could not read)" }, mailbox, "failed", { detail: error.message });
        }
      }
      counts[outcome] = (counts[outcome] || 0) + 1;
      const at = new Date(summary.receivedDateTime);
      if (!newest || at > newest) newest = at;
    }
    url = list["@odata.nextLink"];
  }
  if (newest) await setMarker(markerName, newest.toISOString());
  return { counts, failures };
}

module.exports = { processMessage, checkMailbox, cleanSubject, isAutomatic, findTicket, splitName, recordInbound };
