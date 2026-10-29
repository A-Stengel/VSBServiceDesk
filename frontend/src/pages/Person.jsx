import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, formatDate } from "../api.js";
import { useApp } from "../App.jsx";
import { roleLabel } from "./People.jsx";
import MultiSelect from "../components/MultiSelect.jsx";

// One person: what they hold (with Mark returned, Remove seat and Assign),
// their tickets, their history, and buttons that open the request form
// prefilled for a change, off boarding or onboarding. Their account is
// turned off by closing an Off Boarding ticket and back on by closing an
// Onboarding ticket.
export default function Person() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { me, roles, lookups, notify } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [assign, setAssign] = useState("");

  const load = useCallback(() => api.person(id).then(setData).catch((e) => setError(e.message)), [id]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(promise, message) {
    try {
      await promise;
      notify(message);
      await load();
    } catch (err) {
      notify(err.message, true);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { person, holdings, tickets, history } = data;
  const staff = person.UserTypeId === lookups.defaults.staffUserTypeId;
  const first = person.DisplayName;
  const lastChange = history.find((h) => h.Summary.startsWith("Account turned"));

  const save = (changes, message) => run(api.updateUser(person.Id, changes), message);

  function startRequest(kind) {
    const lines = (list) => list.map((name) => `☐ ${name}`).join("\n");
    const held = [
      ...holdings.items.map((i) => `${i.Name}${i.Quantity > 1 ? ` (x${i.Quantity})` : ""}`),
      ...holdings.seats.map((s) => `${s.Name} license`)
    ];
    let prefill;
    if (kind === "change") {
      prefill = {
        subject: `Access & Equipment change: ${first}`,
        description: `What ${first} has now:\n${held.length ? lines(held) : "(nothing)"}\n\nWhat should change:\n`
      };
    } else if (kind === "offboarding") {
      prefill = {
        subject: `Off boarding: ${first}`,
        description: `Collect and remove before closing:\n${held.length ? lines(held) : "(nothing held)"}`
      };
    } else {
      const defaults = [
        ...lookups.inventoryItems.filter((i) => i.IsDefaultForOnboarding).map((i) => i.Name),
        ...lookups.software.filter((s) => s.IsDefaultForOnboarding).map((s) => `${s.Name} license`)
      ];
      prefill = {
        subject: `Onboarding: ${first}`,
        description: `Onboarding defaults:\n${defaults.length ? lines(defaults) : "(none set in Settings)"}`,
        newHireName: first
      };
    }
    navigate("/new", {
      state: { prefill: { type: "access", kind, person: { Id: person.Id, DisplayName: person.DisplayName, Email: person.Email }, ...prefill } }
    });
  }

  function assignPicked() {
    const [kind, itemId] = assign.split(":");
    const name = kind === "item"
      ? lookups.inventoryItems.find((i) => i.Id === Number(itemId))?.Name
      : lookups.software.find((s) => s.Id === Number(itemId))?.Name;
    const body = kind === "item" ? { inventoryItemId: Number(itemId), quantity: 1 } : { softwareId: Number(itemId) };
    run(api.assignHolding(person.Id, body), `Assigned ${name} to ${first}.`).then(() => setAssign(""));
  }


  return (
    <div className="split">
      <div>
        <div className="card">
          <h1 style={{ marginBottom: 2 }}>{person.DisplayName}</h1>
          <div className="muted">{person.Email}</div>
          <div className="row center" style={{ gap: 8, marginTop: 10 }}>
            <span className="pill">{roleLabel(person, lookups)}</span>
            <span className="pill">{person.DepartmentName || "No department"}</span>
            <span className="pill" style={{ background: person.IsActive ? "#dcfce7" : "#e5e7eb" }}>{person.IsActive ? "Active" : "Off"}</span>
          </div>
        </div>

        <div className="card">
          <h2>What they hold</h2>
          <h3>Equipment</h3>
          {!holdings.items.length && <p className="muted small">No equipment.</p>}
          <ul className="history">
            {holdings.items.map((i) => (
              <li key={i.Id} className="row spread">
                <span>
                  {i.Name}{i.Quantity > 1 ? ` x${i.Quantity}` : ""}
                  <span className="muted small"> · since {formatDate(i.OutAt)}{i.TicketId ? <> · <Link to={`/tickets/${i.TicketId}`}>ticket</Link></> : ""}</span>
                </span>
                <button className="btn sm" onClick={() => run(api.returnHolding(person.Id, { ticketItemId: i.Id }), `${i.Name} marked returned.`)}>Mark returned</button>
              </li>
            ))}
          </ul>
          <h3 style={{ marginTop: 14 }}>Software</h3>
          {!holdings.seats.length && <p className="muted small">No licenses.</p>}
          <ul className="history">
            {holdings.seats.map((s) => (
              <li key={s.Id} className="row spread">
                <span>{s.Name}<span className="muted small"> · since {formatDate(s.AssignedAt)}</span></span>
                <button className="btn sm" onClick={() => run(api.returnHolding(person.Id, { seatId: s.Id }), `${s.Name} seat removed.`)}>Remove seat</button>
              </li>
            ))}
          </ul>
          {person.IsActive && (
            <div className="row" style={{ marginTop: 14 }}>
              <label className="field grow">
                Assign
                <select value={assign} onChange={(e) => setAssign(e.target.value)}>
                  <option value="">Pick equipment or software</option>
                  <optgroup label="Equipment">
                    {lookups.inventoryItems.map((i) => <option key={`i${i.Id}`} value={`item:${i.Id}`}>{i.Name}</option>)}
                  </optgroup>
                  <optgroup label="Software">
                    {lookups.software.map((s) => <option key={`s${s.Id}`} value={`seat:${s.Id}`}>{s.Name}</option>)}
                  </optgroup>
                </select>
              </label>
              <button className="btn pri" disabled={!assign} onClick={assignPicked}>Assign</button>
            </div>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>License seat counts on the Inventory page follow these changes.</p>
        </div>

        <div className="card">
          <h2>Tickets</h2>
          {!tickets.length && <p className="muted small">No tickets.</p>}
          <ul className="history">
            {tickets.map((t) => (
              <li key={t.Id}>
                <Link to={`/tickets/${t.Id}`}>{t.Number}</Link> {t.Subject}
                <span className="muted small"> · {t.CategoryName || t.TicketTypeName} · {t.StatusName}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Change history</h2>
          {!history.length && <p className="muted small">No changes yet.</p>}
          <ul className="history">
            {history.map((h) => (
              <li key={h.Id}>
                <span className="muted small">{formatDate(h.At)} · {h.ActorName}</span>
                <br />{h.Summary}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <aside>
        <div className="card form">
          <label>
            Role
            {roles.admin && staff && person.Id !== me.Id ? (
              <select value={person.RoleId || ""} onChange={(e) => save({ roleId: Number(e.target.value) }, "Role saved.")}>
                {lookups.roles.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
              </select>
            ) : (
              <span style={{ fontWeight: 400 }}>
                {roleLabel(person, lookups)}
                {staff && !roles.admin && <span className="muted small"> (admins change roles)</span>}
                {person.Id === me.Id && roles.admin && <span className="muted small"> (you can&apos;t change your own role)</span>}
              </span>
            )}
          </label>
          <label>
            Department
            <select value={person.DepartmentId || ""} onChange={(e) => save({ departmentId: Number(e.target.value) || null }, "Department saved.")}>
              <option value="">None</option>
              {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
            </select>
          </label>
          {roles.admin && (
            <label>
              Account type
              <select value={person.UserTypeId || ""} onChange={(e) => save({ userTypeId: Number(e.target.value) }, "Account type saved.")}>
                {lookups.userTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
              </select>
            </label>
          )}
          <div className="field">
            <span>Manager of</span>
            <MultiSelect label="Manager of" disabled={!roles.admin}
              options={lookups.departments.map((d) => ({ value: d.Id, label: d.Name }))}
              value={person.ManagedDepartmentIds}
              onChange={(ids) => save({ managedDepartmentIds: ids }, "Managed departments saved.")} />
            {!roles.admin && <span className="muted small" style={{ fontWeight: 400 }}>Admins change this.</span>}
          </div>
          <div>
            <strong className="small">Account status</strong>
            <div className="small">
              {person.IsActive ? "Active, can sign in." : "Off, can't sign in."}
              {lastChange && <span className="muted"> {lastChange.Summary.replace(/^Account turned (on|off): /, "")}, {formatDate(lastChange.At)}.</span>}
            </div>
            <div className="muted small">Closing an Off Boarding ticket turns it off; closing an Onboarding ticket turns it back on.</div>
          </div>
        </div>

        <div className="card">
          <h3>Start a request</h3>
          <div className="stack">
            {person.IsActive ? (
              <>
                <button className="btn block" onClick={() => startRequest("change")}>Access & Equipment change</button>
                <button className="btn block" onClick={() => startRequest("offboarding")}>Start off boarding</button>
              </>
            ) : (
              <button className="btn block" onClick={() => startRequest("onboarding")}>Start onboarding</button>
            )}
          </div>
          <p className="muted small" style={{ marginBottom: 0 }}>Opens the request form filled in, for you to check and submit.</p>
        </div>
      </aside>
    </div>
  );
}
