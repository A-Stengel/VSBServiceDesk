import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { applyList, describeSettings, normalizeSettings } from "../lists.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cleanFilters = (values) => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "" && v !== undefined && v !== null));

// Tabs, search, filters and sorting for a list page (tickets, rentals and
// events, people). Every tab is the person's own: a saved filter set they can
// change, save, rename, reorder and remove, or reset to the defaults admins
// set in Settings > Default tabs. def comes from lists.js.
//
// The address bar keeps the open tab (?tab=<id>). Older links that name a
// built-in tab (?tab=unassigned) open the person's matching tab, or that
// filter set on their first tab when they don't have one.
export function useListView(def, { defaultSort } = {}) {
  const { me } = useApp();
  const [params, setParams] = useSearchParams();
  const [tabs, setTabs] = useState(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => api.views(def.key).then(setTabs).catch((e) => { setTabs([]); setError(e.message); }), [def.key]);
  useEffect(() => {
    load();
  }, [load]);

  const tabParam = params.get("tab");
  const saved = (tab) => normalizeSettings(def, tab?.Settings);
  const legacy = tabParam && !/^\d+$/.test(tabParam) ? def.legacy[tabParam] : null;
  const legacyMatch = legacy && tabs?.find((t) => {
    const s = saved(t);
    return s.base === normalizeSettings(def, legacy).base && same(s.filters, normalizeSettings(def, legacy).filters);
  });
  const active = tabs?.find((t) => String(t.Id) === tabParam) || legacyMatch || tabs?.[0] || null;
  const savedSettings = active ? saved(active) : normalizeSettings(def, legacy || {});

  // A link to a built-in tab the person doesn't have opens its filters on
  // their first tab, unsaved.
  useEffect(() => {
    if (tabs && legacy && !legacyMatch) setDraft({ ...normalizeSettings(def, legacy), sort: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, tabParam]);

  const current = draft || savedSettings;
  const sort = current.sort || defaultSort || null;
  const changed = !!draft && !same(
    { base: draft.base, filters: cleanFilters(draft.filters), sort: draft.sort || null },
    { base: savedSettings.base, filters: savedSettings.filters, sort: savedSettings.sort || null }
  );

  const pickTab = (id) => {
    setDraft(null);
    setSearch("");
    setEditing(false);
    setParams(tabs?.[0]?.Id === id ? {} : { tab: String(id) }, { replace: true });
  };
  const edit = (patch) => setDraft({ ...current, ...patch });
  const setValues = (filters) => edit({ filters: cleanFilters(filters) });
  const setBase = (base) => edit({ base });
  const toggleSort = (key) => {
    edit({ sort: sort?.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" } });
  };
  const undo = () => setDraft(null);

  async function saveToTab() {
    const updated = await api.updateView(active.Id, { settings: { base: current.base, filters: cleanFilters(current.filters), sort: current.sort || null } });
    setTabs(tabs.map((t) => (t.Id === updated.Id ? updated : t)));
    setDraft(null);
  }

  async function saveAsNew(name) {
    const created = await api.createView({ list: def.key, name, settings: { base: current.base, filters: cleanFilters(current.filters), sort: current.sort || null } });
    setTabs([...tabs, created]);
    setDraft(null);
    setParams({ tab: String(created.Id) }, { replace: true });
  }

  async function rename(id, name) {
    const updated = await api.updateView(id, { name });
    setTabs((list) => list.map((t) => (t.Id === id ? updated : t)));
  }

  async function move(id, step) {
    const order = tabs.map((t) => t.Id);
    const i = order.indexOf(id);
    const j = i + step;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setTabs(await api.orderViews(def.key, order));
  }

  async function remove(id) {
    await api.deleteView(id);
    const rest = tabs.filter((t) => t.Id !== id);
    setTabs(rest);
    if (active?.Id === id) pickTab(rest[0]?.Id);
  }

  async function reset() {
    setTabs(await api.resetViews(def.key));
    setDraft(null);
    setParams({}, { replace: true });
  }

  const activeFilters = Object.entries(cleanFilters(current.filters));

  const apply = (rows) => applyList(def, rows, { filters: current.filters, search, sort });

  return {
    me, def, tabs, error, active, base: def.bases.find((b) => b.key === current.base) || null, values: cleanFilters(current.filters),
    filters: def.filters, bases: def.bases, setValues, setBase, activeCount: activeFilters.length, changed, undo,
    search, setSearch, sort, toggleSort, apply, pickTab, saveToTab, saveAsNew, rename, move, remove, reset,
    editing, setEditing, ready: !!tabs, settings: { base: current.base, filters: cleanFilters(current.filters), sort }
  };
}

export function ListTabs({ list }) {
  if (!list.tabs) return <div className="tabs" aria-busy="true" />;
  return (
    <>
      <div className="tabs" role="tablist">
        {list.tabs.map((t) => (
          <button key={t.Id} role="tab" aria-selected={!list.editing && list.active?.Id === t.Id}
            className={`tab ${!list.editing && list.active?.Id === t.Id ? "on" : ""}`} onClick={() => list.pickTab(t.Id)}>
            {t.Name}
            {list.active?.Id === t.Id && list.changed && <span className="tab-dot" title="Unsaved filter changes" />}
          </button>
        ))}
        <button className="tab tab-edit" onClick={() => list.setEditing(!list.editing)} aria-expanded={list.editing}>
          {list.editing ? "Done editing" : "Edit tabs"}
        </button>
      </div>
      {list.editing && <TabEditor list={list} />}
    </>
  );
}

// Rename, reorder, remove or reset your tabs.
function TabEditor({ list }) {
  const { notify } = useApp();
  const [names, setNames] = useState({});
  const [confirmReset, setConfirmReset] = useState(false);

  async function run(action, message) {
    try {
      await action();
      if (message) notify(message);
    } catch (err) {
      notify(err.message, true);
    }
  }

  return (
    <div className="card form tab-editor">
      <div>
        <h3 style={{ margin: 0 }}>Your tabs</h3>
        <p className="muted small" style={{ margin: "2px 0 0" }}>Only you see these. To change what a tab shows, open it and use Filters.</p>
      </div>
      <div className="tab-rows">
        {list.tabs.map((t, i) => (
          <div key={t.Id} className="tab-row">
            <input aria-label="Tab name" maxLength={100} value={names[t.Id] ?? t.Name}
              onChange={(e) => setNames({ ...names, [t.Id]: e.target.value })}
              onBlur={() => {
                const name = (names[t.Id] ?? t.Name).trim();
                if (name && name !== t.Name) run(() => list.rename(t.Id, name));
                else setNames({ ...names, [t.Id]: undefined });
              }} />
            <span className="muted small grow">{describeSettings(list.def, t.Settings)}</span>
            <button className="btn sm" aria-label={`Move ${t.Name} left`} disabled={i === 0} onClick={() => run(() => list.move(t.Id, -1))}>↑</button>
            <button className="btn sm" aria-label={`Move ${t.Name} right`} disabled={i === list.tabs.length - 1} onClick={() => run(() => list.move(t.Id, 1))}>↓</button>
            <button className="btn sm danger" disabled={list.tabs.length === 1} onClick={() => run(() => list.remove(t.Id), `Removed the ${t.Name} tab.`)}>Remove</button>
          </div>
        ))}
      </div>
      <div className="row center">
        {confirmReset ? (
          <>
            <span className="small">Replace all your tabs here with the defaults?</span>
            <button className="btn sm danger" onClick={() => { setConfirmReset(false); run(list.reset, "Your tabs are back to the defaults."); }}>Reset</button>
            <button className="btn sm ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
          </>
        ) : (
          <button className="link small" onClick={() => setConfirmReset(true)}>Reset to defaults</button>
        )}
      </div>
    </div>
  );
}

export function ListToolbar({ list, placeholder, children }) {
  const { notify } = useApp();
  const [showFilters, setShowFilters] = useState(false);
  const [name, setName] = useState("");

  async function run(action, message) {
    try {
      await action();
      notify(message);
    } catch (err) {
      notify(err.message, true);
    }
  }

  if (list.editing) return null;
  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder={placeholder} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label="Search" />
        <button className={`btn sm ${showFilters || list.activeCount ? "pri" : ""}`} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          Filters{list.activeCount ? ` (${list.activeCount})` : ""}{list.changed ? ", not saved" : ""}
        </button>
        {children}
      </div>
      {showFilters && list.active && (
        <div className="card form filter-box">
          <div className="row spread">
            <h3 style={{ margin: 0 }}>Filters for “{list.active.Name}”</h3>
            <button className="link small" disabled={!list.changed} onClick={list.undo}>Undo changes</button>
          </div>
          <FilterFields def={list.def} base={list.base?.key} values={list.values}
            onBase={list.setBase} onValues={list.setValues} />
          <div className="save-bar">
            <button className="btn sm pri" disabled={!list.changed} onClick={() => run(list.saveToTab, `Saved the ${list.active.Name} tab.`)}>
              Save to “{list.active.Name}”
            </button>
            <span className="muted small">or</span>
            <input aria-label="Name for a new tab" placeholder="Name for a new tab" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn sm" disabled={!name.trim()}
              onClick={() => run(async () => { await list.saveAsNew(name.trim()); setName(""); setShowFilters(false); }, `Added the ${name.trim()} tab.`)}>
              Save as new tab
            </button>
          </div>
          <p className="muted small" style={{ margin: 0 }}>Sorting by a column header is saved with the tab too.</p>
        </div>
      )}
    </>
  );
}

// The base and filter dropdowns, used by the Filters panel and by Settings >
// Default tabs.
export function FilterFields({ def, base, values, onBase, onValues }) {
  const choices = useMemo(() => def.filters, [def]);
  return (
    <div className="filter-panel" style={{ padding: 0 }}>
      {def.bases.length > 1 && (
        <label className="field">
          Show
          <select value={base || ""} onChange={(e) => onBase(e.target.value)}>
            {def.bases.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
          </select>
        </label>
      )}
      {choices.map((f) => (
        f.options.length === 1 ? (
          <label key={f.key} className="check" style={{ alignSelf: "end", minHeight: 44 }}>
            <input type="checkbox" checked={values[f.key] === f.options[0].value}
              onChange={(e) => onValues({ ...values, [f.key]: e.target.checked ? f.options[0].value : "" })} />
            {f.options[0].label}
          </label>
        ) : (
          <label key={f.key} className="field">
            {f.label}
            <select value={values[f.key] ?? ""} onChange={(e) => onValues({ ...values, [f.key]: e.target.value })}>
              <option value="">Any</option>
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )
      ))}
    </div>
  );
}

export function SortTh({ list, col, children, className }) {
  const on = list.sort?.key === col;
  return (
    <th className={className} aria-sort={on ? (list.sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button className="thb" onClick={() => list.toggleSort(col)}>
        {children}{on ? (list.sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
}

// Unique { value, label } options from the rows, for a filter.
export function optionsFrom(rows, value, label = value) {
  const seen = new Map();
  for (const row of rows || []) {
    const v = value(row);
    if (v !== null && v !== undefined && v !== "" && !seen.has(String(v))) seen.set(String(v), label(row));
  }
  return [...seen].map(([v, l]) => ({ value: v, label: l })).sort((a, b) => String(a.label).localeCompare(String(b.label)));
}
