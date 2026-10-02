const { endpoint } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, sql } = require("../shared/db");
const { downloadFile } = require("../shared/storage");
const { loadVisibleTicket } = require("../shared/tickets");

// Downloads an attachment. Files on technician notes are only for technicians.
endpoint("getAttachment", { methods: ["GET"], route: "attachments/{id:int}" }, async (request, context, user) => {
  const pool = await getConnection();
  const result = await pool.request().input("Id", sql.Int, Number(request.params.id)).query(`
    SELECT a.TicketId, a.FileName, a.ContentType, a.BlobPath, c.IsTechnicianNote
    FROM dbo.Attachments a
    LEFT JOIN dbo.TicketConversations c ON c.Id = a.ConversationId
    WHERE a.Id = @Id
  `);
  const attachment = result.recordset[0];
  if (!attachment) throw new HttpError(404, "File not found");
  await loadVisibleTicket(pool, attachment.TicketId, user);
  if (attachment.IsTechnicianNote && !user.IsTechnician) throw new HttpError(404, "File not found");

  const buffer = await downloadFile(attachment.BlobPath);
  const asciiName = attachment.FileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return {
    status: 200,
    body: buffer,
    headers: {
      "Content-Type": attachment.ContentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.FileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store"
    }
  };
});
