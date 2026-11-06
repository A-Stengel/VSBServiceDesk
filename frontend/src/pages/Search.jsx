import { Fragment, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, formatDate } from "../api.js";

// Search every ticket, open or closed (technicians). It looks at the number
// and old number, title, requester, who it's for, CC, the description, and
// every reply and note. Every word has to be on the ticket somewhere.
export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const [text, setText] = useState(q);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setText(q);
    setError("");
    if (!q.trim()) {
      setResult(null);
      return;
    }
    setResult(undefined);
    let current = true;
    api.searchTickets(q)
      .then((r) => { if (current) setResult(r); })
      .catch((e) => { if (current) { setError(e.message); setResult(null); } });
    return () => { current = false; };
  }, [q]);

  return (
    <>
      <div className="head-row">
        <h1>Search tickets</h1>
      </div>
      <form className="toolbar" role="search" onSubmit={(e) => { e.preventDefault(); setParams(text.trim() ? { q: text.trim() } : {}); }}>
        <input type="search" autoFocus placeholder="Words from the ticket, a name, an email or a ticket number" aria-label="Search tickets"
          value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn pri sm" type="submit">Search</button>
      </form>
      <p className="muted small">Looks through open and closed tickets: number, title, requester, who it&apos;s for, CC, description, replies and notes.</p>
      {error && <p className="error">{error}</p>}
      {result === undefined && <p className="muted">Searching…</p>}
      {result && result.tickets.length === 0 && <p className="empty">No tickets match “{q}”.</p>}
      {result && result.tickets.length > 0 && (
        <>
          <p className="muted small">
            {result.more ? "Showing the first 100 tickets. Add more words to narrow it down." : `${result.tickets.length} ticket${result.tickets.length === 1 ? "" : "s"}`}
          </p>
          <div className="card flush search-results">
            {result.tickets.map((t) => (
              <Link key={t.Id} to={`/tickets/${t.Id}`} className="search-row">
                <span className="row spread center">
                  <span className="search-subject"><Marked text={t.Subject} words={result.words} /></span>
                  {t.StatusName && <span className="pill" style={{ background: t.StatusColor || undefined }}>{t.StatusName}</span>}
                </span>
                <span className="muted small">
                  #{t.Number}{t.LegacyId ? ` (old ${t.LegacyId})` : ""} · {t.RequesterName} · {t.TechnicianName || "Unassigned"} · {formatDate(t.CreatedAt)}
                </span>
                {t.Snippet && (
                  <span className="search-snippet small">
                    <strong>{t.MatchIn}:</strong> <Marked text={t.Snippet} words={result.words} />
                  </span>
                )}
              </Link>
            ))}
          </div>
        </>
      )}
    </>
  );
}

// The text with the searched words highlighted.
function Marked({ text, words }) {
  const list = (words || []).map((w) => w.replace(/^#/, "")).filter(Boolean);
  if (!text || !list.length) return text || null;
  const pattern = new RegExp(`(${list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return String(text).split(pattern).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}
