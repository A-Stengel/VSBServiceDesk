import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";

const LISTS = [
  ["statuses", "Statuses"],
  ["priorities", "Priorities"],
  ["categories", "Categories"],
  ["subcategories", "Subcategories"],
  ["sources", "Sources"],
  ["ticketTypes", "Ticket types"],
  ["departments", "Departments"],
  ["holidays", "Holidays"],
  ["inventoryItems", "Inventory items"],
  ["software", "Software"],
  ["billingPeriods", "Billing periods"],
  ["bookingStatuses", "Booking statuses"],
  ["roles", "Roles"],
  ["userTypes", "User types"]
];

// Admin settings: every pick-list, the per-type form fields, and the general
// settings (status rules, email switch, business days).
export default function Settings() {
  const [tab, setTab] = useState("lists");
  return (
    <div className="card">
      <h1>Settings</h1>
      <div className="tabs">
        <button className={tab === "lists" ? "active" : ""} onClick={() => setTab("lists")}>Lists</button>
        <button className={tab === "fields" ? "active" : ""} onClick={() => setTab("fields")}>Form fields</button>
        <button className={tab === "general" ? "active" : ""} onClick={() => setTab("general")}>General</button>
      </div>
      {tab === "lists" && <Lists />}
      {tab === "fields" && <FormFields />}
      {tab === "general" && <General />}
    </div>
  );
}

function Lists() {
  const [table, setTable] = useState("statuses");
  return (
    <div className="settings-lists">
      <ul className="side-menu">
        {LISTS.map(([key, label]) => (
          <li key={key}>
            <button className={table === key ? "active" : ""} onClick={() => setTable(key)}>{label}</button>
          </li>
        ))}
      </ul>
      <LookupEditor key={table} table={table} />
    </div>
  );
}

function blankRow(columns) {
  const row = {};
  for (const c of columns) row[c.name] = c.type === "bit" ? c.default ?? false : "";
  return row;
}

