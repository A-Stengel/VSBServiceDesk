import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import TicketTable from "../components/TicketTable.jsx";
import { ListTabs, ListToolbar, useListView } from "../components/ListView.jsx";
import { ticketList } from "../lists.js";

// Every ticket list in one page. The tabs are the person's own (see
// ListView.jsx); each one says which tickets it loads (mine or the whole
// queue, open or closed) and which of those it shows. Department managers can
// switch on their departments' tickets, which joins them to "my" tickets.
export default function Tickets() {
  const { me, roles, lookups, notify } = useApp();
  const [data, setData] = useState({});
  const [technicians, setTechnicians] = useState([]);
  const [held, setHeld] = useState(0);
  const [error, setError] = useState("");
  const [showDepartments, setShowDepartments] = useState(!!me.ShowDepartmentTickets);
  const manager = (me.ManagedDepartmentIds || []).length > 0;

  const def = useMemo(() => ticketList({ me, roles, lookups, technicians }), [me, roles, lookups, technicians]);
  const list = useListView(def, { defaultSort: null });
  const base = list.base || def.bases[0];
  const departments = manager && showDepartments && base.scope === "mine";
  const fetchKey = `${base.scope}:${base.state}:${departments ? 1 : 0}`;

  useEffect(() => {
    if (!roles.technician) return;
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
    api.heldMail().then((rows) => setHeld(rows.length)).catch(() => {});
  }, [roles.technician]);

  useEffect(() => {
    if (data[fetchKey]) return;
    api.tickets({ scope: base.scope, state: base.state, departments: departments ? 1 : undefined })
      .then((rows) => setData((d) => ({ ...d, [fetchKey]: rows })))
      .catch((e) => setError(e.message));
  }, [fetchKey, data, base.scope, base.state, departments]);

  async function toggleDepartments(on) {
    setShowDepartments(on);
    try {
      await api.setDepartmentTickets(on);
    } catch (err) {
      notify(err.message, true);
    }
  }

  const departmentName = (id) => lookups.departments.find((d) => d.Id === id)?.Name;
  const tagged = useMemo(() => {
    const rows = data[fetchKey];
    if (!rows || !departments) return rows;
    const email = String(me.Email || "").toLowerCase();
    const managed = me.ManagedDepartmentIds || [];
    return rows.map((t) => {
      const mine = t.RequesterId === me.Id || t.ForUserId === me.Id || String(t.CcEmails || "").toLowerCase().split(",").includes(email);
      if (mine) return t;
      const dept = [t.RequesterDepartmentId, t.ForUserDepartmentId, t.ForDepartmentId].find((d) => d && managed.includes(d));
      return { ...t, DepartmentTag: departmentName(dept) || "Your department" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, fetchKey, departments, me]);

  const rows = list.apply(tagged);

  return (
    <>
      <div className="head-row">
        <h1>Tickets</h1>
        <div className="row center">
          {rows && <span className="muted small">{rows.length} ticket{rows.length === 1 ? "" : "s"}</span>}
          {held > 0 && <Link className="btn sm" to="/held-mail">{held} held email{held === 1 ? "" : "s"}</Link>}
          <Link className="btn pri sm" to="/new">Submit a request</Link>
        </div>
      </div>
      <ListTabs list={list} />
      <ListToolbar list={list} placeholder="Search number, title or requester">
        {manager && base.scope === "mine" && (
          <label className="check dept-switch">
            <input type="checkbox" checked={showDepartments} onChange={(e) => toggleDepartments(e.target.checked)} />
            Show my departments&apos; tickets
          </label>
        )}
      </ListToolbar>
      {error && <p className="error">{error}</p>}
      {list.error && <p className="error">{list.error}</p>}
      {rows && list.ready ? <TicketTable tickets={rows} list={list} technician={roles.technician} /> : <p className="muted">Loading…</p>}
      {departments && (
        <p className="muted small">Tickets tagged with a department are from people in departments you manage. You can open them and reply.</p>
      )}
    </>
  );
}
