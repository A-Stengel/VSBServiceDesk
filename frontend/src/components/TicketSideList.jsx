import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatDate } from "../api.js";
import { useApp } from "../App.jsx";
import { applyList, describeSettings, normalizeSettings, readTicketContext, ticketList } from "../lists.js";

const OPEN_KEY = "ticketSideListOpen";
const remembered = () => {
  try {
    return localStorage.getItem(OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};
const initials = (name) => String(name || "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

// The ticket page for technicians: the Tickets list they came from (same
// tab, filters, search and sort, saved or not) down the left, so they can
// move from ticket to ticket. It can be hidden; on narrow screens it opens
// over the page from a button.
export default function WithTicketList({ id, children }) {
  const { me, roles, lookups } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(remembered);
  const [drawer, setDrawer] = useState(false);
  const [tabs, setTabs] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [view, setView] = useState(() => readTicketContext());
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const listRef = useRef(null);

  const def = useMemo(() => ticketList({ me, roles, lookups, technicians }), [me, roles, lookups, technicians]);

  useEffect(() => {
    api.views("tickets").then(setTabs).catch((e) => { setTabs([]); setError(e.message); });
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, []);

  // Opened without coming from the list (a link or a bookmark): the first tab.
  const tab = tabs?.find((t) => t.Id === view?.tabId) || tabs?.[0] || null;
  const settings = view?.tabId === tab?.Id && view?.settings ? normalizeSettings(def, view.settings) : normalizeSettings(def, tab?.Settings);
  const search = view?.tabId === tab?.Id ? view?.search || "" : "";
  const changed = view?.tabId === tab?.Id && !!view?.changed;
  const departments = view?.tabId === tab?.Id && !!view?.departments;
  const base = def.bases.find((b) => b.key === settings.base) || def.bases[0];

  // Reloaded on every ticket so a change made here shows in the list.
  useEffect(() => {
    if (!tab) return;
    api.tickets({ scope: base.scope, state: base.state, departments: departments ? 1 : undefined })
      .then((list) => { setRows(list); setError(""); })
      .catch((e) => setError(e.message));
  }, [tab, base.scope, base.state, departments, id]);

  const shown = useMemo(() => applyList(def, rows, { filters: settings.filters, search, sort: settings.sort }), [def, rows, settings.filters, settings.sort, search]);
  const index = shown ? shown.findIndex((t) => t.Id === Number(id)) : -1;

  useEffect(() => {
    listRef.current?.querySelector(".side-row.on")?.scrollIntoView({ block: "nearest" });
  }, [index, open, drawer]);

  function show(on) {
    setOpen(on);
    try {
      localStorage.setItem(OPEN_KEY, on ? "1" : "0");
    } catch {
      // Not remembered when storage is blocked.
    }
  }

  function pickTab(tabId) {
    setView({ tabId: Number(tabId), settings: null, search: "", changed: false, departments: false });
    setRows(null);
  }

  const go = (ticket) => {
    setDrawer(false);
    navigate(`/tickets/${ticket.Id}`);
  };

  const backTo = tab && tab.Id !== tabs?.[0]?.Id ? `/tickets?tab=${tab.Id}` : "/tickets";
  const chips = tab ? describeSettings(def, settings).split(" · ") : [];
  const position = shown && (index >= 0 ? `${index + 1} of ${shown.length}` : `${shown.length} ticket${shown.length === 1 ? "" : "s"}, not this one`);

  const panel = (
    <aside className="card side-list" aria-label="Ticket list">
      <div className="side-head">
        <div className="row spread center">
          <Link className="link small" to={backTo}>‹ Back to Tickets</Link>
          <button className="btn sm" title="Hide the list" aria-label="Hide the ticket list"
            onClick={() => (drawer ? setDrawer(false) : show(false))}>«</button>
        </div>
        {tabs && tabs.length > 0 && (
          <select aria-label="Tab" value={tab?.Id ?? ""} onChange={(e) => pickTab(e.target.value)}>
            {tabs.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
          </select>
        )}
        <div className="side-chips">
          {chips.map((c) => <span key={c} className="side-chip">{c}</span>)}
          {search && <span className="side-chip">Search: “{search}”</span>}
          {departments && <span className="side-chip">With my departments</span>}
          {changed && <span className="side-chip unsaved" title="Changed on the Tickets page and not saved to the tab">Not saved to the tab</span>}
        </div>
        <div className="row spread center">
          <span className="muted small">{position || ""}</span>
          <span className="row" style={{ gap: 4 }}>
            <button className="btn sm" title="Previous ticket" aria-label="Previous ticket" disabled={index <= 0} onClick={() => go(shown[index - 1])}>↑</button>
            <button className="btn sm" title="Next ticket" aria-label="Next ticket" disabled={index < 0 || index >= shown.length - 1} onClick={() => go(shown[index + 1])}>↓</button>
          </span>
        </div>
      </div>
      <div className="side-rows" ref={listRef}>
        {error && <p className="error small" style={{ padding: "0 12px" }}>{error}</p>}
        {!shown && !error && <p className="muted small" style={{ padding: "0 12px" }}>Loading…</p>}
        {shown && shown.length === 0 && <p className="empty">No tickets in this tab.</p>}
        {shown && shown.map((t) => (
          <Link key={t.Id} to={`/tickets/${t.Id}`} onClick={() => setDrawer(false)}
            className={`side-row ${t.Id === Number(id) ? "on" : ""}`} aria-current={t.Id === Number(id) ? "page" : undefined}>
            <span className="side-subject" title={t.Subject}>{t.Subject}</span>
            <span className="side-meta">
              <span>#{t.Number} · {formatDate(t.CreatedAt)}</span>
              <span className="pill" style={{ background: t.StatusColor || undefined }}>{t.StatusName}</span>
            </span>
            <span className="side-meta">
              <span>{t.RequesterName || "No requester"}</span>
              <span className={`initials ${t.TechnicianName ? "" : "none"}`} title={t.TechnicianName || "Unassigned"}>
                {t.TechnicianName ? initials(t.TechnicianName) : "?"}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </aside>
  );

  return (
    <div className={`with-list ${open ? "open" : "closed"} ${drawer ? "drawer" : ""}`}>
      {open || drawer ? panel : (
        <div className="card side-rail">
          <button className="btn sm" title="Show the list" aria-label="Show the ticket list" onClick={() => show(true)}>»</button>
          <span className="side-rail-text">Ticket list{index >= 0 ? ` · ${index + 1} of ${shown.length}` : ""}</span>
        </div>
      )}
      {drawer && <button className="side-backdrop" aria-label="Close the ticket list" onClick={() => setDrawer(false)} />}
      <div className="with-list-main">
        <button className="btn sm side-list-btn" onClick={() => setDrawer(true)}>☰ Ticket list</button>
        {children}
      </div>
    </div>
  );
}