function LookupEditor({ table }) {
  const { lookups, reloadLookups } = useApp();
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [newRow, setNewRow] = useState(null);
  const [error, setError] = useState("");

  const load = () => api.adminLookup(table).then((d) => {
    setData(d);
    setNewRow(blankRow(d.columns));
    setEdits({});
  }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line
  }, [table]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const valueOf = (row) => ({ ...row, ...(edits[row.Id] || {}) });
  const change = (row, name, value) => setEdits({ ...edits, [row.Id]: { ...(edits[row.Id] || {}), [name]: value } });

  async function saveRow(row) {
    try {
      await api.adminUpdateLookup(table, row.Id, edits[row.Id]);
      await reloadLookups();
      load();
    } catch (err) {
      alert(err.message);
    }
  }
  async function addRow() {
    try {
      await api.adminCreateLookup(table, newRow);
      await reloadLookups();
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  const input = (column, value, onChange) => {
    switch (column.type) {
      case "bit":
        return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
      case "int":
      case "decimal":
        return <input type="number" step={column.type === "decimal" ? "0.01" : "1"} className="qty" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
      case "date":
        return <input type="date" value={value ? String(value).slice(0, 10) : ""} onChange={(e) => onChange(e.target.value)} />;
      case "ref":
        return (
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose</option>
            {(lookups[column.ref] || []).map((o) => <option key={o.Id} value={o.Id}>{o.Name}</option>)}
          </select>
        );
      case "choice":
        return (
          <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
            <option value="">None</option>
            {column.choices.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        );
      default:
        return <input value={value ?? ""} maxLength={column.max} onChange={(e) => onChange(e.target.value)} />;
    }
  };

  return (
    <div className="grow">
      <h2>{data.label}</h2>
      <p className="muted">Entries can't be deleted, because old tickets point at them. Untick Active to hide one from the forms.</p>
      <table className="grid compact">
        <thead>
          <tr>{data.columns.map((c) => <th key={c.name}>{c.label}</th>)}<th /></tr>
        </thead>
        <tbody>
          {data.rows.map((row) => {
            const v = valueOf(row);
            return (
              <tr key={row.Id}>
                {data.columns.map((c) => <td key={c.name}>{input(c, v[c.name], (value) => change(row, c.name, value))}</td>)}
                <td>{edits[row.Id] && <button onClick={() => saveRow(row)}>Save</button>}</td>
              </tr>
            );
          })}
          <tr className="new-row">
            {data.columns.map((c) => <td key={c.name}>{input(c, newRow[c.name], (value) => setNewRow({ ...newRow, [c.name]: value }))}</td>)}
            <td><button onClick={addRow}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const FIELD_OPTIONS = [
  ["category", "Category"],
  ["subcategory", "Subcategory"],
  ["startDate", "Start date"],
  ["endDate", "End date"],
  ["items", "Equipment items"],
  ["forUser", "Who is it for? (a person)"],
  ["software", "Software licenses"],
  ["newHire", "New hire name and department"],
  ["removals", "Equipment or software to remove (from what the person holds)"]
];

// Category and Subcategory are set for the whole ticket type
const TYPE_ONLY = ["category", "subcategory"];

function FormFields() {
  const { lookups, reloadLookups } = useApp();
  const [typeId, setTypeId] = useState(lookups.ticketTypes[0]?.Id || "");
  const [categoryId, setCategoryId] = useState("");
  const [fields, setFields] = useState([]);
  const categories = lookups.categories.filter((c) => c.TicketTypeId === Number(typeId));
  const options = categoryId ? FIELD_OPTIONS.filter(([key]) => !TYPE_ONLY.includes(key)) : FIELD_OPTIONS;

  useEffect(() => {
    setFields(
      lookups.ticketTypeFields
        .filter((f) => f.TicketTypeId === Number(typeId) && f.CategoryId === (categoryId ? Number(categoryId) : null))
        .map((f) => ({ fieldKey: f.FieldKey, label: f.Label, isRequired: f.IsRequired, sortOrder: f.SortOrder }))
    );
  }, [typeId, categoryId, lookups]);

  const toggle = (key, label, on) =>
    setFields(on
      ? [...fields, { fieldKey: key, label, isRequired: false, sortOrder: (fields.length + 1) * 10 }]
      : fields.filter((f) => f.fieldKey !== key));
  const update = (key, changes) => setFields(fields.map((f) => (f.fieldKey === key ? { ...f, ...changes } : f)));

  async function save() {
    try {
      await api.saveTicketTypeFields(typeId, categoryId || undefined, fields.map((f) => ({ ...f, sortOrder: Number(f.sortOrder) || 0 })));
      await reloadLookups();
      alert("Saved");
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="form">
      <p className="muted">
        Subject, Description, Priority, CC and Attachments are on every form. Pick the extra fields each ticket type shows,
        and any extra fields shown only when a category is picked.
      </p>
      <div className="row">
        <label>
          Ticket type
          <select value={typeId} onChange={(e) => { setTypeId(e.target.value); setCategoryId(""); }}>
            {lookups.ticketTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
          </select>
        </label>
        <label>
          Fields for
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">The whole ticket type</option>
            {categories.map((c) => <option key={c.Id} value={c.Id}>Only the {c.Name} category</option>)}
          </select>
        </label>
      </div>
      <table className="grid compact">
        <thead><tr><th>Show</th><th>Field</th><th>Label on the form</th><th>Required</th><th>Order</th></tr></thead>
        <tbody>
          {options.map(([key, name]) => {
            const f = fields.find((x) => x.fieldKey === key);
            return (
              <tr key={key}>
                <td><input type="checkbox" checked={!!f} onChange={(e) => toggle(key, name, e.target.checked)} /></td>
                <td>{name}</td>
                <td>{f && <input value={f.label} maxLength={100} onChange={(e) => update(key, { label: e.target.value })} />}</td>
                <td>{f && <input type="checkbox" checked={f.isRequired} onChange={(e) => update(key, { isRequired: e.target.checked })} />}</td>
                <td>{f && <input type="number" className="qty" value={f.sortOrder} onChange={(e) => update(key, { sortOrder: e.target.value })} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button className="primary" onClick={save}>Save form fields</button>
    </div>
  );
}

function General() {
  const { lookups } = useApp();
  const [data, setData] = useState(null);
  const [values, setValues] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then((d) => {
      setData(d);
      setValues(d.values);
    }).catch((e) => setError(e.message));
  }, []);

  async function save() {
    try {
      const d = await api.saveSettings(values);
      setValues(d.values);
      alert("Saved");
    } catch (err) {
      alert(err.message);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="form narrow">
      {data.meta.map((m) => (
        <label key={m.key}>
          {m.label}
          {m.type === "lookup" && (
            <select value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}>
              <option value="">None</option>
              {(lookups[m.lookup] || []).map((o) => <option key={o.Id} value={o.Id}>{o.Name}</option>)}
            </select>
          )}
          {m.type === "choice" && (
            <select value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}>
              {m.choices.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {m.type === "number" && (
            <input type="number" min="0" value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />
          )}
          {m.type === "text" && (
            <input value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />
          )}
          {m.type === "longtext" && (
            <textarea rows={5} maxLength={4000} value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />
          )}
        </label>
      ))}
      <p className="muted">
        Outgoing email stays Off until you're ready. The email and timer jobs that use these settings come in the next build step.
      </p>
      <button className="primary" onClick={save}>Save settings</button>
    </div>
  );
}
