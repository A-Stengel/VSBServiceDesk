const { randomUUID } = require("crypto");
const { sql } = require("./db");
const { uploadFile } = require("./storage");
const { sanitizeRich } = require("./richtext");

// Picture types that can show inside the text (not SVG, which can carry
// script).
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// Saves uploaded files to Blob Storage and records them on the ticket. Files
// named in "inlineNames" are images pasted into the text: they're marked
// IsInline, so they show in the text rather than the attachment list.
// Returns a Map of file name to the new attachment's Id.
async function saveAttachments(db, ticketId, conversationId, files, userId, inlineNames = []) {
  const ids = new Map();
  for (const file of files) {
    const safeName = file.name.replace(/[^\w.\- ]+/g, "_");
    const blobPath = `tickets/${ticketId}/${randomUUID()}-${safeName}`;
    const inline = inlineNames.includes(file.name);
    if (inline && !INLINE_TYPES.includes(file.type)) continue;
    await uploadFile(blobPath, file.buffer, file.type);
    const result = await db
      .request()
      .input("TicketId", sql.Int, ticketId)
      .input("ConversationId", sql.Int, conversationId)
      .input("FileName", sql.NVarChar(255), file.name)
      .input("ContentType", sql.NVarChar(150), file.type.slice(0, 150))
      .input("SizeBytes", sql.BigInt, file.buffer.length)
      .input("BlobPath", sql.NVarChar(500), blobPath)
      .input("UploadedById", sql.Int, userId)
      .input("IsInline", sql.Bit, inline)
      .query(`
        INSERT INTO dbo.Attachments (TicketId, ConversationId, FileName, ContentType, SizeBytes, BlobPath, UploadedById, IsInline)
        OUTPUT INSERTED.Id
        VALUES (@TicketId, @ConversationId, @FileName, @ContentType, @SizeBytes, @BlobPath, @UploadedById, @IsInline)
      `);
    ids.set(file.name, result.recordset[0].Id);
  }
  return ids;
}

// The rich text as it's stored: pasted images ("cid:<file name>") point at
// their saved attachments, and only images on this ticket are kept.
async function finishRichText(db, ticketId, html, savedIds = new Map()) {
  const linked = String(html || "").replace(/src="cid:([^"]+)"/g, (whole, name) => {
    const id = savedIds.get(name);
    return id ? `src="/api/attachments/${id}"` : 'src=""';
  });
  const rows = await db.request().input("TicketId", sql.Int, ticketId)
    .query("SELECT Id FROM dbo.Attachments WHERE TicketId = @TicketId AND IsInline = 1");
  const own = new Set(rows.recordset.map((r) => r.Id));
  return sanitizeRich(linked, { allowImage: (id) => own.has(id) });
}

// The names of the pasted images sent with a form ("inline": [names]).
function readInlineNames(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((name) => typeof name === "string").slice(0, 20);
}

module.exports = { saveAttachments, finishRichText, readInlineNames, INLINE_TYPES };
