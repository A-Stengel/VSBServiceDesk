const { endpoint, readJson, requiredId } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { withTransaction, getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { escapeHtml } = require("../shared/richtext");
const { loadTicket, forViewer, formatNumber, getStatus, statusTimingSql, recordEvents } = require("../shared/tickets");

// Merging ticket A into ticket B (for example when someone emails twice):
// A's request, replies, notes, attachments and CCs are copied onto B, marked
// "Merged from Ticket #A". A closes with a link to B and sends no closed
// email or survey. Later replies to A's emails land on B (the mailbox
// follows MergedIntoId).
//
// Tickets with equipment, a room or a checklist can't be merged: those parts
// can't be moved safely, so close the extra ticket by hand instead.
endpoint(
  "mergeTicket",
  { methods: ["POST"], route: "tickets/{id:int}/merge", role: "technician", failMessage: "Could not merge the tickets" },
  async (request, context, user) => {
    const fromId = Number(request.params.id);
    const intoId = requiredId((await readJson(request)).intoId, "Ticket to merge into");
    if (fromId === intoId) throw new HttpError(400, "Pick a different ticket to merge into");
    const settings = await getSettings();
    if (!settings.ClosedStatusId) throw new HttpError(500, "Set the status for Close ticket in Settings");

    await withTransaction(async (tx) => {
      const from = await loadTicket(tx, fromId);
      const into = await loadTicket(tx, intoId);
      if (!from) throw new HttpError(404, "Ticket not found");
      if (!into) throw new HttpError(400, `There is no ticket ${formatNumber(intoId)}`);
      if (from.MergedIntoId) throw new HttpError(400, "This ticket was already merged");
      if (into.MergedIntoId) throw new HttpError(400, `Ticket ${formatNumber(intoId)} was merged into ${formatNumber(into.MergedIntoId)}. Merge into that one.`);
      const parts = await tx.request().input("Id", sql.Int, fromId).query(`
        SELECT (SELECT COUNT(*) FROM dbo.TicketItems WHERE TicketId = @Id) AS Items,
               (SELECT COUNT(*) FROM dbo.ChecklistItems WHERE TicketId = @Id) AS Checklist
      `);
      if (parts.recordset[0].Items || parts.recordset[0].Checklist || from.HasRoom) {
        throw new HttpError(400, "This ticket has equipment, a room or a checklist, so it can't be merged. Close it by hand instead.");
      }

      const label = `Merged from Ticket #${formatNumber(fromId)}`;
      // A's request becomes the first of the copied replies
      const request0 = await tx.request()
        .input("TicketId", sql.Int, intoId)
        .input("AuthorId", sql.Int, from.RequesterId)
        .input("Body", sql.NVarChar(sql.MAX), `<p><strong>${label}: ${escapeHtml(from.Subject)}</strong></p>${from.Description || ""}`)
        .input("CreatedAt", sql.DateTime2(0), from.CreatedAt)
        .input("FromId", sql.Int, fromId)
        .query(`
          INSERT INTO dbo.TicketConversations (TicketId, AuthorId, Body, IsTechnicianNote, Direction, CreatedAt, MergedFromTicketId)
          OUTPUT INSERTED.Id
          VALUES (@TicketId, @AuthorId, @Body, 0, 'in', @CreatedAt, @FromId)
        `);
      const conversationMap = new Map([[null, request0.recordset[0].Id]]);
      const replies = await tx.request().input("Id", sql.Int, fromId)
        .query("SELECT * FROM dbo.TicketConversations WHERE TicketId = @Id ORDER BY CreatedAt, Id");
      for (const c of replies.recordset) {
        const copy = await tx.request()
          .input("TicketId", sql.Int, intoId)
          .input("AuthorId", sql.Int, c.AuthorId)
          .input("Body", sql.NVarChar(sql.MAX), c.Body)
          .input("IsNote", sql.Bit, c.IsTechnicianNote)
          .input("ForHr", sql.Bit, c.VisibleToEventManagers)
          .input("Direction", sql.NVarChar(3), c.Direction)
          .input("MessageId", sql.NVarChar(400), c.EmailMessageId)
          .input("CreatedAt", sql.DateTime2(0), c.CreatedAt)
          .input("EmailedAt", sql.DateTime2(0), c.EmailedAt)
          .input("EmailNote", sql.NVarChar(200), c.EmailNote)
          .input("FromId", sql.Int, fromId)
          .query(`
            INSERT INTO dbo.TicketConversations
              (TicketId, AuthorId, Body, IsTechnicianNote, VisibleToEventManagers, Direction, EmailMessageId, CreatedAt, EmailedAt, EmailNote, MergedFromTicketId)
            OUTPUT INSERTED.Id
            VALUES (@TicketId, @AuthorId, @Body, @IsNote, @ForHr, @Direction, @MessageId, @CreatedAt, @EmailedAt, @EmailNote, @FromId)
          `);
        conversationMap.set(c.Id, copy.recordset[0].Id);
      }

      // Attachments point at the same stored files; pasted images in the
      // copied text are pointed at their copies.
      const files = await tx.request().input("Id", sql.Int, fromId).query("SELECT * FROM dbo.Attachments WHERE TicketId = @Id ORDER BY Id");
      const imageMap = new Map();
      for (const a of files.recordset) {
        const copy = await tx.request()
          .input("TicketId", sql.Int, intoId)
          .input("ConversationId", sql.Int, conversationMap.get(a.ConversationId ?? null))
          .input("FileName", sql.NVarChar(255), a.FileName)
          .input("ContentType", sql.NVarChar(150), a.ContentType)
          .input("SizeBytes", sql.BigInt, a.SizeBytes)
          .input("BlobPath", sql.NVarChar(500), a.BlobPath)
          .input("UploadedById", sql.Int, a.UploadedById)
          .input("CreatedAt", sql.DateTime2(0), a.CreatedAt)
          .input("IsInline", sql.Bit, a.IsInline)
          .query(`
            INSERT INTO dbo.Attachments (TicketId, ConversationId, FileName, ContentType, SizeBytes, BlobPath, UploadedById, CreatedAt, IsInline)
            OUTPUT INSERTED.Id
            VALUES (@TicketId, @ConversationId, @FileName, @ContentType, @SizeBytes, @BlobPath, @UploadedById, @CreatedAt, @IsInline)
          `);
        imageMap.set(a.Id, copy.recordset[0].Id);
      }
      if (imageMap.size) {
        for (const newId of conversationMap.values()) {
          const row = (await tx.request().input("Id", sql.Int, newId).query("SELECT Body FROM dbo.TicketConversations WHERE Id = @Id")).recordset[0];
          const body = row.Body.replace(/src="\/api\/attachments\/(\d+)"/g, (whole, id) =>
            imageMap.has(Number(id)) ? `src="/api/attachments/${imageMap.get(Number(id))}"` : whole);
          if (body !== row.Body) {
            await tx.request().input("Id", sql.Int, newId).input("Body", sql.NVarChar(sql.MAX), body)
              .query("UPDATE dbo.TicketConversations SET Body = @Body WHERE Id = @Id");
          }
        }
      }

      // A's requester and CCs follow the conversation onto B
      await tx.request().input("From", sql.Int, fromId).input("Into", sql.Int, intoId).query(`
        INSERT INTO dbo.TicketCc (TicketId, Email)
        SELECT DISTINCT @Into, x.Email
        FROM (
          SELECT c.Email FROM dbo.TicketCc c WHERE c.TicketId = @From
          UNION SELECT u.Email FROM dbo.Tickets t JOIN dbo.Users u ON u.Id = t.RequesterId WHERE t.Id = @From
        ) x
        WHERE x.Email <> (SELECT u.Email FROM dbo.Tickets t JOIN dbo.Users u ON u.Id = t.RequesterId WHERE t.Id = @Into)
          AND NOT EXISTS (SELECT 1 FROM dbo.TicketCc e WHERE e.TicketId = @Into AND e.Email = x.Email)
      `);

      // Close A, pointing at B. No email: the requester already has B.
      const closed = await getStatus(tx, settings.ClosedStatusId);
      await tx.request().input("Id", sql.Int, fromId).input("Into", sql.Int, intoId).input("StatusId", sql.Int, settings.ClosedStatusId)
        .query(`UPDATE dbo.Tickets SET MergedIntoId = @Into, StatusId = @StatusId, ${statusTimingSql(closed)} WHERE Id = @Id`);
      await recordEvents(tx, fromId, user.Id, [
        { field: "Merged into", newValue: `Ticket #${formatNumber(intoId)}` },
        { field: "Status", oldValue: from.StatusName, newValue: closed.Name }
      ]);
      await recordEvents(tx, intoId, user.Id, [{ field: "Merged from", newValue: `Ticket #${formatNumber(fromId)}: ${from.Subject}` }]);
    });

    const pool = await getConnection();
    return { jsonBody: { ticket: forViewer(await loadTicket(pool, intoId), user) } };
  }
);
