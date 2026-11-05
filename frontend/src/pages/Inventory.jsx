import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatDate, money, perPeriod } from "../api.js";
import { useApp } from "../App.jsx";
import MultiSelect from "../components/MultiSelect.jsx";

// Inventory: equipment, software licenses, printers, and ink and toner. Any
// technician can add items, adjust counts and costs, and delete an item once
// none are out (or no seats are assigned). Every change goes in the history
// below. ?tab=ink&highlight=3,4 highlights cartridges (from a low ink ticket).
const TABS = [["equipment", "Equipment"], ["licenses", "Licenses"], ["printers", "Printers"], ["ink", "Ink and toner"]];

export default function Inventory() {
  const { reloadLookups, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([key]) => key === params.get("tab")) ? params.get("tab") : "equipment";
  const highlight = (params.get("highlight") || "").split(",").map(Number).filter(Boolean);
  const [data, setData] = useState(null);
  const [printing, setPrinting] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => Promise.all([
    api.inventory().then(setData).catch((e) => setError(e.message)),
    api.printing().then(setPrinting).catch((e) => setPrinting({ error: e.message }))
  ]), []);
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
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={`tab ${tab === key ? "on" : ""}`}
            onClick={() => setParams(key === "equipment" ? {} : { tab: key }, { replace: true })}>{label}</button>
        ))}
      </div>
      {tab === "equipment" && <Equipment rows={data.equipment} run={run} />}
      {tab === "licenses" && <Licenses rows={data.licenses} run={run} />}
      {(tab === "printers" || tab === "ink") && !printing && <p className="muted">Loading…</p>}
      {(tab === "printers" || tab === "ink") && printing?.error && <p className="error">{printing.error}</p>}
      {tab === "printers" && printing?.printers && <Printers printers={printing.printers} ink={printing.ink} run={run} />}
      {tab === "ink" && printing?.ink && <Ink ink={printing.ink} printers={printing.printers} highlight={highlight} run={run} />}

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

