import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, formatDate, timeAgo } from "../api.js";
import { useApp } from "../App.jsx";
import Logo, { logoChanged } from "../components/Logo.jsx";
import RichEditor from "../components/RichEditor.jsx";
import OnboardingDefaultsEditor from "../components/OnboardingDefaultsEditor.jsx";
import { HeldMailList } from "./HeldMail.jsx";
import { FilterFields } from "../components/ListView.jsx";
import { describeSettings, eventList, normalizeSettings, peopleList, rolesForAudience, ticketList } from "../lists.js";
import { plainToRich } from "../richtext.js";
import { organization } from "../organization.js";
import {
  COLOR_FIELDS, DEFAULT_COLORS, colorsFor, isColor, readabilityProblems, setAppearance, themeVars
} from "../theme.js";

// Settings, grouped down the left. Lists can be added to, renamed,
// reordered and turned off or on, never deleted, because old tickets point
// at them. Every section keeps its own change history. Event Managers see
// only Rooms, Booking guidelines and Room statuses.

const SECTIONS = [
  { group: "Tickets" },
  { key: "ticketTypes", label: "Ticket types", table: "ticketTypes" },
  { key: "accessKinds", label: "Access & Equipment kinds", history: "categories" },
  { key: "formFields", label: "Form fields", history: "formFields" },
  { key: "categories", label: "Categories", history: "categories,subcategories" },
  { key: "statuses", label: "Statuses", table: "statuses" },
  { key: "priorities", label: "Priorities", table: "priorities" },
  { key: "sources", label: "Sources", table: "sources" },
  { group: "Rentals & Events" },
  { key: "rooms", label: "Rooms", table: "rooms", eventManagers: true },
  { key: "guidelines", label: "Booking guidelines", history: "guidelines", eventManagers: true },
  { key: "bookingStatuses", label: "Room statuses", table: "bookingStatuses", eventManagers: true },
  { key: "equipmentStatuses", label: "Equipment statuses", table: "equipmentStatuses" },
  { group: "Organization" },
  { key: "organization", label: "Name, time zone and mailbox", history: "organization" },
  { key: "departments", label: "Departments", table: "departments" },
  { key: "holidays", label: "Holidays", table: "holidays" },
  { group: "Email" },
  { key: "incoming", label: "Incoming", history: "incoming" },
  { key: "outgoing", label: "Outgoing", history: "outgoing" },
  { key: "automations", label: "Automations", history: "automations" },
  { key: "heldMail", label: "Held mail" },
  { key: "notifications", label: "Notifications", history: "notifications" },
  { key: "templates", label: "Email templates", history: "templates" },
  { group: "Inventory and team" },
  { key: "onboarding", label: "Onboarding defaults", history: "onboarding,jobTitles" },
  { key: "applications", label: "Software", table: "applications" },
  { key: "imis", label: "iMIS lists", history: "imisModules,imisRoles,imisGroups" },
  { key: "defaultTabs", label: "Default tabs", history: "defaultTabs" },
  { group: "System" },
  { key: "access", label: "Access and maintenance", history: "access" },
  { key: "appearance", label: "Appearance", history: "appearance" },
  { key: "logo", label: "Logo", history: "logo" },
  { key: "roles", label: "Roles", table: "roles" },
  { key: "userTypes", label: "Account types", table: "userTypes" },
  { key: "billingPeriods", label: "Billing periods", table: "billingPeriods" },
  { key: "advanced", label: "Other settings", history: "general" }
];

const DESCRIPTIONS = {
  ticketTypes: "The kinds of request on the Submit a request page. Equipment Rental opens the combined rental and event form.",
  accessKinds: "The choices for \"What kind of request?\" on Access & Equipment. The checklist decides what the ticket lists: onboarding defaults, a change, or everything the person holds.",
  categories: "Categories for each ticket type, and the subcategories under each.",
  statuses: "Ticket statuses. \"Counts as closed\" and \"Waiting on requester\" drive the lists and the business day timers.",
  priorities: "Rank 1 is the most urgent.",
  sources: "How a ticket came in.",
  rooms: "Rooms people can book. Turned off rooms stay on old bookings.",
  bookingStatuses: "The room part of a rental or event. \"Room is in use\" keeps it in the overlap check.",
  equipmentStatuses: "The names shown for the equipment part. The app works out the stage from the items, so these can be renamed but not added.",
  departments: "Where staff work. Each person has one department; managers can look after several.",
  holidays: "Skipped when counting business days for the warning and automatic close.",
  roles: "What someone can do comes from the Technician, Admin and Event manager ticks.",
  userTypes: "Staff sign in; outside people and shared mailboxes only email in.",
  billingPeriods: "How often a license is billed, for the monthly cost on the Inventory page.",
  organization: "Who this service desk is for. Change these to set the app up for another organization.",
  incoming: "What the app does with mail sent to the service desk mailbox. The mailbox is only read: nothing is moved, deleted or marked as read.",
  outgoing: "Each email the desk sends has its own switch. Replies are always saved on the ticket; when their switch is off they show \"Not emailed\".",
  automations: "Jobs the app runs on its own. The warning email is under Outgoing; here is whether tickets close themselves.",
  heldMail: "Email from people the desk doesn't know yet (while \"Create accounts for new senders\" is off), and email that couldn't be handled.",
  access: "Who can use the web app. Email keeps working either way.",
  appearance: "The colors for light mode and dark mode. Everyone picks Light, Dark or Match device from the menu under their name.",
  onboarding: "What each job title gets when someone is onboarded. The Onboarding form fills these in when the title is picked; required equipment and software can't be taken off there. Licenses and iMIS access are only shown to IT.",
  applications: "The software people pick on the Onboarding form, in plain terms. Each license on the Inventory page says which of these it's for, so IT knows the exact license to give.",
  imis: "The iMIS modules, roles and security groups IT can give. Each module gets its own level (0 to 8) in the onboarding defaults and on the ticket.",
  logo: "Shown in the header, on the loading screen and in the browser tab. A square PNG with a transparent background looks best."
};

