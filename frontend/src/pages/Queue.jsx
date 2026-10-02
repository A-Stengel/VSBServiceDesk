import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import TicketTable from "../components/TicketTable.jsx";

// The shared IT queue: every ticket, with filters.
export default function Queue() {
  const { lookups } = useApp();
  const [filters, setFilters] = useState({ state: "open", technicianId: "", statusId: "", ticketTypeId: "", priorityId: "", search: "" });
  const [technicians, setTechnicians] = useState([]);
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState("");
  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  useEffect(() => {
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      api.tickets({ scope: "queue", ...filters }).then(setTickets).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(timer);
  }, [filters]);

  return (
    <div className="card">
      <h1>Queue</h1>
      <div className="filters">
        <select value={filters.state} onChange={set("state")}>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
          <option value="all">All</option>
        </select>
        <select value={filters.technicianId} onChange={set("technicianId")}>
          <option value="">Anyone</option>
          <option value="me">Assigned to me</option>
          <option value="none">Unassigned</option>
          {technicians.map((t) => <option key={t.Id} value={t.Id}>{t.DisplayName}</option>)}
        </select>
        <select value={filters.statusId} onChange={set("statusId")}>
          <option value="">Any status</option>
          {lookups.statuses.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
        </select>
        <select value={filters.ticketTypeId} onChange={set("ticketTypeId")}>
          <option value="">Any type</option>
          {lookups.ticketTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
        </select>
        <select value={filters.priorityId} onChange={set("priorityId")}>
          <option value="">Any priority</option>
          {lookups.priorities.map((p) => <option key={p.Id} value={p.Id}>{p.Name}</option>)}
        </select>
        <input placeholder="Search number, title or requester" value={filters.search} onChange={set("search")} />
      </div>
      {error && <p className="error">{error}</p>}
      {tickets ? <TicketTable tickets={tickets} /> : <p className="muted">Loading…</p>}
    </div>
  );
}