// Each item's low stock warning: blank for none.
function WarnAt({ value, label, onSave }) {
  const shown = value === null || value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = () => {
    if (draft !== shown) onSave(draft === "" ? null : Number(draft));
  };
  return (
    <input className="qty" style={{ width: 80, minHeight: 32, padding: "4px 8px", textAlign: "center" }} value={draft} aria-label={label}
      placeholder="None" inputMode="numeric" onChange={(e) => setDraft(e.target.value.replace(/\D/g, ""))} onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

function AddRow({ kind, countLabel, costLabel, run }) {
  const { lookups } = useApp();
  const licenses = kind === "licenses";
  const blank = () => ({ name: "", count: "1", cost: "", lowStockAt: "", billingPeriodId: lookups.billingPeriods[0]?.Id || "" });
  const [row, setRow] = useState(blank);
  async function add(e) {
    e.preventDefault();
    const body = { name: row.name, count: Number(row.count || 0), cost: Number(row.cost || 0) };
    if (licenses && row.billingPeriodId) body.billingPeriodId = Number(row.billingPeriodId);
    if (!licenses) body.lowStockAt = row.lowStockAt === "" ? null : Number(row.lowStockAt);
    const ok = await run(api.addInventory(kind, body), `Added ${row.name.trim()}.`);
    if (ok) setRow(blank());
  }
  return (
    <form className="row" onSubmit={add} style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
      <label className="field" style={{ flex: "2 1 220px" }}>Name<input value={row.name} maxLength={150} onChange={(e) => setRow({ ...row, name: e.target.value })} required /></label>
      <label className="field" style={{ flex: "1 1 120px" }}>{countLabel}<input type="number" min="0" value={row.count} onChange={(e) => setRow({ ...row, count: e.target.value })} required /></label>
      <label className="field" style={{ flex: "1 1 120px" }}>{costLabel}<input type="number" min="0" step="0.01" value={row.cost} placeholder="0.00" onChange={(e) => setRow({ ...row, cost: e.target.value })} /></label>
      {!licenses && (
        <label className="field" style={{ flex: "1 1 120px" }}>
          Warn at (optional)
          <input type="number" min="0" value={row.lowStockAt} placeholder="No warning" onChange={(e) => setRow({ ...row, lowStockAt: e.target.value })} />
        </label>
      )}
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

// Available turns orange at or below the item's "Warn at" number.
function Equipment({ rows, run }) {
  const update = (row, data, message) => run(api.updateInventory("equipment", row.Id, data), message);
  return (
    <div className="card flush">
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 900 }}>
          <thead>
            <tr><th>Item</th><th>On hand</th><th className="num">Out now</th><th className="num">Available</th><th title="Available turns orange at or below this. Blank for no warning.">Warn at</th><th>Cost each</th><th /></tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={7} className="muted">No equipment yet. Add the first item below.</td></tr>}
            {rows.map((r) => (
              <tr key={r.Id}>
                <td>
                  <strong>{r.Name}</strong>
                  {!r.IsActive && <div className="muted small">Turned off (hidden on forms)</div>}
                </td>
                <td><Stepper value={r.QuantityOwned} min={r.QuantityOut} label={`${r.Name} on hand`} onSave={(n) => update(r, { count: n }, `${r.Name}: ${n} on hand.`)} /></td>
                <td className="num">{r.QuantityOut}</td>
                <td className="num" style={r.LowStockAt !== null && r.Available <= r.LowStockAt ? { color: "var(--warn)", fontWeight: 600 } : undefined}>{r.Available}</td>
                <td>
                  <WarnAt value={r.LowStockAt} label={`${r.Name} warn at`}
                    onSave={(n) => update(r, { lowStockAt: n }, n === null ? `${r.Name}: no low stock warning.` : `${r.Name}: warn at ${n}.`)} />
                </td>
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
  const { lookups } = useApp();
  const update = (row, data, message) => run(api.updateInventory("licenses", row.Id, data), message);
  return (
    <div className="card flush">
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 1000 }}>
          <thead>
            <tr><th>License</th><th>Software it&apos;s for</th><th className="num">Seats used</th><th>Seats owned</th><th>Cost per seat</th><th className="num">Monthly cost</th><th /></tr>
          </thead>
          <tbody>
            {!rows.length && <tr><td colSpan={7} className="muted">No licenses yet. Add the first one below.</td></tr>}
            {rows.map((r) => (
              <tr key={r.Id}>
                <td>
                  <strong>{r.Name}</strong>
                  {!r.IsActive && <div className="muted small">Turned off</div>}
                </td>
                <td>
                  <select value={r.ApplicationId || ""} aria-label={`${r.Name} is for`} style={{ width: "auto", minHeight: 32, padding: "4px 8px" }}
                    onChange={(e) => update(r, { applicationId: Number(e.target.value) || null }, `${r.Name}: software updated.`)}>
                    <option value="">Not linked</option>
                    {(lookups.applications || []).map((a) => <option key={a.Id} value={a.Id}>{a.Name}</option>)}
                  </select>
                  {r.IsImis && (
                    <select value={r.ImisAccess || ""} aria-label={`${r.Name} iMIS access`} style={{ width: "auto", minHeight: 32, padding: "4px 8px", marginTop: 4, display: "block" }}
                      onChange={(e) => update(r, { imisAccess: e.target.value || null }, `${r.Name}: iMIS access updated.`)}>
                      <option value="">iMIS access: not set</option>
                      <option value="read">iMIS: read only</option>
                      <option value="edit">iMIS: edit (staff access levels)</option>
                    </select>
                  )}
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

// Printers: a maintained list for the onboarding and low ink forms.
function Printers({ printers, ink, run }) {
  const { lookups } = useApp();
  const blank = { name: "", model: "", location: "", departmentId: "" };
  const [adding, setAdding] = useState(blank);
  const [editing, setEditing] = useState(null);
  const body = (row) => ({ name: row.name, model: row.model, location: row.location, departmentId: Number(row.departmentId) || null });
  const inkFor = (printerId) => ink.filter((c) => c.PrinterIds.includes(printerId));
  const fields = (row, set) => (
    <>
      <label className="field" style={{ flex: "2 1 180px" }}>Name<input value={row.name} maxLength={100} required onChange={(e) => set({ ...row, name: e.target.value })} /></label>
      <label className="field" style={{ flex: "2 1 180px" }}>Model<input value={row.model || ""} maxLength={150} onChange={(e) => set({ ...row, model: e.target.value })} /></label>
      <label className="field" style={{ flex: "2 1 180px" }}>Location<input value={row.location || ""} maxLength={200} onChange={(e) => set({ ...row, location: e.target.value })} /></label>
      <label className="field" style={{ flex: "1 1 160px" }}>
        Department
        <select value={row.departmentId || ""} onChange={(e) => set({ ...row, departmentId: e.target.value })}>
          <option value="">None</option>
          {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
        </select>
      </label>
    </>
  );
  return (
    <div className="card flush">
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 820 }}>
          <thead><tr><th>Printer</th><th>Model</th><th>Location</th><th>Department</th><th>Ink and toner</th><th /></tr></thead>
          <tbody>
            {!printers.length && <tr><td colSpan={6} className="muted">No printers yet. Add the first one below.</td></tr>}
            {printers.map((p) => editing?.id === p.Id ? (
              <tr key={p.Id}>
                <td colSpan={6}>
                  <form className="row" onSubmit={async (e) => {
                    e.preventDefault();
                    if (await run(api.updatePrinting("printers", p.Id, body(editing)), `Saved ${editing.name}.`)) setEditing(null);
                  }}>
                    {fields(editing, setEditing)}
                    <button className="btn pri sm">Save</button>
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </form>
                </td>
              </tr>
            ) : (
              <tr key={p.Id}>
                <td><strong>{p.Name}</strong>{!p.IsActive && <div className="muted small">Turned off (hidden on forms)</div>}</td>
                <td>{p.Model}</td>
                <td>{p.Location}</td>
                <td>{p.DepartmentName}</td>
                <td>{inkFor(p.Id).map((c) => `${c.Name} ${c.Color}`).join(", ") || <span className="muted small">None listed</span>}</td>
                <td>
                  <span className="row center" style={{ gap: 6, flexWrap: "nowrap" }}>
                    <button className="btn sm" onClick={() => setEditing({ id: p.Id, name: p.Name, model: p.Model, location: p.Location, departmentId: p.DepartmentId || "" })}>Edit</button>
                    <button className="btn sm" onClick={() => run(api.updatePrinting("printers", p.Id, { isActive: !p.IsActive }), `${p.IsActive ? "Turned off" : "Turned on"} ${p.Name}.`)}>
                      {p.IsActive ? "Turn off" : "Turn on"}
                    </button>
                    <button className="btn sm danger" onClick={() => confirm(`Delete ${p.Name}?`) && run(api.deletePrinting("printers", p.Id), `Deleted ${p.Name}.`)}>Delete</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form className="row" style={{ padding: 14, borderTop: "1px solid var(--line)" }} onSubmit={async (e) => {
        e.preventDefault();
        if (await run(api.addPrinting("printers", body(adding)), `Added ${adding.name.trim()}.`)) setAdding(blank);
      }}>
        {fields(adding, setAdding)}
        <button className="btn pri" disabled={!adding.name.trim()}>Add</button>
      </form>
    </div>
  );
}

// Ink and toner: each cartridge is a type and color with a count, and the
// printers it works with. A low ink ticket for any of those printers shows
// its stock. The count never goes below zero.
function Ink({ ink, printers, highlight, run }) {
  const blank = { name: "", color: "", count: "0", lowStockAt: "", cost: "", printerIds: [] };
  const [adding, setAdding] = useState(blank);
  const first = useRef(null);
  useEffect(() => { first.current?.scrollIntoView({ block: "center" }); }, []);
  const update = (row, body, message) => run(api.updatePrinting("ink", row.Id, body), message);
  const options = printers.map((p) => ({ value: p.Id, label: p.Name }));
  const label = (c) => `${c.Name} ${c.Color}`;
  return (
    <div className="card flush">
      {highlight.length > 0 && <p className="muted small" style={{ padding: "10px 14px 0", margin: 0 }}>Highlighted: the cartridges on the low ink ticket.</p>}
      <div className="scroll">
        <table className="tbl" style={{ minWidth: 1000 }}>
          <thead><tr><th>Cartridge</th><th>Color</th><th>On hand</th><th title="On hand turns orange at or below this. Blank for no warning.">Warn at</th><th>Cost each</th><th>Works with</th><th /></tr></thead>
          <tbody>
            {!ink.length && <tr><td colSpan={7} className="muted">No ink or toner yet. Add the first cartridge below.</td></tr>}
            {ink.map((c) => {
              const on = highlight.includes(c.Id);
              const low = c.LowStockAt !== null && c.QuantityOnHand <= c.LowStockAt;
              return (
                <tr key={c.Id} className={on ? "highlight-row" : ""} ref={on && c.Id === highlight.find((h) => ink.some((x) => x.Id === h)) ? first : undefined}>
                  <td><strong>{c.Name}</strong>{!c.IsActive && <div className="muted small">Turned off</div>}</td>
                  <td>{c.Color}</td>
                  <td>
                    <span className="row center" style={{ gap: 6, flexWrap: "nowrap" }}>
                      <Stepper value={c.QuantityOnHand} min={0} label={`${label(c)} on hand`} onSave={(n) => update(c, { count: Math.max(0, n) }, `${label(c)}: ${Math.max(0, n)} on hand.`)} />
                      {low && <span className="warn small">Low</span>}
                    </span>
                  </td>
                  <td><WarnAt value={c.LowStockAt} label={`${label(c)} warn at`} onSave={(n) => update(c, { lowStockAt: n }, n === null ? `${label(c)}: no low stock warning.` : `${label(c)}: warn at ${n}.`)} /></td>
                  <td><Cost value={c.UnitCost} label={`${label(c)} cost each`} onSave={(n) => update(c, { cost: n }, `${label(c)}: cost updated.`)} /></td>
                  <td style={{ minWidth: 220 }}>
                    <MultiSelect label={`${label(c)} works with`} placeholder="No printers" value={c.PrinterIds} options={options}
                      onChange={(ids) => update(c, { printerIds: ids }, `${label(c)}: printers updated.`)} />
                  </td>
                  <td>
                    <button className="btn sm danger" onClick={() => confirm(`Delete ${label(c)}?`) && run(api.deletePrinting("ink", c.Id), `Deleted ${label(c)}.`)}>Delete</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form className="row" style={{ padding: 14, borderTop: "1px solid var(--line)" }} onSubmit={async (e) => {
        e.preventDefault();
        const body = { ...adding, count: Number(adding.count || 0), cost: Number(adding.cost || 0), lowStockAt: adding.lowStockAt === "" ? null : Number(adding.lowStockAt) };
        if (await run(api.addPrinting("ink", body), `Added ${adding.name.trim()} ${adding.color.trim()}.`)) setAdding(blank);
      }}>
        <label className="field" style={{ flex: "1 1 140px" }}>Type<input value={adding.name} maxLength={100} placeholder="85A" required onChange={(e) => setAdding({ ...adding, name: e.target.value })} /></label>
        <label className="field" style={{ flex: "1 1 120px" }}>Color<input value={adding.color} maxLength={50} placeholder="Black" required onChange={(e) => setAdding({ ...adding, color: e.target.value })} /></label>
        <label className="field" style={{ flex: "1 1 100px" }}>On hand<input type="number" min="0" value={adding.count} onChange={(e) => setAdding({ ...adding, count: e.target.value })} /></label>
        <label className="field" style={{ flex: "1 1 100px" }}>Warn at (optional)<input type="number" min="0" value={adding.lowStockAt} placeholder="No warning" onChange={(e) => setAdding({ ...adding, lowStockAt: e.target.value })} /></label>
        <label className="field" style={{ flex: "1 1 100px" }}>Cost each ($)<input type="number" min="0" step="0.01" value={adding.cost} placeholder="0.00" onChange={(e) => setAdding({ ...adding, cost: e.target.value })} /></label>
        <div className="field" style={{ flex: "2 1 220px" }}>
          <span>Works with</span>
          <MultiSelect label="Works with" placeholder="No printers" value={adding.printerIds} options={options} onChange={(ids) => setAdding({ ...adding, printerIds: ids })} />
        </div>
        <button className="btn pri" disabled={!adding.name.trim() || !adding.color.trim()}>Add</button>
      </form>
    </div>
  );
}
