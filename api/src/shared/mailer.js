const fs = require("fs");
const path = require("path");
const { getConnection, sql } = require("./db");
const { getSettings, isOn, addressList } = require("./settings");
const { graph, uploadInPieces } = require("./graph");
const { downloadWithProperties, downloadFile } = require("./storage");
const { escapeHtml } = require("./richtext");
const { recordRun } = require("./health");

// Sends email from the desk's mailbox through Microsoft Graph, in the
// branded layout: the logo in a bar of the Appearance header color, the
// message, a "View your ticket" button for staff (outside people can't sign
// in, so they're asked to reply instead), and for replies the conversation
// below, newest first.
//
// In maintenance mode every email is sent from and to the testing mailbox,
// with the people it would have gone to written at the top.

const DEFAULT_HEAD = "#0f3a40";
const LOGO_ID = "desk-logo";
const DEFAULT_LOGO = path.join(__dirname, "..", "assets", "default-logo.png");
// Graph takes attachments up to 3 MB in the message; bigger ones go through
// an upload session.
const SMALL_ATTACHMENT = 3 * 1024 * 1024;
// Pasted images carried in a quoted conversation, at most this much in all.
const THREAD_IMAGE_BYTES = 5 * 1024 * 1024;

// Base64 makes attachments about a third larger on the way out, so this is
// how many bytes of files fit in the largest email the mailbox sends.
const attachmentRoom = (settings) => Math.floor(((settings.MaxEmailMB || 25) * 1024 * 1024) / 1.37);

function luminance(hex) {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
// White or near-black, whichever reads better on the color (as the site does).
const textOn = (hex) => {
  const l = luminance(hex) + 0.05;
  return 1.05 / l >= l / (luminance("#111111") + 0.05) ? "#ffffff" : "#111111";
};

function headColor(settings) {
  try {
    const head = JSON.parse(settings.AppearanceLight || "{}").head;
    return /^#[0-9a-f]{6}$/.test(head) ? head : DEFAULT_HEAD;
  } catch {
    return DEFAULT_HEAD;
  }
}

let defaultLogo;
async function logoFile() {
  try {
    const logo = await downloadWithProperties("branding/logo");
    if (logo) return { buffer: logo.buffer, type: logo.contentType || "image/png" };
  } catch {
    // fall back to the built-in seal
  }
  if (!defaultLogo) defaultLogo = fs.readFileSync(DEFAULT_LOGO);
  return { buffer: defaultLogo, type: "image/png" };
}

const ticketUrl = (settings, ticketId) => `${String(settings.SiteUrl || "").replace(/\/+$/, "")}/tickets/${ticketId}`;
const surveyUrl = (settings, token) => `${String(settings.SiteUrl || "").replace(/\/+$/, "")}/survey/${token}`;

// The address mail is read from and sent from: the testing mailbox in
// maintenance mode.
const activeMailbox = (settings) => (isOn(settings, "MaintenanceMode") ? settings.TestingMailboxAddress : settings.MailboxAddress);
const deskAddresses = (settings) => addressList(`${settings.MailboxAddress || ""},${settings.TestingMailboxAddress || ""}`);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

// Fills a template's placeholders. "vars" maps a name to text, or to
// { html, text } for rich text and links. A paragraph that is only a rich
// text placeholder (like [Description]) takes that text's own paragraphs.
function placeholder(vars, name, asHtml) {
  const v = vars[name];
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return asHtml ? v.html : v.text || "";
  return asHtml ? escapeHtml(v) : String(v);
}

function fillSubject(text, vars) {
  return String(text || "").replace(/\[(\w+)\]/g, (whole, name) => (name in vars ? placeholder(vars, name, false) : whole)).replace(/\s+/g, " ").trim();
}

function fillBody(text, vars) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const only = /^\[(\w+)\]$/.exec(para);
      if (only && typeof vars[only[1]] === "object") return vars[only[1]].html;
      const html = escapeHtml(para).replace(/\[(\w+)\]/g, (whole, name) => (name in vars ? placeholder(vars, name, true) : whole)).replace(/\n/g, "<br>");
      return html ? `<p>${html}</p>` : "";
    })
    .join("");
}

