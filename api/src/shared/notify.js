const { getConnection, sql } = require("./db");
const { getSettings, isOn, addressList } = require("./settings");
const { isStaffEmail } = require("./auth");
const { loadTicket, formatNumber } = require("./tickets");
const { downloadFile } = require("./storage");
const { wallLabel, toWall } = require("./clock");
const { escapeHtml } = require("./richtext");
const { deliver, fillSubject, fillBody, withTicketNumber, threadHtml, embedImages, ticketUrl, surveyUrl } = require("./mailer");

// Every email the desk sends about a ticket, each behind its own switch in
// Settings > Email > Outgoing. These run after the change is saved and never
// throw: a ticket is saved whether or not its email goes out. What happened
// is written to the ticket's history (technicians only), so automatic emails
// are never part of the conversation the requester sees.

const roomOnly = (ticket) => !!ticket.HasRoom && !ticket.HasEquipment;

// A line in the ticket's history that doesn't count as activity (Last
// activity shows real work, not email bookkeeping).
async function logEmail(db, ticketId, text, field = "Email") {
  await db.request()
    .input("TicketId", sql.Int, ticketId)
    .input("Field", sql.NVarChar(50), field)
    .input("NewValue", sql.NVarChar(400), String(text).slice(0, 400))
    .query("INSERT INTO dbo.TicketEvents (TicketId, ActorId, Field, OldValue, NewValue) VALUES (@TicketId, NULL, @Field, NULL, @NewValue)");
}

async function ccOf(db, ticketId) {
  const result = await db.request().input("Id", sql.Int, ticketId).query("SELECT Email FROM dbo.TicketCc WHERE TicketId = @Id");
  return result.recordset.map((r) => r.Email);
}

function whenOf(ticket) {
  const start = toWall(ticket.StartAt);
  const end = toWall(ticket.EndAt);
  if (start) return `${wallLabel(start)} to ${start.slice(0, 10) === end?.slice(0, 10) ? wallLabel(end).split(", ").pop() : wallLabel(end)}`;
  const day = (d) => (d ? new Date(d).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "medium" }) : "");
  return [day(ticket.StartDate), day(ticket.EndDate)].filter(Boolean).join(" to ");
}

function baseVars(settings, ticket) {
  return {
    Requester: ticket.RequesterName,
    TicketNumber: formatNumber(ticket.Id),
    Subject: ticket.Subject,
    Room: ticket.RoomName || "",
    When: whenOf(ticket),
    DaysLeft: String(Math.max(1, (settings.CloseBusinessDays || 4) - (settings.WarningBusinessDays || 3)))
  };
}

const template = (settings, key) => ({ subject: settings[`Template${key}Subject`] || "", body: settings[`Template${key}Body`] || "" });

// Sends a template to people, staff and outside people apart: staff get a
// "View your ticket" button, outside people (who can't sign in) are asked to
// reply to the email instead. Returns the addresses it reached, or why not.
async function sendTemplate({ kind, settings, ticket, to, cc = [], key, vars = {}, thread = null, attachments = [], extraHtml = "", link = true }) {
  const desk = addressList(`${settings.MailboxAddress},${settings.TestingMailboxAddress || ""}`);
  const clean = (list) => [...new Set(list.map((e) => String(e || "").toLowerCase()).filter((e) => e.includes("@") && !desk.includes(e)))];
  to = clean(to);
  cc = clean(cc).filter((e) => !to.includes(e));
  const groups = [true, false].map((staff) => ({
    staff,
    to: to.filter((e) => isStaffEmail(settings, e) === staff),
    cc: cc.filter((e) => isStaffEmail(settings, e) === staff)
  })).filter((g) => g.to.length || g.cc.length);
  if (!groups.length) return { sent: [], note: "nobody to send it to" };

  const url = ticketUrl(settings, ticket.Id);
  const sent = [];
  let note = null;
  for (const group of groups) {
    const all = {
      ...baseVars(settings, ticket),
      Link: group.staff && link ? { html: `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`, text: url } : "",
      ...vars
    };
    const subject = withTicketNumber(fillSubject(template(settings, key).subject, all), formatNumber(ticket.Id));
    const result = await deliver({
      kind,
      ticketId: ticket.Id,
      to: group.to,
      cc: group.cc,
      subject,
      content: {
        bodyHtml: fillBody(template(settings, key).body, all) + extraHtml,
        button: group.staff && link ? { label: "View your ticket", url } : null,
        replyNote: group.staff ? "You can also reply to this email." : "Reply to this email to add to your ticket.",
        thread
      },
      attachments
    });
    if (result.sent) sent.push(...result.to);
    else note = result.note;
  }
  return { sent, note };
}

