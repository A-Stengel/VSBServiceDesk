const { endpoint, readBodyWithFiles, optionalId, optionalText } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { uploadFile } = require("../shared/storage");
const { randomUUID } = require("crypto");
const { loadTicket, loadVisibleTicket, setStatus, withNumber } = require("../shared/tickets");

// Adds a reply or a technician note to a ticket (one row in
// dbo.TicketConversations), with any attached files.
//
// - A technician reply moves the ticket to "Awaiting User Response" (the
//   AwaitingStatusId setting) unless the technician picked another status.
// - A technician note is internal: the requester never sees it.
// - A requester reply on a ticket that is waiting on them moves it to the
//   RequesterReplyStatusId setting. Closed tickets can't be replied to.
endpoint(
  "addConversation",
  { methods: ["POST"], route: "tickets/{id:int}/conversations", failMessage: "Could not save the reply" },
  async (request, context, user) => {
    const id = Number(request.params.id);
    const { data, files } = await readBodyWithFiles(request);
    const body = optionalText(data.body, "Message", 50000);
    if (!body && !files.length) throw new HttpError(400, "Write a message or attach a file");
    const isNote = !!data.isTechnicianNote;
    if (isNote && !user.IsTechnician) throw new HttpError(403, "Only technicians can add notes");

    const settings = await getSettings();
    const pool = await getConnection();
    const ticket = await loadVisibleTicket(pool, id, user);
    const actingAsTechnician = user.IsTechnician;
    if (!actingAsTechnician && ticket.IsClosed) {
      throw new HttpError(400, "This ticket is closed. Please submit a new request.");
    }

    let nextStatusId = null;
    if (actingAsTechnician) {
      nextStatusId = optionalId(data.statusId, "Status") || (isNote ? null : settings.AwaitingStatusId);
    } else if (ticket.IsWaitingOnRequester && settings.RequesterReplyStatusId) {
      nextStatusId = settings.RequesterReplyStatusId;
    }

    let warnings = [];
    await withTransaction(async (tx) => {
      const created = await tx
        .request()
        .input("TicketId", sql.Int, id)
        .input("AuthorId", sql.Int, user.Id)
        .input("Body", sql.NVarChar(sql.MAX), body || "(attachment)")
        .input("IsNote", sql.Bit, isNote)
        .input("Direction", sql.NVarChar(3), isNote ? null : actingAsTechnician ? "out" : "in")
        .query(`
          INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, Direction)
          OUTPUT INSERTED.Id
          VALUES (@TicketId, @AuthorId, @Body, @IsNote, @Direction)
        `);
      const conversationId = created.recordset[0].Id;

      for (const file of files) {
        const blobPath = `tickets/${id}/${randomUUID()}-${file.name.replace(/[^\w.\- ]+/g, "_")}`;
        await uploadFile(blobPath, file.buffer, file.type);
        await tx
          .request()
          .input("TicketId", sql.Int, id)
          .input("ConversationId", sql.Int, conversationId)
          .input("FileName", sql.NVarChar(255), file.name)
          .input("ContentType", sql.NVarChar(150), file.type.slice(0, 150))
          .input("SizeBytes", sql.BigInt, file.buffer.length)
          .input("BlobPath", sql.NVarChar(500), blobPath)
          .input("UploadedById", sql.Int, user.Id)
          .query(`
            INSERT INTO dbo.Attachments (TicketId, ConversationId, FileName, ContentType, SizeBytes, BlobPath, UploadedById)
            VALUES (@TicketId, @ConversationId, @FileName, @ContentType, @SizeBytes, @BlobPath, @UploadedById)
          `);
      }

      await tx.request().input("Id", sql.Int, id).query("UPDATE dbo.Tickets SET UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id");
      if (nextStatusId) warnings = await setStatus(tx, ticket, nextStatusId, user.Id);
    });

    // Emailing the reply to the requester (or the technician) comes with the
    // email step of the build; see the README.
    return { status: 201, jsonBody: { ticket: withNumber(await loadTicket(pool, id)), warnings } };
  }
);
