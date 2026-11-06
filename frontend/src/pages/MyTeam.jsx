import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";

// My team: a department manager's people and what each one has, read only.
// Software shows by its friendly name; prices, license names and iMIS
// details stay with IT. Each person has buttons that open the Access &
// Equipment form prefilled for a change or off boarding.
export default function MyTeam() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api.myTeam().then(setData).catch((e) => setError(e.message));
  }, []);

  function request(person, kind) {
    const first = person.DisplayName;
    const lines = (list) => list.map((name) => `☐ ${name}`).join("\n");
    const held = [
      ...person.equipment.map((i) => `${i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ""}`),
      ...person.software,
      ...person.access
    ];
    const prefill = kind === "change"
      ? { subject: `Access & Equipment change: ${first}`, description: `What ${first} has now:\n${held.length ? lines(held) : "(nothing)"}\n\nWhat should change:\n` }
      : { subject: `Off boarding: ${first}`, description: "" };
    navigate("/new", {
      state: { prefill: { type: "access", kind, person: { Id: person.Id, DisplayName: person.DisplayName, Email: person.Email }, ...prefill } }
    });
  }

  const text = search.trim().toLowerCase();
  const people = (data?.people || []).filter((p) =>
    (!departmentId || p.DepartmentId === Number(departmentId))
    && (!text || `${p.DisplayName} ${p.Email} ${p.JobTitle || ""}`.toLowerCase().includes(text)));

  return (
    <>
      <div className="head-row">
        <h1>My team</h1>
        {data && <span className="muted small">{people.length} {people.length === 1 ? "person" : "people"}</span>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Everyone in the departments you manage, and what IT has given them. To change something, start a request from their card.
      </p>
      {error && <p className="error">{error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <div className="row" style={{ gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <input aria-label="Search" placeholder="Search by name, email or job title" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ flex: "1 1 240px" }} />
          {data.departments.length > 1 && (
            <select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={{ flex: "0 1 260px" }}>
              <option value="">All my departments</option>
              {data.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
            </select>
          )}
        </div>
      )}
      {data && !people.length && <p className="empty">Nobody here.</p>}
      <div className="team">
        {people.map((p) => (
          <div key={p.Id} className="card team-card">
            <div className="team-head">
              <div>
                <strong>{p.DisplayName}</strong>
                <div className="muted small">
                  {[p.JobTitle, data.departments.length > 1 ? p.DepartmentName : null].filter(Boolean).join(" · ") || "No job title"}
                </div>
                <div className="muted small">{[p.Email, p.Phone].filter(Boolean).join(" · ")}</div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={() => request(p, "change")}>Request a change</button>
                <button className="btn sm" onClick={() => request(p, "offboarding")}>Off boarding</button>
              </div>
            </div>
            <div className="team-holds">
              <HeldList title="Equipment" items={p.equipment.map((i) => `${i.name}${i.quantity > 1 ? ` (x${i.quantity})` : ""}`)} />
              <HeldList title="Software" items={p.software} />
              <HeldList title="Access" items={p.access} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function HeldList({ title, items }) {
  return (
    <div>
      <div className="lbl">{title}</div>
      {items.length
        ? <ul className="plain">{items.map((x) => <li key={x}>{x}</li>)}</ul>
        : <p className="muted small" style={{ margin: 0 }}>None</p>}
    </div>
  );
}