async function report(db, ticketId, label, result) {
  if (result.sent.length) await logEmail(db, ticketId, `Sent the ${label} email to ${result.sent.join(", ")}`);
  else await logEmail(db, ticketId, `Not emailed: ${label} (${result.note})`);
}

async function switchedOff(db, ticketId, label) {
  await logEmail(db, ticketId, `Not emailed: ${label} (switched off)`);
}

// Runs one notice, so a failure in one never stops the others or the save.
async function safely(context, work) {
  try {
    await work();
  } catch (error) {
    (context?.error || console.error)(error);
  }
}

// ---------------------------------------------------------------------------
// A new ticket: "we got your request" to the requester, the IT team alert,
// and for a room the HR alert.
// ---------------------------------------------------------------------------
async function ticketCreated(ticketId, context) {
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return;
    const description = { html: await embedImages(db, ticket.Description || "", new Map()) };

    if (isOn(settings, "OutReceived")) {
      const result = await sendTemplate({ kind: "Received", settings, ticket, key: "Received", to: [ticket.RequesterEmail], cc: await ccOf(db, ticketId) });
      await report(db, ticketId, "ticket received", result);
    } else {
      await switchedOff(db, ticketId, "ticket received");
    }

    if (!roomOnly(ticket)) {
      if (isOn(settings, "OutNewTicketAlert")) {
        const result = await sendTemplate({
          kind: "NewTicketAlert", settings, ticket, key: "NewTicketAlert", to: addressList(settings.ITTeamEmails), vars: { Description: description }
        });
        await report(db, ticketId, "new ticket alert", result);
      } else {
        await switchedOff(db, ticketId, "new ticket alert");
      }
    }

    if (ticket.HasRoom) {
      if (isOn(settings, "OutBookingAlert")) {
        const result = await sendTemplate({
          kind: "BookingRequest", settings, ticket, key: "BookingRequest", to: addressList(settings.HREmails), vars: { Description: description }
        });
        await report(db, ticketId, "room request", result);
      } else {
        await switchedOff(db, ticketId, "room request");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// A reply. From a technician or HR, it goes to the requester and CCs with
// the conversation below it. From the requester, the assigned technician
// (or the IT team, or HR for a room-only request) gets an alert.
// ---------------------------------------------------------------------------
async function replyAdded(ticketId, conversationId, from, context) {
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    const reply = (await db.request().input("Id", sql.Int, conversationId).query("SELECT Id, Body, IsTechnicianNote FROM dbo.TicketConversations WHERE Id = @Id")).recordset[0];
    if (!ticket || !reply || reply.IsTechnicianNote) return;

    if (from === "technician" || from === "hr") {
      const key = from === "hr" ? "OutHrReply" : "OutReply";
      const mark = async (emailed, note) => {
        await db.request().input("Id", sql.Int, conversationId).input("Note", sql.NVarChar(200), note)
          .query(`UPDATE dbo.TicketConversations SET ${emailed ? "EmailedAt = SYSUTCDATETIME(), EmailNote = NULL" : "EmailNote = @Note"} WHERE Id = @Id`);
      };
      if (!isOn(settings, key)) {
        await mark(false, `Not emailed: ${from === "hr" ? "HR" : "technician"} replies are switched off`);
        return;
      }
      const images = new Map();
      const bodyHtml = await embedImages(db, reply.Body, images);
      // The rest of the conversation, newest first, without this reply
      const thread = await threadHtml(db, ticket, images, conversationId);
      const files = (await db.request().input("Id", sql.Int, conversationId)
        .query("SELECT FileName, ContentType, BlobPath FROM dbo.Attachments WHERE ConversationId = @Id AND IsInline = 0")).recordset;
      const attachments = [];
      for (const f of files) attachments.push({ name: f.FileName, type: f.ContentType, buffer: await downloadFile(f.BlobPath) });
      for (const image of images.values()) if (image) attachments.push(image);
      const result = await sendReply(settings, ticket, [ticket.RequesterEmail], await ccOf(db, ticketId), bodyHtml, thread, attachments);
      await mark(result.sent.length > 0, result.sent.length ? null : `Not emailed: ${result.note}`);
      return;
    }

    if (!isOn(settings, "OutRequesterReplyAlert")) {
      await switchedOff(db, ticketId, "reply alert");
      return;
    }
    const to = ticket.TechnicianId
      ? [(await db.request().input("Id", sql.Int, ticket.TechnicianId).query("SELECT Email FROM dbo.Users WHERE Id = @Id")).recordset[0]?.Email]
      : roomOnly(ticket) ? addressList(settings.HREmails) : addressList(settings.ITTeamEmails);
    const result = await sendTemplate({
      kind: "ReplyAlert", settings, ticket, key: "ReplyAlert", to: to.filter(Boolean),
      vars: { Description: { html: await embedImages(db, reply.Body, new Map()) } }
    });
    await report(db, ticketId, "reply alert", result);
  });
}

// A technician's or HR's reply: their words, a button for staff, and the
// conversation below.
async function sendReply(settings, ticket, to, cc, bodyHtml, thread, attachments) {
  const sent = [];
  let note = null;
  const desk = addressList(`${settings.MailboxAddress},${settings.TestingMailboxAddress || ""}`);
  const all = [...new Set([...to, ...cc].map((e) => String(e || "").toLowerCase()).filter((e) => e.includes("@") && !desk.includes(e)))];
  if (!all.length) return { sent, note: "nobody to send it to" };
  const url = ticketUrl(settings, ticket.Id);
  for (const staff of [true, false]) {
    const group = all.filter((e) => isStaffEmail(settings, e) === staff);
    if (!group.length) continue;
    const toGroup = group.filter((e) => to.map((t) => String(t).toLowerCase()).includes(e));
    const result = await deliver({
      kind: "Reply",
      ticketId: ticket.Id,
      to: toGroup.length ? toGroup : [group[0]],
      cc: group.filter((e) => !(toGroup.length ? toGroup : [group[0]]).includes(e)),
      subject: `Ticket #${formatNumber(ticket.Id)}: ${ticket.Subject}`,
      content: {
        bodyHtml,
        button: staff ? { label: "View your ticket", url } : null,
        replyNote: staff ? "Reply to this email or open the ticket to answer." : "Reply to this email to answer.",
        thread
      },
      attachments
    });
    if (result.sent) sent.push(...result.to);
    else note = result.note;
  }
  return { sent, note };
}

// ---------------------------------------------------------------------------
// Closed: the closed email and the survey. When both are on they come as one
// email, the closed message with the survey under it. Never for room-only
// requests (IT did no work on them) or a ticket merged into another.
// ---------------------------------------------------------------------------
function surveyButtons(settings, token) {
  const url = surveyUrl(settings, token);
  const cells = [1, 2, 3, 4, 5].map((n) =>
    `<td style="padding:0 4px"><a href="${escapeHtml(`${url}?rating=${n}`)}" style="display:inline-block;width:40px;line-height:40px;text-align:center;border:1px solid #dde2df;border-radius:6px;color:#1d2528;text-decoration:none;font-weight:600">${n}</a></td>`).join("");
  return `<p style="margin:16px 0 6px"><strong>How did we do?</strong> 1 is poor, 5 is great.</p><table role="presentation" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`;
}

async function ticketClosed(ticketId, context) {
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    if (!ticket || !ticket.IsClosed || roomOnly(ticket)) return;
    const merged = (await db.request().input("Id", sql.Int, ticketId).query("SELECT MergedIntoId FROM dbo.Tickets WHERE Id = @Id")).recordset[0];
    if (merged?.MergedIntoId) return;
    const closedOn = isOn(settings, "OutClosed");
    const surveyOn = isOn(settings, "OutSurvey");
    if (!closedOn) await switchedOff(db, ticketId, "ticket closed");
    if (!surveyOn) await switchedOff(db, ticketId, "survey");
    if (!closedOn && !surveyOn) return;

    let token = null;
    if (surveyOn) {
      // A survey on every close. A new close gets a new link; an earlier
      // answer stays until a new one replaces it.
      const row = await db.request().input("Id", sql.Int, ticketId).query(`
        MERGE dbo.Surveys AS s
        USING (SELECT @Id AS TicketId) AS v ON s.TicketId = v.TicketId
        WHEN MATCHED THEN UPDATE SET Token = NEWID(), SentAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT (TicketId, Token, SentAt) VALUES (@Id, NEWID(), SYSUTCDATETIME())
        OUTPUT INSERTED.Token;
      `);
      token = row.recordset[0].Token;
    }
    const link = token ? { html: `<a href="${escapeHtml(surveyUrl(settings, token))}">${escapeHtml(surveyUrl(settings, token))}</a>`, text: surveyUrl(settings, token) } : "";
    const result = await sendTemplate({
      kind: closedOn ? "Closed" : "Survey",
      settings,
      ticket,
      key: closedOn ? "Closed" : "Survey",
      to: [ticket.RequesterEmail],
      cc: closedOn ? await ccOf(db, ticketId) : [],
      vars: closedOn ? {} : { Link: link },
      extraHtml: token ? surveyButtons(settings, token) : "",
      link: closedOn
    });
    await report(db, ticketId, closedOn ? (surveyOn ? "ticket closed and survey" : "ticket closed") : "survey", result);
    if (token && !result.sent.length) {
      await db.request().input("Id", sql.Int, ticketId).query("UPDATE dbo.Surveys SET SentAt = NULL WHERE TicketId = @Id");
    }
  });
}

