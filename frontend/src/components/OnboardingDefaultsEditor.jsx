import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import { IMIS_LEVELS } from "../access.js";
import MultiSelect from "./MultiSelect.jsx";
import NoteList from "./NoteList.jsx";
import { IMIS_KINDS, TEXT_ACCESS, printerLabel } from "./OnboardingFields.jsx";

// Settings, Onboarding defaults: pick a department, then one of its job
// titles (or the general defaults), and say what that title gets. Required
// equipment and software are ticked and locked on the Onboarding form. The
// exact license and the iMIS access are for IT only: the form never shows
// them, and the ticket's checklist starts from them.

const GENERAL = "general";
const emptySet = { items: [], apps: [], access: [] };

export default function OnboardingDefaultsEditor({ onChange }) {
  const { lookups, reloadLookups, notify } = useApp();
  const [departmentId, setDepartmentId] = useState("");
  const [titles, setTitles] = useState(null);
  const [picked, setPicked] = useState(GENERAL);
  const [set, setSet] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [renaming, setRenaming] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadTitles = useCallback(() => api.adminLookup("jobTitles").then((d) => setTitles(d.rows)).catch((e) => notify(e.message, true)), [notify]);
  useEffect(() => { loadTitles(); }, [loadTitles]);

  useEffect(() => {
    setSet(null);
    setDirty(false);
    api.onboardingDefaults(picked === GENERAL ? undefined : picked).then(setSet).catch((e) => { notify(e.message, true); setSet(emptySet); });
  }, [picked, notify]);

  const choose = (next) => {
    if (dirty && !window.confirm("Leave without saving these defaults?")) return;
    setPicked(next);
  };
  const change = (patch) => { setSet((s) => ({ ...s, ...patch })); setDirty(true); };

  const deptTitles = (titles || []).filter((t) => t.DepartmentId === Number(departmentId));
  const pickedTitle = (titles || []).find((t) => t.Id === Number(picked));
  const applications = lookups.applications || [];
  const licensesFor = (applicationId) => lookups.software.filter((s) => s.ApplicationId === applicationId);

  async function run(promise, message) {
    try {
      const result = await promise;
      if (message) notify(message);
      await Promise.all([loadTitles(), reloadLookups()]);
      onChange();
      return result || true;
    } catch (err) {
      notify(err.message, true);
      return false;
    }
  }

  async function addTitle(e) {
    e.preventDefault();
    const name = newTitle.trim();
    if (!name) return;
    const result = await run(api.addJobTitle({ departmentId: Number(departmentId), name }), `Added ${name}. It starts with the general defaults.`);
    if (result?.id) {
      setNewTitle("");
      setDirty(false);
      setPicked(String(result.id));
    }
  }

  async function save() {
    setSaving(true);
    const ok = await run(api.saveOnboardingDefaults({ jobTitleId: picked === GENERAL ? null : Number(picked), ...set }),
      `Saved the defaults for ${pickedTitle ? pickedTitle.Name : "the general defaults"}.`);
    if (ok) setDirty(false);
    setSaving(false);
  }

  // Equipment and software: a multi-select, then one row each with Required
  const itemIds = set ? set.items.map((i) => i.inventoryItemId) : [];
  const setItemIds = (ids) => change({ items: ids.map((id) => set.items.find((i) => i.inventoryItemId === id) || { inventoryItemId: id, isRequired: false }) });
  const appIds = set ? set.apps.map((a) => a.applicationId) : [];
  const setAppIds = (ids) => change({
    apps: ids.map((id) => set.apps.find((a) => a.applicationId === id) || { applicationId: id, softwareId: licensesFor(id)[0]?.Id || null, isRequired: false })
  });
  const updateApp = (id, patch) => change({ apps: set.apps.map((a) => (a.applicationId === id ? { ...a, ...patch } : a)) });
  const updateItem = (id, patch) => change({ items: set.items.map((i) => (i.inventoryItemId === id ? { ...i, ...patch } : i)) });

  // Access: typed lists, printers and iMIS
  const ofKind = (kind) => (set ? set.access.filter((a) => a.kind === kind) : []);
  const replaceKind = (kind, entries) => change({ access: [...set.access.filter((a) => a.kind !== kind), ...entries] });
  const refIds = (kind) => ofKind(kind).map((a) => a.refId);
  const setRefIds = (kind) => (ids) => replaceKind(kind, ids.map((refId) => ({ kind, refId, text: null, level: null })));
  const moduleLevel = (moduleId) => ofKind("imisModule").find((a) => a.refId === moduleId)?.level;
  const setModuleLevel = (moduleId, value) => {
    const others = ofKind("imisModule").filter((a) => a.refId !== moduleId);
    replaceKind("imisModule", value === "" ? others : [...others, { kind: "imisModule", refId: moduleId, text: null, level: Number(value) }]);
  };
  const imisApp = applications.find((a) => a.IsImis && appIds.includes(a.Id));
  const imisLicense = imisApp ? lookups.software.find((s) => s.Id === set.apps.find((a) => a.applicationId === imisApp.Id)?.softwareId) : null;
  const imisCount = set ? set.access.filter((a) => IMIS_KINDS.includes(a.kind)).length : 0;

  return (
    <div className="stack">
      <div className="row">
        <label className="grow">
          Department
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">Choose a department to see its job titles</option>
            {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
          </select>
        </label>
      </div>

      <div className="list-rows">
        <div className={`lr ${picked === GENERAL ? "on" : ""}`}>
          <span className="name">
            <button type="button" className="link" onClick={() => choose(GENERAL)} aria-pressed={picked === GENERAL}>General defaults</button>
            <span className="muted small"> · used when no title is picked, and where a new title starts</span>
          </span>
        </div>
        {departmentId && !deptTitles.length && <p className="muted small">No job titles in this department yet.</p>}
        {deptTitles.map((t) => (
          <div key={t.Id} className={`lr ${!t.IsActive ? "off" : ""} ${picked === String(t.Id) ? "on" : ""}`}>
            {renaming?.Id === t.Id ? (
              <form className="row grow" onSubmit={async (e) => {
                e.preventDefault();
                if (await run(api.adminUpdateLookup("jobTitles", t.Id, { Name: renaming.Name }), "Renamed.")) setRenaming(null);
              }}>
                <input value={renaming.Name} maxLength={150} onChange={(e) => setRenaming({ ...renaming, Name: e.target.value })} aria-label="Job title" autoFocus />
                <button className="btn pri sm">Save</button>
                <button type="button" className="btn sm ghost" onClick={() => setRenaming(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span className="name">
                  <button type="button" className="link" onClick={() => choose(String(t.Id))} aria-pressed={picked === String(t.Id)}>{t.Name}</button>
                  {!t.IsActive && <span className="muted small"> · off (not on the form)</span>}
                </span>
                <button className="btn sm" onClick={() => setRenaming({ Id: t.Id, Name: t.Name })}>Rename</button>
                <button className="btn sm" onClick={() => run(api.adminUpdateLookup("jobTitles", t.Id, { IsActive: !t.IsActive }), `${t.IsActive ? "Turned off" : "Turned on"} ${t.Name}.`)}>
                  {t.IsActive ? "Turn off" : "Turn on"}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {departmentId && (
        <form className="row" onSubmit={addTitle}>
          <label className="grow">
            New job title
            <input value={newTitle} maxLength={150} onChange={(e) => setNewTitle(e.target.value)} placeholder="Starts with the general defaults" />
          </label>
          <button className="btn sm" disabled={!newTitle.trim()}>Add title</button>
        </form>
      )}

      <h3 style={{ marginBottom: 0 }}>{pickedTitle ? `${pickedTitle.Name} defaults` : "General defaults"}</h3>
      {!set && <p className="muted">Loading…</p>}
      {set && (
        <>
          <fieldset>
            <legend>Equipment</legend>
            <MultiSelect label="Equipment" placeholder="No equipment" value={itemIds} onChange={setItemIds}
              options={lookups.inventoryItems.map((i) => ({ value: i.Id, label: i.Name }))} />
            <div className="stack-list">
              {set.items.map((i) => (
                <div key={i.inventoryItemId} className="stack-row">
                  <span className="grow">{lookups.inventoryItems.find((x) => x.Id === i.inventoryItemId)?.Name || "Turned off item"}</span>
                  <label className="check">
                    <input type="checkbox" checked={i.isRequired} onChange={(e) => updateItem(i.inventoryItemId, { isRequired: e.target.checked })} />
                    Required
                  </label>
                </div>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend>Software</legend>
            <MultiSelect label="Software" placeholder="No software" value={appIds} onChange={setAppIds}
              options={applications.map((a) => ({ value: a.Id, label: a.Name }))} />
            <div className="stack-list">
              {set.apps.map((a) => {
                const licenses = licensesFor(a.applicationId);
                return (
                  <div key={a.applicationId} className="stack-row">
                    <span className="grow">{applications.find((x) => x.Id === a.applicationId)?.Name || "Turned off software"}</span>
                    <label className="field">
                      <span className="muted small">License (IT only)</span>
                      <select value={a.softwareId || ""} onChange={(e) => updateApp(a.applicationId, { softwareId: Number(e.target.value) || null })}>
                        <option value="">{licenses.length ? "First active license" : "No licenses linked"}</option>
                        {licenses.map((l) => <option key={l.Id} value={l.Id}>{l.Name}</option>)}
                      </select>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={a.isRequired} onChange={(e) => updateApp(a.applicationId, { isRequired: e.target.checked })} />
                      Required
                    </label>
                  </div>
                );
              })}
            </div>
            <p className="muted small" style={{ margin: 0 }}>Link licenses to software in Settings, Software.</p>
          </fieldset>

          {(imisApp || imisCount > 0) && (
            <fieldset>
              <legend>iMIS access (IT only)</legend>
              {!imisApp && <p className="warn small" style={{ margin: 0 }}>iMIS isn&apos;t picked under Software, so these aren&apos;t used.</p>}
              {imisLicense?.ImisAccess === "read" && (
                <p className="muted small" style={{ margin: 0 }}>The license is read only: the ticket gets the StaffReadOnly role and no module levels.</p>
              )}
              <div className="field">
                <span>Module levels</span>
                {!(lookups.imisModules || []).length && <p className="muted small" style={{ margin: 0 }}>Add modules in Settings, Software (the iMIS card).</p>}
                <div className="stack-list">
                  {(lookups.imisModules || []).map((m) => (
                    <div key={m.Id} className="stack-row">
                      <span className="grow">{m.Name}</span>
                      <select aria-label={`${m.Name} level`} value={moduleLevel(m.Id) ?? ""} onChange={(e) => setModuleLevel(m.Id, e.target.value)}>
                        <option value="">Not included</option>
                        {IMIS_LEVELS.map(([n, name]) => <option key={n} value={n}>{n} - {name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
              <div className="field">
                <span>Roles</span>
                <MultiSelect label="iMIS roles" value={refIds("imisRole")} onChange={setRefIds("imisRole")}
                  options={(lookups.imisRoles || []).map((r) => ({ value: r.Id, label: r.Name }))} />
              </div>
              <div className="field">
                <span>Security groups</span>
                <MultiSelect label="iMIS security groups" value={refIds("imisGroup")} onChange={setRefIds("imisGroup")}
                  options={(lookups.imisGroups || []).map((g) => ({ value: g.Id, label: g.Name }))} />
              </div>
            </fieldset>
          )}

          <fieldset>
            <legend>Shared access</legend>
            {TEXT_ACCESS.map((t) => (
              <NoteList key={t.kind} label={t.label} placeholder={t.placeholder} items={ofKind(t.kind).map((a) => a.text)}
                onAdd={(text) => replaceKind(t.kind, [...ofKind(t.kind), { kind: t.kind, refId: null, text, level: null }])}
                onRemove={(index) => replaceKind(t.kind, ofKind(t.kind).filter((_, i) => i !== index))} />
            ))}
            <div className="field">
              <span>Printers</span>
              <MultiSelect label="Printers" placeholder="No printers" value={refIds("printer")} onChange={setRefIds("printer")}
                options={(lookups.printers || []).map((p) => ({ value: p.Id, label: printerLabel(p) }))} />
            </div>
          </fieldset>

          <div className="save-bar">
            <button className="btn pri" disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save defaults"}</button>
            {dirty && <span className="muted small">Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  );
}
