import { useEffect, useRef } from "react";
import { api } from "../api.js";
import MultiSelect from "./MultiSelect.jsx";
import NoteList from "./NoteList.jsx";

// The Onboarding form: who the new hire is, and what they need in plain
// terms. Picking a job title fills in that title's defaults (Settings,
// Onboarding defaults); what the title requires is ticked and can't be
// removed. The exact licenses and iMIS access are for IT, on the ticket.

export const TEXT_ACCESS = [
  { kind: "mailbox", label: "Shared mailboxes", placeholder: "Type a mailbox, like billing@example.org" },
  { kind: "calendar", label: "Shared calendars", placeholder: "Type a calendar" },
  { kind: "phone", label: "Phone queues and shared lines", placeholder: "Type a queue or line" }
];
export const IMIS_KINDS = ["imisModule", "imisRole", "imisGroup"];
export const OTHER_TITLE = "other";

export function emptyOnboarding(prefill = {}) {
  return {
    newHire: {
      firstName: prefill.firstName || "",
      lastName: prefill.lastName || "",
      displayName: prefill.displayName || "",
      departmentId: prefill.departmentId ? String(prefill.departmentId) : "",
      jobTitleId: "",
      jobTitleName: ""
    },
    items: [],
    applicationIds: [],
    access: [],
    required: { items: [], apps: [] }
  };
}

// What the form sends with the ticket
export function onboardingBody(value, showNewHire) {
  const h = value.newHire;
  const other = h.jobTitleId === OTHER_TITLE;
  return {
    newHire: showNewHire
      ? {
          firstName: h.firstName,
          lastName: h.lastName,
          displayName: h.displayName || null,
          departmentId: h.departmentId ? Number(h.departmentId) : null,
          jobTitleId: !other && h.jobTitleId ? Number(h.jobTitleId) : null,
          jobTitleName: other ? h.jobTitleName : null
        }
      : undefined,
    items: value.items,
    applicationIds: value.applicationIds,
    access: value.access
  };
}

export const printerLabel = (p) => `${p.Name}${p.Location ? ` (${p.Location})` : ""}`;

