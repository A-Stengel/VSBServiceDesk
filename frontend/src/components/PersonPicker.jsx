import { useEffect, useState } from "react";
import { api } from "../api.js";

// Type-ahead for picking a person. Technicians search everyone; other staff
// search active staff only. managedOnly keeps it to the departments the
// person manages.
//
// The pickers sit inside <label>s. The buttons call preventDefault so the
// label doesn't pass the click on to whichever button replaces them, which
// undid the pick straight away.
export default function PersonPicker({ value, onChange, technician, managedOnly, placeholder = "Start typing a name or email" }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState([]);

  useEffect(() => {
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      const search = technician ? api.users({ search: text }) : api.searchPeople(text, managedOnly);
      search.then((rows) => setResults(rows.slice(0, 20))).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, technician, managedOnly]);

  if (value) {
    return (
      <div className="picked">
        <span>{value.DisplayName} <span className="muted">{value.Email}</span></span>
        <button type="button" className="link" onClick={(e) => { e.preventDefault(); onChange(null); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="picker">
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
      {results.length > 0 && (
        <ul className="picker-results">
          {results.map((p) => (
            <li key={p.Id}>
              <button type="button" onClick={(e) => { e.preventDefault(); onChange(p); setText(""); }}>
                {p.DisplayName} <span className="muted">{p.Email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
