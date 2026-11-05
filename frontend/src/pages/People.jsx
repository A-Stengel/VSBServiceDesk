import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { ListTabs, ListToolbar, SortTh, useListView } from "../components/ListView.jsx";
import { peopleList } from "../lists.js";

// Everyone in the user list: staff, outside people and shared mailboxes.
// Outside people and shared mailboxes only email in, so their role shows as
// "Email only". Open a person to see what they hold and start a request.
export function roleLabel(person, lookups) {
  return person.UserTypeId !== lookups.defaults.staffUserTypeId ? "Email only" : person.RoleName || "None";
}

export default function People() {
  const { lookups } = useApp();
  const [people, setPeople] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.users({ includeInactive: 1 }).then(setPeople).catch((e) => setError(e.message));
  }, []);

  const def = useMemo(() => peopleList({ lookups }), [lookups]);
  const list = useListView(def, { defaultSort: { key: "name", dir: "asc" } });
  const rows = list.ready ? list.apply(people) : null;

  return (
    <>
      <div className="head-row">
        <h1>People</h1>
        {rows && <span className="muted small">{rows.length} {rows.length === 1 ? "person" : "people"}</span>}
      </div>
      <ListTabs list={list} />
      <ListToolbar list={list} placeholder="Search name, email or department" />
      {error && <p className="error">{error}</p>}
      {!rows && <p className="muted">Loading…</p>}
      {rows && !rows.length && <p className="empty">Nobody here.</p>}
      {rows && rows.length > 0 && (
        <div className="card flush scroll">
          <table className="tbl" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <SortTh list={list} col="name">Name</SortTh>
                <SortTh list={list} col="email">Email</SortTh>
                <SortTh list={list} col="role">Role</SortTh>
                <SortTh list={list} col="department">Department</SortTh>
                <SortTh list={list} col="type">Account type</SortTh>
                <SortTh list={list} col="status">Status</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.Id}>
                  <td><Link className="link" to={`/people/${p.Id}`}>{p.DisplayName}</Link></td>
                  <td className="small">{p.Email}</td>
                  <td>{roleLabel(p, lookups)}</td>
                  <td>{p.DepartmentName || <span className="muted">None</span>}</td>
                  <td>{p.UserTypeName}</td>
                  <td>{p.IsActive ? "Active" : <span className="muted">Off</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
