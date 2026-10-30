import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import TicketTable from "../components/TicketTable.jsx";
import { ListTabs, ListToolbar, useListView } from "../components/ListView.jsx";

const PEOPLE_KINDS = ["onboarding", "offboarding"];

// Every ticket list in one page: your own tickets for everyone, and the IT
// queue tabs for technicians. Each tab says which tickets it loads (scope
// and state) and which of those it shows.
export default function Tickets() {
  const { me, roles, lookups } = useApp();
  const [data, setData] = useState({});
  const [technicians, setTechnicians] = useState([]);
  const [error, setError] = useState("");

  const tabs = useMemo(() => {
    const mine = { scope: "mine", state: "open" };
    const queue = { scope: "queue", state: "open" };
    const list = [
      { key: "mine", label: "My open", ...mine },
      { key: "waitingOnMe", label: "Waiting on me", ...mine, test: (t) => t.IsWaitingOnRequester && t.RequesterId === me.Id },
      { key: "myClosed", label: "My closed", scope: "mine", state: "closed" }
    ];
    if (roles.technician) {
      list.push(
        { key: "all", label: "All open", ...queue },
        { key: "unassigned", label: "Unassigned", ...queue, test: (t) => !t.TechnicianId },
        { key: "assigned", label: "Assigned to me", ...queue, test: (t) => t.TechnicianId === me.Id },
        { key: "waiting", label: "Waiting on requester", ...queue, test: (t) => t.IsWaitingOnRequester },
        { key: "people", label: "Onboarding and offboarding", ...queue, test: (t) => PEOPLE_KINDS.includes(t.ChecklistSource) },
        { key: "closed", label: "Closed", scope: "queue", state: "closed" }
      );
    }
    return list;
  }, [me.Id, roles.technician]);

  const filters = useMemo(() => [
    { key: "status", label: "Status", options: lookups.statuses.map((s) => ({ value: String(s.Id), label: s.Name })), test: (t, v) => t.StatusId === Number(v) },
    { key: "priority", label: "Priority", options: lookups.priorities.map((p) => ({ value: String(p.Id), label: p.Name })), test: (t, v) => t.PriorityId === Number(v) },
    ...(roles.technician
      ? [{
          key: "assigned",
          label: "Assigned to",
          options: [{ value: "none", label: "Unassigned" }, ...technicians.map((t) => ({ value: String(t.Id), label: t.DisplayName }))],
          test: (t, v) => (v === "none" ? !t.TechnicianId : t.TechnicianId === Number(v))
        }]
      : []),
    { key: "type", label: "Type", options: lookups.ticketTypes.map((t) => ({ value: String(t.Id), label: t.Name })), test: (t, v) => t.TicketTypeId === Number(v) }
  ], [lookups, technicians, roles.technician]);

  const columns = useMemo(() => ({
    number: (t) => t.Id,
    subject: (t) => t.Subject,
    type: (t) => t.TicketTypeName,
    assigned: (t) => t.TechnicianName || "",
    requester: (t) => t.RequesterName,
    status: (t) => t.StatusName,
    priority: (t) => t.PriorityRank,
    created: (t) => t.CreatedAt,
    activity: (t) => t.UpdatedAt,
    department: (t) => t.DepartmentName || ""
  }), []);

  const list = useListView({
    listKey: "tickets",
    tabs,
    defaultTab: "mine",
    filters,
    columns,
    search: (t) => `${t.Number} ${t.Subject} ${t.RequesterName} ${t.RequesterEmail} ${t.ForUserName || ""} ${t.ForPersonName || ""}`
  });
  const tab = tabs.find((t) => t.key === list.tab);
  const fetchKey = `${tab.scope}:${tab.state}`;

  useEffect(() => {
    if (roles.technician) api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, [roles.technician]);

  useEffect(() => {
    if (data[fetchKey]) return;
    const [scope, state] = fetchKey.split(":");
    api.tickets({ scope, state }).then((rows) => setData((d) => ({ ...d, [fetchKey]: rows }))).catch((e) => setError(e.message));
  }, [fetchKey, data]);

  const rows = list.apply(data[fetchKey]);
  const title = list.view ? list.view.Name : tab.scope === "queue" ? "Tickets" : "My tickets";

  return (
    <>
      <div className="head-row">
        <h1>{title}</h1>
        <div className="row center">
          {rows && <span className="muted small">{rows.length} ticket{rows.length === 1 ? "" : "s"}</span>}
          <Link className="btn pri sm" to="/new">Submit a request</Link>
        </div>
      </div>
      <ListTabs list={list} />
      <ListToolbar list={list} placeholder="Search number, title or requester" />
      {error && <p className="error">{error}</p>}
      {rows ? <TicketTable tickets={rows} list={list} technician={roles.technician} /> : <p className="muted">Loading…</p>}
    </>
  );
}
