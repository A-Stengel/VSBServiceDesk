import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";

// Everyone in the user list: staff, outside people and shared mailboxes.
// Admins set roles (promote to Technician or Admin), departments and the
// departments a manager looks after.
export default function People() {
  const { me, lookups } = useApp();
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [people, setPeople] = useState(null);
  const [roles, setRoles] = useState([]);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState("");

  const load = () => api.users({ search, includeInactive: includeInactive ? 1 : "" }).then(setPeople).catch((e) => setError(e.message));
  useEffect(() => {
    const timer = setTimeout(load, 250);
    return () => clearTimeout(timer);
  }, [search, includeInactive]);
  useEffect(() => setRoles(lookups.roles), [lookups]);

  async function save() {
    try {
      const changes = {
        firstName: editing.FirstName,
        lastName: editing.LastName,
        displayName: editing.DisplayName,
        roleId: editing.RoleId,
        departmentId: editing.DepartmentId || null,
        userTypeId: editing.UserTypeId,
        isActive: editing.IsActive,
        managedDepartmentIds: editing.ManagedDepartmentIds
      };
      if (editing.Id === me.Id) {
        delete changes.roleId; // you can't demote or switch off yourself
        delete changes.isActive;
      }
      await api.updateUser(editing.Id, changes);
      setEditing(null);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="card">
      <h1>People</h1>
      <div className="filters">
        <input placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
          Show switched-off people
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {!people ? <p className="muted">Loading…</p> : (
        <table className="grid">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Type</th><th>Role</th><th>Department</th><th>Manages</th><th>Active</th>{me.IsAdmin && <th />}</tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.Id}>
                <td>{p.DisplayName}</td>
                <td>{p.Email}</td>
                <td>{p.UserTypeName}</td>
                <td>{p.RoleName}</td>
                <td>{p.DepartmentName}</td>
                <td>{p.ManagedDepartmentIds.map((id) => lookups.departments.find((d) => d.Id === id)?.Name).filter(Boolean).join(", ")}</td>
                <td>{p.IsActive ? "Yes" : "No"}</td>
                {me.IsAdmin && <td><button className="link" onClick={() => setEditing({ ...p })}>Edit</button></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="dialog-backdrop" onClick={() => setEditing(null)}>
          <div className="card form dialog" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.Email}</h2>
            <div className="row">
              <label>First name<input value={editing.FirstName || ""} onChange={(e) => setEditing({ ...editing, FirstName: e.target.value })} /></label>
              <label>Last name<input value={editing.LastName || ""} onChange={(e) => setEditing({ ...editing, LastName: e.target.value })} /></label>
            </div>
            <label>Display name<input value={editing.DisplayName || ""} onChange={(e) => setEditing({ ...editing, DisplayName: e.target.value })} /></label>
            <label>
              Role
              <select value={editing.RoleId || ""} disabled={editing.Id === me.Id} onChange={(e) => setEditing({ ...editing, RoleId: Number(e.target.value) })}>
                {roles.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
              </select>
            </label>
            <label>
              User type
              <select value={editing.UserTypeId || ""} onChange={(e) => setEditing({ ...editing, UserTypeId: Number(e.target.value) })}>
                {lookups.userTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
              </select>
            </label>
            <label>
              Department
              <select value={editing.DepartmentId || ""} onChange={(e) => setEditing({ ...editing, DepartmentId: Number(e.target.value) || null })}>
                <option value="">None</option>
                {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
              </select>
            </label>
            <fieldset>
              <legend>Manages these departments</legend>
              <div className="checks">
                {lookups.departments.map((d) => (
                  <label key={d.Id} className="check">
                    <input type="checkbox" checked={editing.ManagedDepartmentIds.includes(d.Id)}
                      onChange={(e) => setEditing({
                        ...editing,
                        ManagedDepartmentIds: e.target.checked
                          ? [...editing.ManagedDepartmentIds, d.Id]
                          : editing.ManagedDepartmentIds.filter((x) => x !== d.Id)
                      })} />
                    {d.Name}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={editing.IsActive} disabled={editing.Id === me.Id} onChange={(e) => setEditing({ ...editing, IsActive: e.target.checked })} />
              Active (switched-off people can't sign in)
            </label>
            <div className="row">
              <button className="primary" onClick={save}>Save</button>
              <button className="link" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