// ---------------------------------------------------------------------------
// The waiting on you warning (from the business day timer). Returns whether
// it was sent.
// ---------------------------------------------------------------------------
async function waitingWarning(ticketId, context) {
  let sent = false;
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return;
    if (!isOn(settings, "OutWarning")) {
      await switchedOff(db, ticketId, "waiting on you warning");
      return;
    }
    const result = await sendTemplate({ kind: "Warning", settings, ticket, key: "Warning", to: [ticket.RequesterEmail], cc: await ccOf(db, ticketId) });
    await report(db, ticketId, "waiting on you warning", result);
    sent = result.sent.length > 0;
  });
  return sent;
}

// ---------------------------------------------------------------------------
// Bookings: HR's decision to the requester, and changes to HR and IT.
// ---------------------------------------------------------------------------
async function bookingDecided(ticketId, action, reason, context) {
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return;
    const label = action === "confirm" ? "room confirmed" : "room declined";
    if (!isOn(settings, "OutBookingDecision")) {
      await switchedOff(db, ticketId, label);
      return;
    }
    const result = await sendTemplate({
      kind: action === "confirm" ? "BookingConfirmed" : "BookingDeclined",
      settings,
      ticket,
      key: action === "confirm" ? "BookingConfirmed" : "BookingDeclined",
      to: [ticket.RequesterEmail],
      cc: await ccOf(db, ticketId),
      extraHtml: reason ? `<p style="margin:0 0 12px"><strong>Note from HR:</strong> ${escapeHtml(reason)}</p>` : ""
    });
    await report(db, ticketId, label, result);
  });
}

