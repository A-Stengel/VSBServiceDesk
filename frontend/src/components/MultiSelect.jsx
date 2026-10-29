import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";

// A dropdown that holds several choices: the field shows what's picked, and
// opening it lists every option with a tick box (and a search box when the
// list is long). "onChange" gets the new list of picked values.
export default function MultiSelect({ options, value, onChange, label, placeholder = "None", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const escape = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => { if (!open) setSearch(""); }, [open]);

  const picked = options.filter((o) => value.includes(o.value));
  const shown = options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()));
  const toggle = (option, on) => onChange(on ? [...value, option.value] : value.filter((v) => v !== option.value));

  return (
    <div className="multi" ref={box}>
      <button type="button" className="multi-field" aria-haspopup="true" aria-expanded={open} aria-label={label} disabled={disabled}
        onClick={() => setOpen(!open)}>
        <span className="multi-chips">
          {!picked.length && <span className="muted">{placeholder}</span>}
          {picked.map((o) => <span key={o.value} className="chip">{o.label}</span>)}
        </span>
        <Icon name="chevron" size={14} strokeWidth={2.4} />
      </button>
      {open && (
        <div className="card multi-menu" role="group" aria-label={label}>
          {options.length > 8 && (
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label={`Search ${label}`} autoFocus />
          )}
          <div className="multi-options">
            {shown.map((o) => (
              <label key={o.value} className="check">
                <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => toggle(o, e.target.checked)} />
                {o.label}
              </label>
            ))}
            {!shown.length && <span className="muted small">Nothing matches.</span>}
          </div>
          {picked.length > 0 && <button type="button" className="link small" onClick={() => onChange([])}>Clear all</button>}
        </div>
      )}
    </div>
  );
}
