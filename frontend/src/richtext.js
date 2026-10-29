// Rich text (descriptions, replies, notes, the booking guidelines) is HTML
// that the server has already cleaned. Text saved before rich text existed is
// plain; rich text always starts with one of these block tags.
const BLOCK_START = /^<(p|ul|ol|h[1-4]|blockquote)>/;

export const isRich = (value) => BLOCK_START.test(String(value || ""));

// True when the editor holds words or a picture.
export function hasContent(html) {
  if (!html) return false;
  if (/<img\s/i.test(html)) return true;
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent.trim().length > 0;
}

const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Plain text (for example a prefilled description) as rich text, keeping
// paragraphs and line breaks.
export function plainToRich(text) {
  const value = String(text || "").replace(/\r\n?/g, "\n").trim();
  if (!value || isRich(value)) return value;
  return value.split(/\n{2,}/).map((para) => `<p>${escape(para).replace(/\n/g, "<br>")}</p>`).join("");
}

// The editor's HTML and any pictures pasted into it, ready to send with a
// form: { data, files } where data[key] is the HTML and data.inline names the
// pictures among the files.
export function withPastedImages(data, key, files = []) {
  const extracted = extractInlineImages(data[key]);
  return { data: { ...data, [key]: extracted.html, inline: extracted.inline }, files: [...files, ...extracted.files] };
}

const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

// Pictures pasted into the editor are held in the text as data: URLs. Before
// sending, each becomes a file named in the text as "cid:<name>"; the server
// saves the files and points the text at them. Returns the HTML to send, the
// files, and their names (the form's "inline" list).
export function extractInlineImages(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ""}</body>`, "text/html");
  const files = [];
  doc.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    const match = src.match(/^data:(image\/[a-z+]+);base64,(.*)$/i);
    if (!match) {
      // Only pictures already on the ticket are kept
      if (!/^\/api\/attachments\/\d+$/.test(src)) img.remove();
      return;
    }
    const type = match[1].toLowerCase();
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    const name = `pasted-${Date.now()}-${files.length + 1}.${EXTENSIONS[type] || "png"}`;
    files.push(new File([bytes], name, { type }));
    img.setAttribute("src", `cid:${name}`);
  });
  return { html: doc.body.innerHTML, files, inline: files.map((f) => f.name) };
}
