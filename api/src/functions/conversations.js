const { endpoint, readBodyWithFiles, optionalId } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { saveAttachments, finishRichText, readInlineNames } = require("../shared/attachments");
const { hasContent } = require("../shared/richtext");
const { loadTicket, loadVisibleTicket, setStatus, forViewer, accessOf } = require("../shared/tickets");

const MAX_MESSAGE = 200000;

// Adds a reply or a note to a ticket (one row in dbo.TicketConversations),
// with any attached files and images pasted into the text.
//
// - A technician reply moves the ticket to "Awaiting User Response" (the
//   AwaitingStatusId setting) unless the technician picked another status.
// - A note is internal: the requester never sees it. A technician's note is
//   for technicians only; an Event Manager's (HR) note on a ticket with a
//   room is for HR and technicians.
// - An Event Manager's reply goes to the requester and leaves the status as
//   it is.
// - A requester reply on a ticket that is waiting on them moves it to the
//   RequesterReplyStatusId setting. Closed tickets can't be replied to.
endpoint(
  "addConversation",
  { methods: ["POST"], route: "tickets/{id:int}/conversations", failMessage: "Could not save the reply" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const { data, files } = await readBodyWithFiles(request);
    const inlineNames = readInlineNames(data.inline);
    const draft = typeof data.body === "string" ? data.body : "";
    if (draft.length > MAX_MESSAGE) throw new HttpError(400, "The message is too long");
    if (!hasContent(draft) && !files.length) throw new HttpError(400, "Write a message or attach a file");
    const isNote = !!data.isTechnicianNote;

    const settings = await getSettings();
    const pool = await getConnection();
    const ticket = await loadVisibleTicket(pool, id, user);
    const access = accessOf(user, ticket);
    const asHr = !user.IsTechnician && access.hr;
    if (isNote && !user.IsTechnician && !asHr) throw new HttpError(403, "Only technicians and HR can add notes");
    const staffSide = user.IsTechnician || asHr;
    if (!staffSide && ticket.IsClosed) {
      throw new HttpError(400, "This ticket is closed. Please submit a new request.");
    }

    let nextStatusId = null;
    if (user.IsTechnician) {
      nextStatusId = optionalId(data.statusId, "Status") || (isNote ? null : settings.AwaitingStatusId);
    } else if (!asHr && ticket.IsWaitingOnRequester && settings.RequesterReplyStatusId) {
      nextStatusId = settings.RequesterReplyStatusId;
    }

    let warnings = [];
    await withTransaction(async (tx) => {
      const created = await tx
        .request()
        .input("TicketId", sql.Int, id)
        .input("AuthorId", sql.Int, user.Id)
        .input("IsNote", sql.Bit, isNote)
        .input("ForHr", sql.Bit, isNote && asHr)
        .input("Direction", sql.NVarChar(3), isNote ? null : staffSide ? "out" : "in")
        .query(`
          INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, VisibleToEventManagers, Direction)
          OUTPUT INSERTED.Id
          VALUES (@TicketId, @AuthorId, N'', @IsNote, @ForHr, @Direction)
        `);
      const conversationId = created.recordset[0].Id;
      const saved = await saveAttachments(tx, id, conversationId, files, user.Id, inlineNames);
      const body = (await finishRichText(tx, id, draft, saved)) || "<p>(attachment)</p>";
      await tx.request().input("Id", sql.Int, conversationId).input("Body", sql.NVarChar(sql.MAX), body)
        .query("UPDATE dbo.TicketConversations SET Body = @Body WHERE Id = @Id");

      await tx.request().input("Id", sql.Int, id).query("UPDATE dbo.Tickets SET UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id");
      if (nextStatusId) warnings = await setStatus(tx, ticket, nextStatusId, user.Id);
    });

    // Emailing the reply to the requester (or the technician) comes with the
    // email step of the build; see the README.
    return { status: 201, jsonBody: { ticket: forViewer(await loadTicket(pool, id), user), warnings } };
  }
);