export default function Settings() {
  const { roles } = useApp();
  const [params, setParams] = useSearchParams();
  const visible = SECTIONS.filter((s) => roles.admin || s.eventManagers || (s.group && SECTIONS.some((x) => x.eventManagers && groupOf(x) === s.group)));
  const items = visible.filter((s) => s.key);
  const current = items.find((s) => s.key === params.get("section")) || items[0];
  const [refresh, setRefresh] = useState(0);
  const changed = useCallback(() => setRefresh((n) => n + 1), []);

  return (
    <>
      <h1>Settings</h1>
      <div className="settings" style={{ marginTop: 16 }}>
        <nav className="card side-nav" aria-label="Settings sections">
          {visible.map((s) => s.group
            ? <div key={s.group} className="group">{s.group}</div>
            : (
              <button key={s.key} className={current.key === s.key ? "on" : ""} aria-current={current.key === s.key ? "page" : undefined}
                onClick={() => setParams({ section: s.key }, { replace: true })}>
                {s.label}
              </button>
            ))}
        </nav>
        <div className="stack">
          <div className="card">
            <h2>{current.label}</h2>
            {DESCRIPTIONS[current.key] && <p className="muted small" style={{ marginTop: -4 }}>{DESCRIPTIONS[current.key]}</p>}
            <Section key={current.key} section={current} onChange={changed} />
          </div>
          {(current.table || current.history) && <History key={`${current.key}-${refresh}`} section={current.history || current.table} />}
        </div>
      </div>
    </>
  );
}

function groupOf(section) {
  let group = null;
  for (const s of SECTIONS) {
    if (s.group) group = s.group;
    if (s === section) return group;
  }
  return group;
}

function Section({ section, onChange }) {
  const { lookups } = useApp();
  const accessType = lookups.ticketTypes.find((t) => t.Name === "Access & Equipment");
  switch (section.key) {
    case "accessKinds":
      return accessType
        ? <LookupList table="categories" fixed={{ TicketTypeId: accessType.Id }} filter={(r) => r.TicketTypeId === accessType.Id} hide={["TicketTypeId"]} onChange={onChange} />
        : <p className="muted">There is no Access & Equipment ticket type.</p>;
    case "categories":
      return <Categories onChange={onChange} />;
    case "formFields":
      return <FormFields onChange={onChange} />;
    case "guidelines":
      return <Guidelines onChange={onChange} />;
    case "incoming":
    case "outgoing":
    case "automations":
      return (
        <>
          <EmailStatus />
          <SettingsForm section={section.key} onChange={onChange} notes={EMAIL_NOTES} />
        </>
      );
    case "heldMail":
      return <HeldMailList onChange={onChange} />;
    case "access":
      return <SettingsForm section="access" onChange={onChange} notes={EMAIL_NOTES} />;
    case "notifications":
      return <SettingsForm section="notifications" onChange={onChange} notes={EMAIL_NOTES}
        note="IT gets the new ticket alert; HR the room requests. Each only goes out when its switch is on in Outgoing. Error alerts go out whatever the switches say: one when a job starts failing and one when it works again." />;
    case "templates":
      return <Templates onChange={onChange} />;
    case "onboarding":
      return <OnboardingDefaultsEditor onChange={onChange} />;
    case "applications":
      return <Applications onChange={onChange} />;
    case "imis":
      return (
        <div className="stack">
          <LookupList table="imisModules" title="Modules" onChange={onChange} />
          <LookupList table="imisRoles" title="Roles" onChange={onChange} />
          <LookupList table="imisGroups" title="Security groups" onChange={onChange} />
        </div>
      );
    case "organization":
      return <SettingsForm keys={ORGANIZATION_KEYS} onChange={onChange} notes={ORGANIZATION_NOTES} />;
    case "defaultTabs":
      return <DefaultTabs onChange={onChange} />;
    case "appearance":
      return <AppearanceSettings onChange={onChange} />;
    case "logo":
      return <LogoSettings onChange={onChange} />;
    case "advanced":
      return <SettingsForm exclude onChange={onChange} />;
    default:
      return <LookupList table={section.table} onChange={onChange} />;
  }
}

const MODE_TABS = [["light", "Light mode colors"], ["dark", "Dark mode colors"]];
const sameColors = (a, b) => COLOR_FIELDS.every((f) => a[f.key] === b[f.key]);