// "changes" is the ticket's new history lines ({ field, oldValue, newValue }).
async function bookingChanged(ticketId, changes, actor, context) {
  if (!changes.length) return;
  await safely(context, async () => {
    const settings = await getSettings();
    const db = await getConnection();
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return;
    if (!isOn(settings, "OutBookingChange")) {
      await switchedOff(db, ticketId, "booking change");
      return;
    }
    const to = [];
    if (ticket.HasRoom || changes.some((c) => /room/i.test(c.field))) to.push(...addressList(settings.HREmails));
    if (ticket.HasEquipment) {
      if (ticket.TechnicianId) {
        to.push((await db.request().input("Id", sql.Int, ticket.TechnicianId).query("SELECT Email FROM dbo.Users WHERE Id = @Id")).recordset[0]?.Email);
      } else {
        to.push(...addressList(settings.ITTeamEmails));
      }
    }
    const list = changes.map((c) => `<li>${escapeHtml(c.field)}${c.oldValue ? `: ${escapeHtml(c.oldValue)} to ` : c.newValue ? ": " : ""}${escapeHtml(c.newValue || "")}</li>`).join("");
    const result = await sendTemplate({
      kind: "BookingChange",
      settings,
      ticket,
      key: "BookingChange",
      to: to.filter((e) => e && e.toLowerCase() !== String(actor?.Email || "").toLowerCase()),
      vars: { Changes: { html: `<ul>${list}</ul>`, text: changes.map((c) => c.field).join(", ") } }
    });
    await report(db, ticketId, "booking change", result);
  });
}

module.exports = { ticketCreated, replyAdded, ticketClosed, waitingWarning, bookingDecided, bookingChanged, logEmail };
