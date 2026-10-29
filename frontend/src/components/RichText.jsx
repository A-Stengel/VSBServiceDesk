import { isRich } from "../richtext.js";

// Shows rich text, or older plain text with its line breaks. The server
// cleans rich text before saving it, so it can be shown as HTML.
export default function RichText({ value, className = "", empty = null }) {
  if (!value) return empty;
  if (!isRich(value)) return <div className={`body ${className}`}>{value}</div>;
  return <div className={`rich ${className}`} dangerouslySetInnerHTML={{ __html: value }} />;
}
