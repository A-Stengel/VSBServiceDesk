import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";

// Tabs, search, filters, sorting and saved views for a list page (tickets,
// rentals and events, people).
//
//   tabs     [{ key, label, test(row) }]  the built-in tabs
//   filters  [{ key, label, options: [{ value, label }], test(row, value) }]
//   columns  { key: (row) => sort value }
//   search   (row) => the text the search box looks in
//
// A saved view remembers the tab, search, filters and sort. Admins can share
// a ticket view with the team; it shows as a "Team:" tab for every technician.
export function useListView({ listKey, tabs, defaultTab, filters, columns, search: searchText, defaultSort }) {
  const { me } = useApp();
  const [params, setParams] = useSearchParams();
  const [views, setViews] = useState([]);
  const [search, setSearch] = useState("");
  const [values, setValues] = useState({});
  const [sort, setSort] = useState(defaultSort || null);
  const [viewId, setViewId] = useState(null);

  const tabParam = params.get("tab");
  const tab = tabs.some((t) => t.key === tabParam) ? tabParam : defaultTab;

  const loadViews = useCallback(() => api.views(listKey).then(setViews).catch(() => setViews([])), [listKey]);
  useEffect(() => {
    loadViews();
  }, [loadViews]);

  const pickTab = (key) => {
    setViewId(null);
    setSearch("");
    setValues({});
    setSort(defaultSort || null);
    setParams(key === defaultTab ? {} : { tab: key }, { replace: true });
  };

  const pickView = (view) => {
    const s = view.Settings || {};
    setViewId(view.Id);
    setSearch(s.search || "");
    setValues(s.filters || {});
    setSort(s.sort || defaultSort || null);
    const base = tabs.some((t) => t.key === s.tab) ? s.tab : defaultTab;
    setParams(base === defaultTab ? {} : { tab: base }, { replace: true });
  };

  async function saveView(name, isShared) {
    const view = await api.createView({ list: listKey, name, isShared, settings: { tab, search, filters: values, sort } });
    await loadViews();
    setViewId(view.Id);
  }

  async function deleteView() {
    await api.deleteView(viewId);
    setViewId(null);
    await loadViews();
  }

  const toggleSort = (key) => {
    setSort((current) => (current?.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  };

  const activeFilters = Object.entries(values).filter(([, v]) => v !== "" && v !== undefined && v !== null);

  const apply = (rows) => {
    if (!rows) return rows;
    const tabDef = tabs.find((t) => t.key === tab);
    const q = search.trim().toLowerCase();
    let out = rows.filter((row) => (!tabDef?.test || tabDef.test(row)) &&
      (!q || searchText(row).toLowerCase().includes(q)) &&
      activeFilters.every(([key, value]) => {
        const f = filters.find((x) => x.key === key);
        return !f || f.test(row, value);
      }));
    if (sort && columns[sort.key]) {
      const get = columns[sort.key];
      out = [...out].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        const c = x === y ? 0 : x === null || x === undefined || x === "" ? 1 : y === null || y === undefined || y === "" ? -1
          : typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.dir === "desc" ? -c : c;
      });
    }
    return out;
  };

  const view = views.find((v) => v.Id === viewId);
  return {
    me, tabs, tab, pickTab, views, view, viewId, pickView, saveView, deleteView,
    canDeleteView: !!view && (view.OwnerId === me.Id || (view.IsShared && me.IsAdmin)),
    search, setSearch, filters, values, setValues, activeCount: activeFilters.length,
    sort, toggleSort, apply, listKey
  };
}

export function ListTabs({ list }) {
  return (
    <div className="tabs" role="tablist">
      {list.tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={!list.viewId && list.tab === t.key}
          className={`tab ${!list.viewId && list.tab === t.key ? "on" : ""}`} onClick={() => list.pickTab(t.key)}>
          {t.label}
        </button>
      ))}
      {list.views.map((v) => (
        <button key={v.Id} role="tab" aria-selected={list.viewId === v.Id}
          className={`tab ${list.viewId === v.Id ? "on" : ""}`} onClick={() => list.pickView(v)}>
          {v.IsShared ? `Team: ${v.Name}` : `★ ${v.Name}`}
        </button>
      ))}
    </div>
  );
}

export function ListToolbar({ list, placeholder, children }) {
  const { me } = useApp();
  const [showFilters, setShowFilters] = useState(false);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState("");

  async function save(e) {
    e.preventDefault();
    setError("");
    try {
      await list.saveView(saving.name.trim(), saving.shared);
      setSaving(null);
    } catch (err) {
      setError(err.message);
    }
  }

  async function remove() {
    if (!confirm(`Delete the view "${list.view.Name}"?`)) return;
    try {
      await list.deleteView();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder={placeholder} value={list.search} onChange={(e) => list.setSearch(e.target.value)} aria-label="Search" />
        <button className={`btn sm ${showFilters || list.activeCount ? "pri" : ""}`} onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          Filters{list.activeCount ? ` (${list.activeCount})` : ""}
        </button>
        <button className="btn sm" onClick={() => setSaving(saving ? null : { name: "", shared: false })}>Save view</button>
        {list.canDeleteView && <button className="btn sm danger" onClick={remove}>Delete this view</button>}
        {children}
      </div>
      {showFilters && (
        <div className="card filter-panel">
          {list.filters.map((f) => (
            <label key={f.key} className="field">
              {f.label}
              <select value={list.values[f.key] ?? ""} onChange={(e) => list.setValues({ ...list.values, [f.key]: e.target.value })}>
                <option value="">Any</option>
                {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ))}
          {list.activeCount > 0 && (
            <div className="field" style={{ justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => list.setValues({})}>Clear filters</button>
            </div>
          )}
        </div>
      )}
      {saving && (
        <form className="card save-view" onSubmit={save}>
          <input type="text" placeholder="Name this view" maxLength={100} value={saving.name} autoFocus
            onChange={(e) => setSaving({ ...saving, name: e.target.value })} />
          {me.IsAdmin && list.listKey === "tickets" && (
            <label className="check">
              <input type="checkbox" checked={saving.shared} onChange={(e) => setSaving({ ...saving, shared: e.target.checked })} />
              Share with the whole team
            </label>
          )}
          <button className="btn sm pri" disabled={!saving.name.trim()}>Save</button>
          <button type="button" className="btn sm ghost" onClick={() => setSaving(null)}>Cancel</button>
          <span className="muted small grow">Saves this tab with its search, filters and sort.</span>
          {error && <span className="error">{error}</span>}
        </form>
      )}
    </>
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
