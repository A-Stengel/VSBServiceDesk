const sanitizeHtml = require("sanitize-html");

// Rich text (ticket descriptions, replies, notes and the booking guidelines)
// is stored as HTML. Only what the editor's toolbar makes is kept, plus what
// commonly comes in when pasting from Word or Outlook (headings, quotes).
// Images may only point at the ticket's own attachments.
//
// Stored rich text always starts with one of these block tags. Older plain
// text doesn't, which is how the pages tell the two apart (script 11 turned
// the plain text saved before it into rich text).
const BLOCK_START = /^<(p|ul|ol|h[1-4]|blockquote)>/;

const TEXT_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "s", "ul", "ol", "li", "a", "blockquote", "h1", "h2", "h3", "h4"];

// "allowImage" is a function given each image's attachment id; it returns
// whether that image can stay. Without it, every image is removed.
function sanitizeRich(html, { allowImage } = {}) {
  const clean = sanitizeHtml(String(html || ""), {
    allowedTags: allowImage ? [...TEXT_TAGS, "img"] : TEXT_TAGS,
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    exclusiveFilter: (frame) => {
      if (frame.tag !== "img") return false;
      const match = /^\/api\/attachments\/(\d+)$/.exec(frame.attribs.src || "");
      return !match || !allowImage(Number(match[1]));
    },
    transformTags: {
      b: "strong",
      i: "em",
      a: (tagName, attribs) => ({ tagName, attribs: { href: attribs.href, target: "_blank", rel: "noopener noreferrer" } })
    }
  })
    .replace(/<p>(\s|&nbsp;|<br \/>)*<\/p>/g, "")
    .trim();
  if (!clean || BLOCK_START.test(clean)) return clean;
  // Text before the first paragraph or list goes in a paragraph of its own
  const first = clean.search(/<(p|ul|ol|h[1-4]|blockquote)>/);
  return first < 0 ? `<p>${clean}</p>` : `<p>${clean.slice(0, first).trim()}</p>${clean.slice(first)}`;
}

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Plain text (for example from the API or email) as rich text, keeping line
// breaks.
function plainToRich(text) {
  const value = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!value) return "";
  return value.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`).join("");
}

const isRich = (value) => BLOCK_START.test(String(value || ""));

// Rich text or older plain text, as one line of plain text (for history and
// previews).
function toPlain(value) {
  const text = isRich(value)
    ? sanitizeHtml(String(value).replace(/<\/(p|li|h[1-4]|blockquote)>|<br\s*\/?>/g, " "), { allowedTags: [], allowedAttributes: {} })
        .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    : String(value || "");
  return text.replace(/\s+/g, " ").trim();
}

// True when the text has words or an image in it.
const hasContent = (html) => !!toPlain(html) || /<img\s/.test(String(html || ""));

module.exports = { sanitizeRich, plainToRich, toPlain, isRich, hasContent, escapeHtml };
