import { useEffect, useState } from "react";
import { api } from "../api.js";

// Type-ahead for picking a person. Technicians search everyone; other staff
// search active staff only.
export default function PersonPicker({ value, onChange, technician, placeholder = "Start typing a name or email" }) {
  const [text, setText] = useState("");
  const [results, setResults] = useState([]);

  useEffect(() => {
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      const search = technician ? api.users({ search: text }) : api.searchPeople(text);
      search.then((rows) => setResults(rows.slice(0, 20))).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [text, technician]);

  if (value) {
    return (
      <div className="picked">
        <span>{value.DisplayName} <span className="muted">{value.Email}</span></span>
        <button type="button" className="link" onClick={() => onChange(null)}>Change</button>
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
              <button type="button" onClick={() => { onChange(p); setText(""); }}>
                {p.DisplayName} <span className="muted">{p.Email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
