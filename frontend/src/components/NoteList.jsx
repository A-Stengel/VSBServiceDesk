import { useState } from "react";

// A list written one entry at a time, like notes: type an entry, click Add
// (or press Enter), and it joins the list. Used for shared mailboxes,
// calendars and phone lines.
export default function NoteList({ label, items, onAdd, onRemove, placeholder, disabled = false }) {
  const [text, setText] = useState("");
  const add = () => {
    const entry = text.trim();
    if (!entry) return;
    if (!items.some((i) => i.toLowerCase() === entry.toLowerCase())) onAdd(entry);
    setText("");
  };
  return (
    <div className="note-list">
      <span className="note-list-label">{label}</span>
      {items.length > 0 ? (
        <ul>
          {items.map((entry, index) => (
            <li key={entry}>
              <span>{entry}</span>
              {!disabled && (
                <button type="button" className="link small" onClick={() => onRemove(index)} aria-label={`Remove ${entry}`}>Remove</button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None yet.</p>
      )}
      {!disabled && (
        <div className="note-list-add">
          <input value={text} placeholder={placeholder} aria-label={`Add to ${label}`} maxLength={200}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <button type="button" className="btn sm" onClick={add} disabled={!text.trim()}>Add</button>
        </div>
      )}
    </div>
  );
}