export default function OnboardingFields({ lookups, value, onChange, showNewHire, isTechnician }) {
  const hire = value.newHire;
  const titles = (lookups.jobTitles || []).filter((t) => t.DepartmentId === Number(hire.departmentId));
  const applications = lookups.applications || [];
  const printers = lookups.printers || [];
  const autoDisplay = useRef(!hire.displayName);
  const setHire = (patch) => onChange((v) => ({ ...v, newHire: { ...v.newHire, ...patch } }));

  const nameChange = (key) => (e) => {
    const next = { ...hire, [key]: e.target.value };
    if (autoDisplay.current) next.displayName = `${next.firstName} ${next.lastName}`.trim();
    setHire(next);
  };

  // A title's own defaults; none picked, or a new one typed, uses the
  // general defaults (where a new title starts)
  const titleKey = hire.jobTitleId === OTHER_TITLE ? "" : hire.jobTitleId;
  useEffect(() => {
    let live = true;
    api.onboardingDefaults(titleKey || undefined)
      .then((set) => {
        if (!live) return;
        onChange((v) => ({
          ...v,
          items: set.items.map((i) => ({ inventoryItemId: i.inventoryItemId, quantity: 1 })),
          applicationIds: set.apps.map((a) => a.applicationId),
          access: set.access.filter((a) => !IMIS_KINDS.includes(a.kind)),
          required: {
            items: set.items.filter((i) => i.isRequired).map((i) => i.inventoryItemId),
            apps: set.apps.filter((a) => a.isRequired).map((a) => a.applicationId)
          }
        }));
      })
      .catch(() => {});
    return () => { live = false; };
  }, [titleKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const itemIds = value.items.map((i) => i.inventoryItemId);
  const setItemIds = (ids) => onChange((v) => ({
    ...v,
    items: ids.map((id) => v.items.find((i) => i.inventoryItemId === id) || { inventoryItemId: id, quantity: 1 })
  }));
  const toggleApp = (id, on) => onChange((v) => ({
    ...v,
    applicationIds: on ? [...v.applicationIds, id] : v.applicationIds.filter((x) => x !== id)
  }));
  const texts = (kind) => value.access.filter((a) => a.kind === kind).map((a) => a.text);
  const addText = (kind, text) => onChange((v) => ({ ...v, access: [...v.access, { kind, text }] }));
  const removeText = (kind, index) => onChange((v) => {
    const entry = v.access.filter((a) => a.kind === kind)[index];
    return { ...v, access: v.access.filter((a) => a !== entry) };
  });
  const printerIds = value.access.filter((a) => a.kind === "printer").map((a) => a.refId);
  const setPrinterIds = (ids) => onChange((v) => ({
    ...v,
    access: [...v.access.filter((a) => a.kind !== "printer"), ...ids.map((refId) => ({ kind: "printer", refId }))]
  }));
  const imisPicked = applications.some((a) => a.IsImis && value.applicationIds.includes(a.Id));

  return (
    <>
      {showNewHire && (
        <fieldset>
          <legend>New hire</legend>
          <div className="row">
            <label className="grow">
              First name
              <input value={hire.firstName} onChange={nameChange("firstName")} required maxLength={100} />
            </label>
            <label className="grow">
              Last name
              <input value={hire.lastName} onChange={nameChange("lastName")} required maxLength={100} />
            </label>
          </div>
          <label>
            Display name
            <input value={hire.displayName} maxLength={200}
              onChange={(e) => { autoDisplay.current = !e.target.value; setHire({ displayName: e.target.value }); }} />
          </label>
          <div className="row">
            <label className="grow">
              Department
              <select value={hire.departmentId} required onChange={(e) => setHire({ departmentId: e.target.value, jobTitleId: "", jobTitleName: "" })}>
                <option value="">Choose</option>
                {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
              </select>
            </label>
            <label className="grow">
              Job title
              <select value={hire.jobTitleId} disabled={!hire.departmentId} onChange={(e) => setHire({ jobTitleId: e.target.value })}>
                <option value="">{hire.departmentId ? "Choose" : "Pick the department first"}</option>
                {titles.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
                {hire.departmentId && <option value={OTHER_TITLE}>Something else (type it)</option>}
              </select>
            </label>
          </div>
          {hire.jobTitleId === OTHER_TITLE && (
            <label>
              New job title
              <input value={hire.jobTitleName} onChange={(e) => setHire({ jobTitleName: e.target.value })} required maxLength={150} autoFocus />
              <span className="muted small">It&apos;s added to the department&apos;s titles, starting from the general defaults.</span>
            </label>
          )}
        </fieldset>
      )}

      <fieldset>
        <legend>Equipment</legend>
        <MultiSelect label="Equipment" placeholder="No equipment" value={itemIds} onChange={setItemIds} locked={value.required.items}
          options={lookups.inventoryItems.map((i) => ({ value: i.Id, label: i.Name }))} />
      </fieldset>

      <fieldset>
        <legend>Software they need</legend>
        {!applications.length && <p className="muted">No software is set up yet (Settings, Software).</p>}
        <div className="app-cards">
          {applications.map((a) => {
            const required = value.required.apps.includes(a.Id);
            const on = value.applicationIds.includes(a.Id);
            return (
              <label key={a.Id} className={`app-card${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} disabled={required} onChange={(e) => toggleApp(a.Id, e.target.checked)} />
                <span>
                  <strong>{a.Name}</strong>
                  {a.Description && <span className="muted small">{a.Description}</span>}
                  {required && <span className="muted small">Required for this job title</span>}
                </span>
              </label>
            );
          })}
        </div>
        {imisPicked && !isTechnician && <p className="muted small">IT sets up the exact iMIS access.</p>}
      </fieldset>

      <fieldset>
        <legend>Shared access</legend>
        {TEXT_ACCESS.map((t) => (
          <NoteList key={t.kind} label={t.label} placeholder={t.placeholder} items={texts(t.kind)}
            onAdd={(text) => addText(t.kind, text)} onRemove={(index) => removeText(t.kind, index)} />
        ))}
        <div className="field">
          <span>Printers</span>
          <MultiSelect label="Printers" placeholder="No printers" value={printerIds} onChange={setPrinterIds}
            options={printers.map((p) => ({ value: p.Id, label: printerLabel(p) }))} />
        </div>
      </fieldset>
    </>
  );
}