// The seven colors for each mode, with a preview of the unsaved colors and a
// readability check. Saving the built-in colors stores nothing for that mode.
function AppearanceSettings({ onChange }) {
  const { notify } = useApp();
  const [saved, setSaved] = useState(() => ({ light: colorsFor("light"), dark: colorsFor("dark") }));
  const [draft, setDraft] = useState(saved);
  const [typed, setTyped] = useState({});
  const [tab, setTab] = useState("light");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.appearance().then((data) => {
      setAppearance(data);
      const fresh = { light: colorsFor("light", data), dark: colorsFor("dark", data) };
      setSaved(fresh);
      setDraft(fresh);
    }).catch(() => {});
  }, []);

  const colors = draft[tab];
  const problems = readabilityProblems(colors);
  const changed = MODE_TABS.filter(([mode]) => !sameColors(draft[mode], saved[mode])).map(([mode]) => mode);

  function setColor(key, value) {
    setDraft((d) => ({ ...d, [tab]: { ...d[tab], [key]: value } }));
  }

  async function save() {
    const body = {};
    for (const mode of changed) body[mode] = sameColors(draft[mode], DEFAULT_COLORS[mode]) ? null : draft[mode];
    setBusy(true);
    try {
      const data = await api.saveAppearance(body);
      setAppearance({ light: data.light, dark: data.dark });
      const fresh = { light: colorsFor("light", data), dark: colorsFor("dark", data) };
      setSaved(fresh);
      setDraft(fresh);
      const hard = changed.some((mode) => readabilityProblems(draft[mode]).length);
      notify(`Colors saved. Everyone sees them the next time a page loads.${hard ? " Some text may be hard to read." : ""}`, hard);
      onChange();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="tabs" role="tablist" style={{ marginTop: 0 }}>
        {MODE_TABS.map(([mode, label]) => (
          <button key={mode} type="button" role="tab" aria-selected={tab === mode} className={`tab ${tab === mode ? "on" : ""}`}
            onClick={() => { setTab(mode); setTyped({}); }}>
            {label}{changed.includes(mode) ? " •" : ""}
          </button>
        ))}
      </div>
      <div className="appearance">
        <div className="color-fields">
          {COLOR_FIELDS.map((f) => (
            <div key={f.key} className="color-field">
              <input type="color" id={`color-${f.key}`} aria-label={`${f.name} color`} value={colors[f.key]}
                onChange={(e) => { setColor(f.key, e.target.value.toLowerCase()); setTyped((t) => ({ ...t, [f.key]: undefined })); }} />
              <label className="name" htmlFor={`hex-${f.key}`}>{f.name}<small>{f.hint}</small></label>
              <input type="text" id={`hex-${f.key}`} maxLength={7} spellCheck={false} value={typed[f.key] ?? colors[f.key]}
                onChange={(e) => {
                  const value = e.target.value.trim().toLowerCase();
                  setTyped((t) => ({ ...t, [f.key]: e.target.value }));
                  const hex = value.startsWith("#") ? value : `#${value}`;
                  if (isColor(hex)) setColor(f.key, hex);
                }}
                onBlur={() => setTyped((t) => ({ ...t, [f.key]: undefined }))} />
            </div>
          ))}
        </div>
        <div className="stack" style={{ minWidth: 0 }}>
          <div className="preview" style={themeVars(colors, tab)} aria-label={`Preview of ${tab} mode`}>
            <div className="topbar"><span>{organization().appName}</span><span className="btn submit sm">Submit a request</span></div>
            <div className="preview-body">
              <div className="card">
                <h3>Ticket 0010042</h3>
                <p className="muted small" style={{ margin: "0 0 10px" }}>VPN will not connect from home</p>
                <div className="row center" style={{ gap: 8 }}>
                  <span className="btn pri sm">Send reply</span>
                  <span className="btn sm">Add note</span>
                  <span className="link small">View history</span>
                </div>
              </div>
              <div className="card flush scroll">
                <table className="tbl compact">
                  <thead><tr><th>#</th><th>Subject</th><th>Status</th></tr></thead>
                  <tbody>
                    <tr><td>0010042</td><td><span className="link">VPN will not connect</span></td><td><span className="pill">Open</span></td></tr>
                    <tr><td>0010039</td><td><span className="link">New hire setup</span></td><td><span className="pill">Waiting</span></td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div className={`readable ${problems.length ? "poor" : "good"}`} role="status">
            {problems.length
              ? <><strong>Some text will be hard to read:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></>
              : "Easy to read: every text color passes the accessibility contrast check."}
          </div>
        </div>
      </div>
      <div className="row center" style={{ justifyContent: "space-between" }}>
        <span className="muted small">{changed.length ? `Unsaved changes in ${changed.map((m) => (m === "light" ? "light" : "dark")).join(" and ")} mode` : "No changes"}</span>
        <div className="row center" style={{ gap: 8 }}>
          <button type="button" className="btn sm" disabled={busy || sameColors(draft[tab], DEFAULT_COLORS[tab])}
            onClick={() => { setDraft((d) => ({ ...d, [tab]: { ...DEFAULT_COLORS[tab] } })); setTyped({}); }}>
            Reset {tab} mode to defaults
          </button>
          <button type="button" className="btn sm" disabled={busy || !changed.length} onClick={() => { setDraft(saved); setTyped({}); }}>Discard</button>
          <button type="button" className="btn pri sm" disabled={busy || !changed.length} onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function LogoSettings({ onChange }) {
  const { notify } = useApp();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);

  async function save(action, message) {
    setBusy(true);
    try {
      await action();
      logoChanged();
      setFile(null);
      setInputKey((n) => n + 1);
      notify(message);
      onChange();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form">
      <div className="logo-preview">
        <div className="on-dark"><Logo size={36} />{organization().appName}</div>
        <Logo size={84} className="boot-logo" />
      </div>
      <label>
        New logo (PNG, JPG, WebP or GIF, up to 2 MB)
        <input key={inputKey} id="logo-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif"
          onChange={(e) => setFile(e.target.files[0] || null)} />
      </label>
      <div className="row">
        <button className="btn pri" disabled={!file || busy} onClick={() => save(() => api.uploadLogo(file), "Logo saved.")}>Upload logo</button>
        <button className="btn" disabled={busy} onClick={() => save(api.resetLogo, "Back to the built-in logo.")}>Use the built-in logo</button>
      </div>
    </div>
  );
}

function History({ section }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    api.settingsHistory(section).then(setRows).catch(() => setRows([]));
  }, [section]);
  return (
    <div className="card">
      <h3>Change history</h3>
      {rows && !rows.length && <p className="muted small" style={{ margin: 0 }}>No changes yet.</p>}
      <ul className="history">
        {(rows || []).map((h) => (
          <li key={h.Id}>
            <span className="muted small">{formatDate(h.At)} · {h.ActorName}</span>
            <br />{h.Summary}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A list: add, edit (rename and the other columns), reorder, turn off or on
// ---------------------------------------------------------------------------

function blankRow(columns, fixed) {
  const row = {};
  for (const c of columns) {
    if (c.readOnly) continue;
    row[c.name] = c.type === "bit" ? c.default ?? false : "";
  }
  return { ...row, ...fixed };
}

function FieldInput({ column, value, onChange }) {
  const { lookups } = useApp();
  switch (column.type) {
    case "bit":
      return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case "int":
    case "decimal":
      return <input type="number" step={column.type === "decimal" ? "0.01" : "1"} value={value ?? ""} onChange={(e) => onChange(e.target.value)} />;
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
}

function LookupList({ table, fixed = {}, filter = () => true, hide = [], onChange, title }) {
  const { reloadLookups, notify } = useApp();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => api.adminLookup(table).then(setData).catch((e) => setError(e.message)), [table]);
  useEffect(() => {
    load();
  }, [load]);

  async function run(promise, message) {
    try {
      await promise;
      if (message) notify(message);
      await Promise.all([load(), reloadLookups()]);
      onChange();
      return true;
    } catch (err) {
      notify(err.message, true);
      return false;
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const rows = data.rows.filter(filter);
  const sortable = data.columns.some((c) => c.name === "SortOrder");
  const canToggle = data.columns.some((c) => c.name === "IsActive");
  const noAdd = table === "equipmentStatuses";
  const extra = data.columns.filter((c) => !["Name", "SortOrder", "IsActive", ...hide].includes(c.name));
  const nameOf = (r) => r.Name || (r.HolidayDate ? String(r.HolidayDate).slice(0, 10) : "");

  async function move(index, step) {
    const order = [...rows];
    const [row] = order.splice(index, 1);
    order.splice(index + step, 0, row);
    const updates = order.map((r, i) => ({ r, sort: (i + 1) * 10 })).filter(({ r, sort }) => r.SortOrder !== sort);
    // Only the moved row goes in the history
    await run(Promise.all(updates.map(({ r, sort }) => api.adminUpdateLookup(table, r.Id, { SortOrder: sort }, r.Id !== row.Id))));
  }

  async function saveEdit(e) {
    e.preventDefault();
    const { Id, ...values } = editing;
    const changes = {};
    for (const c of data.columns) {
      if (c.readOnly || hide.includes(c.name) || c.name === "IsActive" || c.name === "SortOrder") continue;
      changes[c.name] = values[c.name];
    }
    if (await run(api.adminUpdateLookup(table, Id, changes), "Saved.")) setEditing(null);
  }

  async function add(e) {
    e.preventDefault();
    const sortOrder = sortable ? Math.max(0, ...data.rows.map((r) => r.SortOrder || 0)) + 10 : undefined;
    const body = { ...adding, ...fixed };
    if (sortable) body.SortOrder = sortOrder;
    if (await run(api.adminCreateLookup(table, body), `Added ${body.Name || body.HolidayDate}.`)) setAdding(null);
  }

  return (
    <div>
      {title && <h3>{title}</h3>}
      <div className="list-rows">
        {!rows.length && <p className="muted small">Nothing here yet.</p>}
        {rows.map((r, i) => (
          <div key={r.Id}>
            <div className={`lr ${canToggle && !r.IsActive ? "off" : ""}`}>
              <span className="name">
                {nameOf(r)}
                {r.HolidayDate && r.Name && <span className="muted small"> · {r.Name}</span>}
                {extra.filter((c) => c.type !== "bit" && c.name !== "HolidayDate" && r[c.name] !== null && r[c.name] !== "" && c.type !== "ref").map((c) => (
                  <span key={c.name} className="muted small"> · {c.label}: {String(r[c.name])}</span>
                ))}
                {extra.filter((c) => c.type === "bit" && r[c.name]).map((c) => <span key={c.name} className="pill" style={{ marginLeft: 6 }}>{c.label}</span>)}
              </span>
              {sortable && (
                <>
                  <button className="btn sm" aria-label={`Move ${nameOf(r)} up`} disabled={i === 0} onClick={() => move(i, -1)}>▲</button>
                  <button className="btn sm" aria-label={`Move ${nameOf(r)} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}>▼</button>
                </>
              )}
              <button className="btn sm" onClick={() => setEditing(editing?.Id === r.Id ? null : { ...r })}>Edit</button>
              {canToggle && table !== "equipmentStatuses" && (
                <button className="btn sm" onClick={() => run(api.adminUpdateLookup(table, r.Id, { IsActive: !r.IsActive }), `${r.IsActive ? "Turned off" : "Turned on"} ${nameOf(r)}.`)}>
                  {r.IsActive ? "Turn off" : "Turn on"}
                </button>
              )}
            </div>
            {editing?.Id === r.Id && (
              <form className="card form" style={{ margin: "4px 0 12px", background: "var(--thead)" }} onSubmit={saveEdit}>
                <div className="row">
                  {data.columns.filter((c) => !c.readOnly && !hide.includes(c.name) && c.name !== "IsActive" && c.name !== "SortOrder").map((c) => (
                    <label key={c.name} className={c.type === "bit" ? "check" : ""}>
                      {c.type === "bit" ? null : c.label}
                      <FieldInput column={c} value={editing[c.name]} onChange={(v) => setEditing({ ...editing, [c.name]: v })} />
                      {c.type === "bit" ? c.label : null}
                    </label>
                  ))}
                </div>
                <div className="row">
                  <button className="btn pri sm">Save</button>
                  <button type="button" className="btn sm ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
      {!noAdd && !adding && (
        <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setAdding(blankRow(data.columns.filter((c) => !hide.includes(c.name) && c.name !== "SortOrder"), {}))}>
          Add
        </button>
      )}
      {adding && (
        <form className="card form" style={{ marginTop: 12, background: "var(--thead)" }} onSubmit={add}>
          <div className="row">
            {data.columns.filter((c) => !c.readOnly && !hide.includes(c.name) && c.name !== "SortOrder" && c.name !== "IsActive" && !(c.name in fixed)).map((c) => (
              <label key={c.name} className={c.type === "bit" ? "check" : ""}>
                {c.type === "bit" ? null : c.label}
                <FieldInput column={c} value={adding[c.name]} onChange={(v) => setAdding({ ...adding, [c.name]: v })} />
                {c.type === "bit" ? c.label : null}
              </label>
            ))}
          </div>
          <div className="row">
            <button className="btn pri sm">Add</button>
            <button type="button" className="btn sm ghost" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

// Categories by ticket type, each with its subcategories.
function Categories({ onChange }) {
  const { lookups } = useApp();
  const types = lookups.ticketTypes.filter((t) => t.Name !== "Access & Equipment");
  const [typeId, setTypeId] = useState(types[0]?.Id);
  const [categoryId, setCategoryId] = useState("");
  const categories = lookups.categories.filter((c) => c.TicketTypeId === typeId);
  return (
    <div className="stack">
      <div className="tabs" role="tablist" style={{ marginTop: 0 }}>
        {types.map((t) => (
          <button key={t.Id} role="tab" aria-selected={t.Id === typeId} className={`tab ${t.Id === typeId ? "on" : ""}`}
            onClick={() => { setTypeId(t.Id); setCategoryId(""); }}>{t.Name}</button>
        ))}
      </div>
      <LookupList key={`c${typeId}`} table="categories" fixed={{ TicketTypeId: typeId }} filter={(r) => r.TicketTypeId === typeId}
        hide={["TicketTypeId", "ChecklistSource"]} onChange={onChange} />
      <label className="field" style={{ maxWidth: 360 }}>
        Subcategories of
        <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Pick a category</option>
          {categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
        </select>
      </label>
      {categoryId && (
        <LookupList key={`s${categoryId}`} table="subcategories" fixed={{ CategoryId: Number(categoryId) }}
          filter={(r) => r.CategoryId === Number(categoryId)} hide={["CategoryId"]} onChange={onChange} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form fields: a tab per ticket type, Shown and Required for each field
// ---------------------------------------------------------------------------

const FIELD_OPTIONS = [
  ["category", "Category (or \"What kind of request?\")"],
  ["subcategory", "Subcategory"],
  ["startDate", "Start date"],
  ["endDate", "End date"],
  ["items", "Equipment items"],
  ["forUser", "Person this is for"],
  ["software", "Software licenses"],
  ["newHire", "New hire name and department"],
  ["removals", "Equipment or software to remove"]
];
const TYPE_ONLY = ["category", "subcategory"];

function FormFields({ onChange }) {
  const { lookups, reloadLookups, notify } = useApp();
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
      ? [...fields, { fieldKey: key, label: label.replace(/ \(.*\)$/, ""), isRequired: false, sortOrder: (fields.length + 1) * 10 }]
      : fields.filter((f) => f.fieldKey !== key));
  const update = (key, changes) => setFields(fields.map((f) => (f.fieldKey === key ? { ...f, ...changes } : f)));

  async function save() {
    try {
      await api.saveTicketTypeFields(typeId, categoryId || undefined, fields.map((f) => ({ ...f, sortOrder: Number(f.sortOrder) || 0 })));
      await reloadLookups();
      notify("Form fields saved.");
      onChange();
    } catch (err) {
      notify(err.message, true);
    }
  }

  return (
    <div className="form">
      <div className="tabs" role="tablist" style={{ marginTop: 0 }}>
        {lookups.ticketTypes.map((t) => (
          <button key={t.Id} role="tab" aria-selected={t.Id === Number(typeId)} className={`tab ${t.Id === Number(typeId) ? "on" : ""}`}
            onClick={() => { setTypeId(t.Id); setCategoryId(""); }}>{t.Name}</button>
        ))}
      </div>
      {categories.length > 0 && (
        <label style={{ maxWidth: 420 }}>
          Fields for
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">The whole ticket type</option>
            {categories.map((c) => <option key={c.Id} value={c.Id}>Only when {c.Name} is picked</option>)}
          </select>
        </label>
      )}
      <div className="scroll">
        <table className="tbl compact">
          <thead><tr><th>Field</th><th>Shown</th><th>Required</th><th>Label on the form</th><th>Order</th></tr></thead>
          <tbody>
            <tr><td>Subject</td><td><input type="checkbox" checked disabled /></td><td><input type="checkbox" checked disabled /></td><td className="muted small">Always on</td><td /></tr>
            <tr><td>Description</td><td><input type="checkbox" checked disabled /></td><td><input type="checkbox" checked disabled /></td><td className="muted small">Always on</td><td /></tr>
            {options.map(([key, name]) => {
              const f = fields.find((x) => x.fieldKey === key);
              return (
                <tr key={key}>
                  <td>{name}</td>
                  <td><input type="checkbox" aria-label={`Show ${name}`} checked={!!f} onChange={(e) => toggle(key, name, e.target.checked)} /></td>
                  <td>{f && <input type="checkbox" aria-label={`${name} required`} checked={f.isRequired} onChange={(e) => update(key, { isRequired: e.target.checked })} />}</td>
                  <td>{f && <input value={f.label} maxLength={100} aria-label={`${name} label`} onChange={(e) => update(key, { label: e.target.value })} />}</td>
                  <td>{f && <input type="number" className="qty" aria-label={`${name} order`} value={f.sortOrder} onChange={(e) => update(key, { sortOrder: e.target.value })} />}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Priority, CC and Attachments are on every form.</p>
      <div><button className="btn pri" onClick={save}>Save form fields</button></div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Text settings
// ---------------------------------------------------------------------------

function useSettings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.settings().then(setData).catch((e) => setError(e.message));
  }, []);
  return { data, setData, error };
}

const ORGANIZATION_KEYS = ["AppName", "OrganizationName", "TimeZone", "StaffEmailDomains", "MailboxAddress", "TestingMailboxAddress", "SiteUrl"];
const ORGANIZATION_NOTES = {
  AppName: "Shown in the header, on the sign-in page and in the browser tab.",
  OrganizationName: "Used in messages, like \"Only [organization] staff accounts can use this site\".",
  TimeZone: "Event times, and when room-only bookings close after the event.",
  StaffEmailDomains: "Who can sign in, and who counts as staff when a ticket is logged for someone. Your own domain must stay in the list.",
  MailboxAddress: "The shared mailbox tickets are emailed to and every email is sent from.",
  TestingMailboxAddress: "Used while the app is in maintenance mode (Settings > Access and maintenance): mail is read from and sent to this address only.",
  SiteUrl: "The link in emails, like https://servicedesk.example.org."
};

const EMAIL_NOTES = {
  InCreateTickets: "A new email (not a reply) becomes a ticket.",
  InAddReplies: "An email with a ticket number in the subject, or a reply to one of the desk's emails, is added to that ticket. A reply always reopens a closed ticket.",
  InCreateSenders: "When off, mail from people the desk doesn't know waits in Held mail.",
  InSaveAttachments: "Files and pictures in emails are saved on the ticket.",
  InProcessAfter: "Mail received before this is never read. It is set to the moment you first turn incoming mail on.",
  MaxEmailMB: "Larger attachments aren't saved, and replies can't attach more than fits in one email of this size.",
  OutRequesterReplyAlert: "Goes to the assigned technician, or the IT team when nobody is assigned.",
  OutWarning: "On the warning business day, at 8:15 in the morning.",
  OutClosed: "With the survey switched on too, the survey comes in the same email.",
  OutBookingChange: "To HR when a booking with a room changes, and to the technician (or the IT team) when it has equipment.",
  AutoClose: "Tickets waiting on the requester close on the close business day, at 8:15 in the morning. They get the closed email and survey when those are on.",
  CalendarWrite: "Room bookings are added (marked Pending), updated and removed on the events calendar. Nobody gets an invitation.",
  StaffWebAccess: "When off, staff see a coming soon page and are told to email the desk. Technicians, admins and event managers keep working.",
  MaintenanceMode: "Staff and HR see a down for maintenance page; technicians and admins keep working. All mail is read from and sent to the testing mailbox, with the real recipients written at the top.",
  ErrorAlertEmails: "Who hears when reading mail, sending, the timers or the calendar stop working."
};

// The last mailbox check, the jobs that are failing, and mail sent today.
function EmailStatus() {
  const [status, setStatus] = useState(null);
  useEffect(() => {
    api.emailStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  if (!status) return null;
  const job = (name) => status.jobs.find((j) => j.Name === name);
  const mailbox = job("mailbox");
  const failing = status.jobs.filter((j) => j.IsFailing);
  return (
    <div className={failing.length ? "flag" : "muted small"} style={{ marginBottom: 14 }}>
      {status.maintenance && <div><strong>Maintenance mode is on:</strong> mail is read from and sent to {status.mailbox}.</div>}
      <div>
        Last mailbox check: {mailbox?.LastRunAt ? timeAgo(mailbox.LastRunAt) : "never"} · {status.ReadToday} read and {status.SentToday} sent in the last day
        {status.FailedToday > 0 && ` · ${status.FailedToday} failed to send`}
        {status.Held > 0 && ` · ${status.Held} in Held mail`}
      </div>
      {failing.map((j) => <div key={j.Name}>{j.Label} is failing ({timeAgo(j.LastErrorAt)}): {j.LastError}</div>)}
    </div>
  );
}
// Settings with a page of their own; Other settings shows the rest.
const SECTION_KEYS = ["EventGuidelines", ...ORGANIZATION_KEYS];

// keys: the settings to show. exclude: everything not shown in another
// section (Other settings).
const timeZones = () => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
};

// The browser's local time for a stored ISO time, for a datetime-local box.
const localInput = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

// "keys" lists the settings to show, or "section" shows every setting the
// server puts in that section; "exclude" shows what no page covers.
function SettingsForm({ keys, section, exclude, note, notes = {}, onChange }) {
  const { lookups, reloadLookups, notify } = useApp();
  const { data, setData, error } = useSettings();
  const [values, setValues] = useState(null);
  useEffect(() => {
    if (data) setValues(data.values);
  }, [data]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !values) return <p className="muted">Loading…</p>;
  const metas = exclude
    ? data.meta.filter((m) => !SECTION_KEYS.includes(m.key) && !m.template && !m.section)
    : section
      ? data.meta.filter((m) => m.section === section)
      : keys.map((key) => data.meta.find((m) => m.key === key)).filter(Boolean);

  async function save(e) {
    e.preventDefault();
    const body = {};
    for (const m of metas) body[m.key] = values[m.key];
    try {
      setData(await api.saveSettings(body));
      await reloadLookups();
      notify("Settings saved.");
      onChange();
    } catch (err) {
      notify(err.message, true);
    }
  }

  return (
    <form className="form" style={{ maxWidth: 560 }} onSubmit={save}>
      {metas.map((m) => m.type === "switch" ? (
        <label key={m.key} className="check">
          <input type="checkbox" checked={values[m.key] === "On"} onChange={(e) => setValues({ ...values, [m.key]: e.target.checked ? "On" : "Off" })} />
          <span>
            {m.label}: <strong>{values[m.key] === "On" ? "On" : "Off"}</strong>
            {notes[m.key] && <span className="muted small" style={{ display: "block", fontWeight: 400 }}>{notes[m.key]}</span>}
          </span>
        </label>
      ) : (
        <label key={m.key}>
          {m.key === "RequesterReplyStatusId" ? "Status set when the requester replies" : m.label}
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
          {m.type === "text" && <input value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />}
          {m.type === "datetime" && (
            <input type="datetime-local" value={localInput(values[m.key])}
              onChange={(e) => setValues({ ...values, [m.key]: e.target.value ? new Date(e.target.value).toISOString() : "" })} />
          )}
          {m.type === "email" && (
            <input type="email" value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />
          )}
          {m.type === "timezone" && (
            <select value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })}>
              {!timeZones().includes(values[m.key]) && <option value={values[m.key] ?? ""}>{values[m.key] || "Choose"}</option>}
              {timeZones().map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ")}</option>)}
            </select>
          )}
          {m.type === "longtext" && (
            <textarea rows={5} maxLength={4000} value={values[m.key] ?? ""} onChange={(e) => setValues({ ...values, [m.key]: e.target.value })} />
          )}
          {notes[m.key] && <span className="muted small" style={{ fontWeight: 400 }}>{notes[m.key]}</span>}
        </label>
      ))}
      {note && <p className="muted small" style={{ margin: 0 }}>{note}</p>}
      <div><button className="btn pri">Save</button></div>
    </form>
  );
}

const PLACEHOLDERS = "[Requester], [TicketNumber], [Subject], [Link], [DaysLeft], [Room], [When], [Description], [Changes]";

function Templates({ onChange }) {
  const { notify } = useApp();
  const { data, setData, error } = useSettings();
  const [pick, setPick] = useState("Received");
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (data) setDraft({ subject: data.values[`Template${pick}Subject`] || "", body: data.values[`Template${pick}Body`] || "" });
  }, [data, pick]);

  if (error) return <p className="error">{error}</p>;
  if (!data || !draft) return <p className="muted">Loading…</p>;
  const templates = data.meta.filter((m) => m.template && m.key.endsWith("Subject"));

  async function save(e) {
    e.preventDefault();
    try {
      setData(await api.saveSettings({ [`Template${pick}Subject`]: draft.subject, [`Template${pick}Body`]: draft.body }));
      notify("Template saved.");
      onChange();
    } catch (err) {
      notify(err.message, true);
    }
  }

  return (
    <form className="form" onSubmit={save}>
      <label style={{ maxWidth: 360 }}>
        Email
        <select value={pick} onChange={(e) => setPick(e.target.value)}>
          {templates.map((m) => <option key={m.template} value={m.template}>{m.label.replace(/: subject$/, "")}</option>)}
        </select>
      </label>
      <label>Subject<input value={draft.subject} maxLength={1000} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></label>
      <label>Message<textarea rows={8} maxLength={4000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></label>
      <p className="muted small" style={{ margin: 0 }}>Placeholders: {PLACEHOLDERS}. Every subject gets "Ticket #" and the number if it doesn't have them, so replies find their ticket. An email only goes out while its switch is on in Outgoing.</p>
      <div><button className="btn pri">Save template</button></div>
    </form>
  );
}

function Guidelines({ onChange }) {
  const { lookups, reloadLookups, notify } = useApp();
  const [text, setText] = useState(plainToRich(lookups.eventGuidelines || ""));
  async function save(e) {
    e.preventDefault();
    try {
      await api.saveGuidelines(text);
      await reloadLookups();
      notify("Guidelines saved.");
      onChange();
    } catch (err) {
      notify(err.message, true);
    }
  }
  return (
    <form className="form" onSubmit={save}>
      <p className="muted small" style={{ margin: 0 }}>Shown next to the Equipment Rental / Event Booking form.</p>
      <RichEditor value={text} onChange={setText} label="Booking guidelines" minHeight={220} />
      <div><button className="btn pri">Save guidelines</button></div>
    </form>
  );
}

// The friendly software names, and which licenses are linked to each
function Applications({ onChange }) {
  const { lookups } = useApp();
  const unlinked = lookups.software.filter((s) => !s.ApplicationId);
  return (
    <div className="stack">
      <LookupList table="applications" onChange={onChange} />
      <div>
        <h3>Linked licenses</h3>
        <ul className="history">
          {(lookups.applications || []).map((a) => {
            const linked = lookups.software.filter((s) => s.ApplicationId === a.Id);
            return (
              <li key={a.Id}>
                <strong>{a.Name}</strong>: {linked.length ? linked.map((l) => l.Name).join(", ") : <span className="warn">no licenses linked</span>}
              </li>
            );
          })}
          {unlinked.length > 0 && <li className="muted">Not linked to any software: {unlinked.map((l) => l.Name).join(", ")}</li>}
        </ul>
        <p className="muted small" style={{ marginBottom: 0 }}>Link a license on the Inventory page, Licenses tab.</p>
      </div>
    </div>
  );
}

const TAB_LISTS = [
  { key: "tickets", label: "Tickets", audiences: ["requester", "technician"] },
  { key: "events", label: "Rentals and events", audiences: ["requester", "eventManager", "technician"] },
  { key: "people", label: "People", audiences: ["technician"] }
];
const AUDIENCE_LABELS = { requester: "Requesters", eventManager: "Event managers", technician: "Technicians" };

// The tabs each group starts with on each list. New accounts get a copy;
// people who already have tabs keep theirs until they click Reset to
// defaults. Someone whose role changes to or from Technician (or Event
// Manager) gets their new group's tabs.
function DefaultTabs({ onChange }) {
  const { me, lookups, notify } = useApp();
  const [listKey, setListKey] = useState("tickets");
  const [audience, setAudience] = useState("technician");
  const [tabs, setTabs] = useState(null);
  const [open, setOpen] = useState(null);
  const [technicians, setTechnicians] = useState([]);
  const [saving, setSaving] = useState(false);
  const listInfo = TAB_LISTS.find((l) => l.key === listKey);
  const def = useMemo(() => {
    const roles = rolesForAudience(audience);
    const ctx = { me, roles, lookups, technicians };
    return listKey === "tickets" ? ticketList(ctx) : listKey === "events" ? eventList(ctx) : peopleList(ctx);
  }, [listKey, audience, me, lookups, technicians]);

  useEffect(() => {
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, []);
  useEffect(() => {
    if (!listInfo.audiences.includes(audience)) setAudience(listInfo.audiences[listInfo.audiences.length - 1]);
  }, [listInfo, audience]);
  useEffect(() => {
    if (!listInfo.audiences.includes(audience)) return;
    setTabs(null);
    setOpen(null);
    api.defaultTabs(listKey, audience)
      .then((rows) => setTabs(rows.map((t) => ({ name: t.Name, settings: normalizeSettings(def, t.Settings) }))))
      .catch((e) => notify(e.message, true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, audience]);

  const change = (i, patch) => setTabs(tabs.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const move = (i, step) => {
    const next = [...tabs];
    [next[i], next[i + step]] = [next[i + step], next[i]];
    setTabs(next);
    setOpen(null);
  };

  async function save() {
    setSaving(true);
    try {
      const saved = await api.saveDefaultTabs(listKey, audience, tabs.map((t) => ({ name: t.name.trim(), settings: t.settings })));
      setTabs(saved.map((t) => ({ name: t.Name, settings: normalizeSettings(def, t.Settings) })));
      notify(`Saved the default ${listInfo.label} tabs for ${AUDIENCE_LABELS[audience].toLowerCase()}.`);
      onChange?.();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form">
      <p className="muted small" style={{ marginTop: 0 }}>
        The tabs each group starts with. New accounts get a copy, and anyone can change their own. People who already have tabs keep
        theirs until they click Reset to defaults, and someone whose role changes to or from Technician gets their new group&apos;s tabs.
      </p>
      <div className="row">
        <label>
          List
          <select value={listKey} onChange={(e) => setListKey(e.target.value)}>
            {TAB_LISTS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
          </select>
        </label>
        <label>
          Group
          <select value={audience} onChange={(e) => setAudience(e.target.value)}>
            {listInfo.audiences.map((a) => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
          </select>
        </label>
      </div>
      {audience === "requester" && listKey === "tickets" && (
        <p className="muted small" style={{ margin: 0 }}>Requesters only see tickets they&apos;re on, plus their departments&apos; when they manage one, so whole-queue choices aren&apos;t offered.</p>
      )}
      {!tabs ? <p className="muted">Loading…</p> : (
        <div className="tab-rows">
          {tabs.map((t, i) => (
            <div key={i} className="tab-block">
              <div className="tab-row">
                <input aria-label="Tab name" maxLength={100} value={t.name} onChange={(e) => change(i, { name: e.target.value })} />
                <span className="muted small grow">{describeSettings(def, t.settings)}</span>
                <button className="btn sm" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>Filters</button>
                <button className="btn sm" aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button className="btn sm" aria-label={`Move ${t.name} down`} disabled={i === tabs.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button className="btn sm danger" disabled={tabs.length === 1} onClick={() => { setTabs(tabs.filter((_, j) => j !== i)); setOpen(null); }}>Remove</button>
              </div>
              {open === i && (
                <div className="card" style={{ padding: 12 }}>
                  <FilterFields def={def} base={t.settings.base} values={t.settings.filters}
                    onBase={(base) => change(i, { settings: { ...t.settings, base } })}
                    onValues={(filters) => change(i, {
                      settings: { ...t.settings, filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }
                    })} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {tabs && (
        <div className="row">
          <button className="btn sm" onClick={() => { setTabs([...tabs, { name: "New tab", settings: normalizeSettings(def, {}) }]); setOpen(tabs.length); }}>Add tab</button>
          <button className="btn pri sm" disabled={saving || tabs.some((t) => !t.name.trim())} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      )}
    </div>
  );
}