// Every subject names its ticket, so replies find it again.
function withTicketNumber(subject, number) {
  if (!number || new RegExp(`Ticket #${number}\\b`).test(subject)) return subject;
  return `${subject} (Ticket #${number})`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const P = 'style="margin:0 0 12px"';

function layout(settings, { bodyHtml, button, replyNote, thread, banner }) {
  const head = headColor(settings);
  const onHead = textOn(head);
  const appName = escapeHtml(settings.AppName || "Service Desk");
  const font = "font-family:Segoe UI,Helvetica,Arial,sans-serif";
  const blocks = String(bodyHtml).replace(/<p>/g, `<p ${P}>`);
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f1">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f1;${font}">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dde2df;border-radius:8px;overflow:hidden">
<tr><td style="background:${head};color:${onHead};padding:14px 20px;font-size:18px;font-weight:600">
<img src="cid:${LOGO_ID}" width="36" height="36" alt="" style="vertical-align:middle;margin-right:10px;border:0">${appName}</td></tr>
${banner ? `<tr><td style="background:#fff4d6;color:#5a4300;padding:10px 20px;font-size:13px">${banner}</td></tr>` : ""}
<tr><td style="padding:20px;color:#1d2528;font-size:15px;line-height:1.5">${blocks}
${button ? `<p style="margin:20px 0 4px"><a href="${escapeHtml(button.url)}" style="background:${head};color:${onHead};text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:600">${escapeHtml(button.label)}</a></p>` : ""}
${replyNote ? `<p style="margin:16px 0 0;color:#56636a;font-size:13px">${escapeHtml(replyNote)}</p>` : ""}
</td></tr>
${thread ? `<tr><td style="padding:0 20px 20px">${thread}</td></tr>` : ""}
</table>
<p style="color:#56636a;font-size:12px;margin:12px 0 0">${escapeHtml(settings.OrganizationName || "")}${settings.OrganizationName ? " · " : ""}${appName}</p>
</td></tr></table></body></html>`;
}

// The ticket's public conversation, newest first, as quoted blocks: replies
// only (never notes, never automatic emails), then the request itself.
// Images pasted into replies are carried as inline attachments.
// "exceptId" leaves out one reply (the one the email is about).
async function threadHtml(db, ticket, images, exceptId = 0) {
  const rows = await db.request().input("Id", sql.Int, ticket.Id).input("Except", sql.Int, exceptId).query(`
    SELECT c.Id, c.Body, c.CreatedAt, c.Direction,
           COALESCE(NULLIF(u.DisplayName, ''), CONCAT(u.FirstName, ' ', u.LastName)) AS AuthorName
    FROM dbo.TicketConversations c
    JOIN dbo.Users u ON u.Id = c.AuthorId
    WHERE c.TicketId = @Id AND c.IsTechnicianNote = 0 AND c.Id <> @Except
    ORDER BY c.CreatedAt DESC, c.Id DESC
  `);
  const zone = (await getSettings()).TimeZone || "America/New_York";
  const when = (date) => new Date(date).toLocaleString("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "short" });
  const items = [
    ...rows.recordset.map((c) => ({ name: c.AuthorName, at: c.CreatedAt, body: c.Body })),
    { name: ticket.RequesterName, at: ticket.CreatedAt, body: ticket.Description }
  ];
  const parts = [];
  for (const item of items) {
    const body = await embedImages(db, String(item.body || ""), images);
    parts.push(`<div style="border-top:1px solid #dde2df;padding:12px 0 0;margin-top:12px;color:#1d2528;font-size:14px;line-height:1.5">
<div style="color:#56636a;font-size:12px;margin-bottom:6px"><strong style="color:#1d2528">${escapeHtml(item.name || "")}</strong> · ${escapeHtml(when(item.at))}</div>
${body.replace(/<p>/g, `<p ${P}>`)}</div>`);
  }
  return parts.join("");
}

// Swaps the app's image links (/api/attachments/12) for inline attachments.
async function embedImages(db, html, images) {
  const ids = [...html.matchAll(/src="\/api\/attachments\/(\d+)"/g)].map((m) => Number(m[1]));
  for (const id of ids) {
    if (images.has(id)) continue;
    const row = (await db.request().input("Id", sql.Int, id).query("SELECT FileName, ContentType, BlobPath, SizeBytes FROM dbo.Attachments WHERE Id = @Id")).recordset[0];
    const used = [...images.values()].reduce((sum, f) => sum + (f?.buffer.length || 0), 0);
    if (!row || used + row.SizeBytes > THREAD_IMAGE_BYTES) {
      images.set(id, null);
      continue;
    }
    images.set(id, { name: row.FileName, type: row.ContentType, buffer: await downloadFile(row.BlobPath), contentId: `att${id}` });
  }
  return html.replace(/<img[^>]*src="\/api\/attachments\/(\d+)"[^>]*>/g, (whole, id) =>
    images.get(Number(id)) ? `<img src="cid:att${id}" alt="" style="max-width:100%">` : "<em>[picture]</em>");
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function addAttachment(from, messageId, file) {
  const base = `/users/${encodeURIComponent(from)}/messages/${messageId}/attachments`;
  if (file.buffer.length < SMALL_ATTACHMENT) {
    await graph("POST", base, {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: file.name,
      contentType: file.type,
      contentBytes: file.buffer.toString("base64"),
      isInline: !!file.contentId,
      ...(file.contentId ? { contentId: file.contentId } : {})
    });
    return;
  }
  const session = await graph("POST", `${base}/createUploadSession`, {
    AttachmentItem: {
      attachmentType: "file",
      name: file.name,
      size: file.buffer.length,
      contentType: file.type,
      isInline: !!file.contentId,
      ...(file.contentId ? { contentId: file.contentId } : {})
    }
  });
  await uploadInPieces(session.uploadUrl, file.buffer);
}

const recipients = (list) => list.map((address) => ({ emailAddress: { address } }));

// Sends one email. Returns { sent: true } or { sent: false, note }. Never
// throws: a failure is written to OutboundEmails and the Email status, and
// alerts the error recipients when sending starts failing.
// "content" is what goes in the layout: { bodyHtml, button, replyNote, thread }.
async function deliver({ kind, ticketId = null, to, cc = [], subject, content, attachments = [], track = true, redirect = true }) {
  const settings = await getSettings();
  const maintenance = isOn(settings, "MaintenanceMode");
  const desk = deskAddresses(settings);
  to = [...new Set(to.map((e) => String(e).toLowerCase()))].filter((e) => e && !desk.includes(e));
  cc = [...new Set(cc.map((e) => String(e).toLowerCase()))].filter((e) => e && !desk.includes(e) && !to.includes(e));
  if (!to.length && cc.length) to = [cc.shift()];
  if (!to.length) return { sent: false, note: "nobody to send it to" };
  const from = activeMailbox(settings);
  if (!from) return { sent: false, note: maintenance ? "maintenance mode has no testing mailbox" : "no mailbox is set" };

  let banner = null;
  if (maintenance && redirect) {
    banner = `Maintenance mode: this email would have gone to ${escapeHtml(to.join(", "))}${cc.length ? `, CC ${escapeHtml(cc.join(", "))}` : ""}.`;
    to = [settings.TestingMailboxAddress];
    cc = [];
  }
  const body = layout(settings, { ...content, banner });
  const pool = await getConnection();
  try {
    const logo = await logoFile();
    const files = [{ name: "logo.png", type: logo.type, buffer: logo.buffer, contentId: LOGO_ID }, ...attachments];
    const draft = await graph("POST", `/users/${encodeURIComponent(from)}/messages`, {
      subject,
      body: { contentType: "HTML", content: body },
      toRecipients: recipients(to),
      ccRecipients: recipients(cc)
    });
    for (const file of files) await addAttachment(from, draft.id, file);
    await graph("POST", `/users/${encodeURIComponent(from)}/messages/${draft.id}/send`);
    await pool.request()
      .input("TicketId", sql.Int, ticketId)
      .input("Kind", sql.NVarChar(40), kind)
      .input("ToList", sql.NVarChar(2000), [...to, ...cc].join(", ").slice(0, 2000))
      .input("Subject", sql.NVarChar(400), subject.slice(0, 400))
      .input("MessageId", sql.NVarChar(400), draft.internetMessageId || null)
      .query("INSERT INTO dbo.OutboundEmails (TicketId, Kind, ToList, Subject, InternetMessageId) VALUES (@TicketId, @Kind, @ToList, @Subject, @MessageId)");
    if (track) await recordRun("sending");
    return { sent: true, to: [...to, ...cc] };
  } catch (error) {
    await pool.request()
      .input("TicketId", sql.Int, ticketId)
      .input("Kind", sql.NVarChar(40), kind)
      .input("ToList", sql.NVarChar(2000), [...to, ...cc].join(", ").slice(0, 2000))
      .input("Subject", sql.NVarChar(400), subject.slice(0, 400))
      .input("Error", sql.NVarChar(1000), String(error.message).slice(0, 1000))
      .query("INSERT INTO dbo.OutboundEmails (TicketId, Kind, ToList, Subject, Error) VALUES (@TicketId, @Kind, @ToList, @Subject, @Error)")
      .catch(() => {});
    if (track) await recordRun("sending", error);
    return { sent: false, note: "sending failed, see Settings > Email" };
  }
}

// The problem and all-clear emails for Error alert recipients. These go out
// whatever the Outgoing switches say, and are not redirected in maintenance
// mode.
async function sendErrorAlert(jobLabel, message) {
  const settings = await getSettings();
  const to = addressList(settings.ErrorAlertEmails);
  if (!to.length) return;
  const subject = message ? `Problem: ${jobLabel} stopped working` : `Fixed: ${jobLabel} is working again`;
  const bodyHtml = message
    ? `<p>${escapeHtml(jobLabel)} failed in ${escapeHtml(settings.AppName || "the service desk")}.</p><p><strong>Error:</strong> ${escapeHtml(message)}</p><p>You get one more email when it works again. Settings &gt; Email shows the current state.</p>`
    : `<p>${escapeHtml(jobLabel)} is working again.</p>`;
  await deliver({ kind: "ErrorAlert", to, subject, content: { bodyHtml }, track: false, redirect: false });
}

module.exports = {
  deliver,
  layout,
  fillSubject,
  fillBody,
  withTicketNumber,
  threadHtml,
  embedImages,
  ticketUrl,
  surveyUrl,
  activeMailbox,
  deskAddresses,
  attachmentRoom,
  sendErrorAlert
};
