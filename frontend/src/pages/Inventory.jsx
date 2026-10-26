import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatDate, money, perPeriod } from "../api.js";
import { useApp } from "../App.jsx";

// Inventory: equipment and software licenses. Any technician can add items,
// adjust counts and costs, and delete an item once none are out (or no seats
// are assigned). Every change goes in the history below.
export default function Inventory() {
  const { reloadLookups, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "licenses" ? "licenses" : "equipment";
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => api.inventory().then(setData).catch((e) => setError(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  async function run(promise, message) {
    try {
      await promise;
      notify(message);
      await Promise.all([load(), reloadLookups()]);
      return true;
    } catch (err) {
      notify(err.message, true);
      return false;
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="head-row">
        <h1>Inventory</h1>
        <span className="muted small">
          Equipment value {money(data.totals.equipmentValue)} · Licenses {money(data.totals.monthlyLicenses)} a month
        </span>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "equipment"} className={`tab ${tab === "equipment" ? "on" : ""}`} onClick={() => setParams({}, { replace: true })}>Equipment</button>
        <button role="tab" aria-selected={tab === "licenses"} className={`tab ${tab === "licenses" ? "on" : ""}`} onClick={() => setParams({ tab: "licenses" }, { replace: true })}>Licenses</button>
      </div>
      {tab === "equipment"
        ? <Equipment rows={data.equipment} low={data.lowStockThreshold} run={run} />
        : <Licenses rows={data.licenses} run={run} />}

      <div className="sec">Change history</div>
      <div className="card">
        {!data.history.length && <p className="muted small" style={{ margin: 0 }}>No changes yet.</p>}
        <ul className="history">
          {data.history.map((h) => (
            <li key={h.Id}>
              <span className="muted small">{formatDate(h.At)} · {h.ActorName}</span>
              <br />{h.Summary}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// −/+ buttons around a count, plus typing a new number.
function Stepper({ value, min, label, onSave }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = parseInt(draft, 10);
    if (Number.isInteger(n) && n !== value) onSave(n);
    else setDraft(String(value));
  };
  return (
    <span className="stepper">
      <button className="btn sm" aria-label={`One fewer ${label}`} disabled={value <= min} onClick={() => onSave(value - 1)}>−</button>
      <input className="qty" style={{ width: 70, minHeight: 32, padding: "4px 8px", textAlign: "center" }} value={draft} aria-label={label}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <button className="btn sm" aria-label={`One more ${label}`} onClick={() => onSave(value + 1)}>+</button>
    </span>
  );
}

function Cost({ value, label, onSave }) {
  const [draft, setDraft] = useState(Number(value).toFixed(2));
  useEffect(() => setDraft(Number(value).toFixed(2)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isNaN(n) && n >= 0 && n !== Number(value)) onSave(n);
    else setDraft(Number(value).toFixed(2));
  };
  return (
    <span className="row center" style={{ gap: 4, flexWrap: "nowrap" }}>
      $<input style={{ width: 100, minHeight: 32, padding: "4px 8px" }} value={draft} aria-label={label} inputMode="decimal"
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
    </span>
  );
}

// How often a license is billed: per month or per year.
function BillingPicker({ value, label, onChange, style }) {
  const { lookups } = useApp();
  return (
    <select value={value || ""} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} style={style}>
      {lookups.billingPeriods.map((b) => <option key={b.Id} value={b.Id}>{perPeriod(b)}</option>)}
    </select>
  );
}

function AddRow({ kind, countLabel, costLabel, run }) {
  const { lookups } = useApp();
  const licenses = kind === "licenses";
  const blank = () => ({ name: "", count: "1", cost: "", billingPeriodId: lookups.billingPeriods[0]?.Id || "" });
  const [row, setRow] = useState(blank);
  async function add(e) {
    e.preventDefault();
    const body = { name: row.name, count: Number(row.count || 0), cost: Number(row.cost || 0) };
    if (licenses && row.billingPeriodId) body.billingPeriodId = Number(row.billingPeriodId);
    const ok = await run(api.addInventory(kind, body), `Added ${row.name.trim()}.`);
    if (ok) setRow(blank());
  }
  return (
    <form className="row" onSubmit={add} style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
      <label className="field" style={{ flex: "2 1 220px" }}>Name<input value={row.name} maxLength={150} onChange={(e) => setRow({ ...row, name: e.target.value })} required /></label>
      <label className="field" style={{ flex: "1 1 120px" }}>{countLabel}<input type="number" min="0" value={row.count} onChange={(e) => setRow({ ...row, count: e.target.value })} required /></label>
      <label className="field" style={{ flex: "1 1 120px" }}>{costLabel}<input type="number" min="0" step="0.01" value={row.cost} placeholder="0.00" onChange={(e) => setRow({ ...row, cost: e.target.value })} /></label>
      {licenses && (
        <label className="field" style={{ flex: "1 1 140px" }}>
          Billed
          <BillingPicker value={row.billingPeriodId} onChange={(id) => setRow({ ...row, billingPeriodId: id })} />
        </label>
      )}
      <button className="btn pri" disabled={!row.name.trim()}>Add</button>
    </form>
  );
}

function Equipment({ rows, low, run }) {
  const update = (row, data, message) => run(api.updateInventory("equipment", row.Id, data), message);
  return (
    <div className="card flush">
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 820 }}>
          <thead>
            <tr><th>Item</th><th>On hand</th><th className="num">Out now</th><th className="num">Available</th><th>Cost each</th><th /></tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={6} className="muted">No equipment yet. Add the first item below.</td></tr>}
            {rows.map((r) => (
              <tr key={r.Id}>
                <td>
                  <strong>{r.Name}</strong>
                  {!r.IsActive && <div className="muted small">Turned off (hidden on forms)</div>}
                </td>
                <td><Stepper value={r.QuantityOwned} min={r.QuantityOut} label={`${r.Name} on hand`} onSave={(n) => update(r, { count: n }, `${r.Name}: ${n} on hand.`)} /></td>
                <td className="num">{r.QuantityOut}</td>
                <td className="num" style={r.Available <= low ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{r.Available}</td>
                <td><Cost value={r.UnitCost} label={`${r.Name} cost each`} onSave={(n) => update(r, { cost: n }, `${r.Name}: cost updated.`)} /></td>
                <td>
                  {r.InUse
                    ? <span className="muted small">Out or reserved on a request</span>
                    : <button className="btn sm danger" onClick={() => confirm(`Delete ${r.Name}?`) && run(api.deleteInventory("equipment", r.Id), `Deleted ${r.Name}.`)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddRow kind="equipment" countLabel="Quantity" costLabel="Cost each ($)" run={run} />
    </div>
  );
}

function Licenses({ rows, run }) {
  const update = (row, data, message) => run(api.updateInventory("licenses", row.Id, data), message);
  return (
    <div className="card flush">
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 820 }}>
          <thead>
            <tr><th>Software</th><th className="num">Seats used</th><th>Seats owned</th><th>Cost per seat</th><th className="num">Monthly cost</th><th /></tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={6} className="muted">No licenses yet. Add the first one below.</td></tr>}
            {rows.map((r) => (
              <tr key={r.Id}>
                <td>
                  <strong>{r.Name}</strong>
                  {!r.IsActive && <div className="muted small">Turned off</div>}
                </td>
                <td className="num" style={r.SeatsUsed > r.SeatsPurchased ? { color: "var(--error)", fontWeight: 600 } : undefined}>{r.SeatsUsed}</td>
                <td><Stepper value={r.SeatsPurchased} min={r.SeatsUsed} label={`${r.Name} seats owned`} onSave={(n) => update(r, { count: n }, `${r.Name}: ${n} seats owned.`)} /></td>
                <td>
                  <span className="row center" style={{ gap: 8, flexWrap: "nowrap" }}>
                    <Cost value={r.CostPerSeat} label={`${r.Name} cost per seat`} onSave={(n) => update(r, { cost: n }, `${r.Name}: cost updated.`)} />
                    <BillingPicker value={r.BillingPeriodId} label={`${r.Name} billed`} style={{ width: "auto", minHeight: 32, padding: "4px 8px" }}
                      onChange={(id) => update(r, { billingPeriodId: id }, `${r.Name}: billing updated.`)} />
                  </span>
                </td>
                <td className="num">{money(r.MonthlyCost)}</td>
                <td>
                  {r.SeatsUsed > 0
                    ? <span className="muted small">Seats still assigned</span>
                    : <button className="btn sm danger" onClick={() => confirm(`Delete ${r.Name}?`) && run(api.deleteInventory("licenses", r.Id), `Deleted ${r.Name}.`)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <AddRow kind="licenses" countLabel="Seats" costLabel="Cost per seat ($)" run={run} />
    </div>
  );
}
