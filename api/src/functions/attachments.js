const { endpoint } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { downloadFile } = require("../shared/storage");
const { loadVisibleTicket, accessOf } = require("../shared/tickets");
const { INLINE_TYPES } = require("../shared/attachments");

// Downloads an attachment, or shows an image pasted into the text. Files on
// technician notes are only for technicians; files on HR notes are for
// technicians and Event Managers.
endpoint("getAttachment", { methods: ["GET"], route: "attachments/{id:int}" }, async (request, context, user) => {
  const pool = await getConnection();
  const result = await pool.request().input("Id", sql.Int, Number(request.params.id)).query(`
    SELECT a.TicketId, a.FileName, a.ContentType, a.BlobPath, a.IsInline, c.IsTechnicianNote, c.VisibleToEventManagers
    FROM dbo.Attachments a
    LEFT JOIN dbo.TicketConversations c ON c.Id = a.ConversationId
    WHERE a.Id = @Id
  `);
  const attachment = result.recordset[0];
  if (!attachment) throw new HttpError(404, "File not found");
  const ticket = await loadVisibleTicket(pool, attachment.TicketId, user);
  const access = accessOf(user, ticket);
  if (attachment.IsTechnicianNote && !access.technicianNotes && !(attachment.VisibleToEventManagers && access.hrNotes)) {
    throw new HttpError(404, "File not found");
  }

  const buffer = await downloadFile(attachment.BlobPath);
  const showInline = attachment.IsInline && INLINE_TYPES.includes(attachment.ContentType);
  const asciiName = attachment.FileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return {
    status: 200,
    body: buffer,
    headers: {
      "Content-Type": attachment.ContentType || "application/octet-stream",
      "Content-Disposition": `${showInline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.FileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": attachment.IsInline ? "private, max-age=3600" : "private, no-store"
    }
  };
});
