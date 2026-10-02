import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, money } from "../api.js";
import { useApp } from "../App.jsx";
import PersonPicker from "../components/PersonPicker.jsx";
import ItemsPicker from "../components/ItemsPicker.jsx";

// One form that changes with the ticket type: pick the type first, then the
// fields set up for that type (Settings, Form fields) appear. Subject,
// Description, Priority, CC and Attachments are on every type.
export default function SubmitRequest() {
  const { me, lookups } = useApp();
  const navigate = useNavigate();
  const [typeId, setTypeId] = useState("");
  const [form, setForm] = useState({ subject: "", description: "", priorityId: lookups.defaults.defaultPriorityId || "", cc: "" });
  const [items, setItems] = useState([]);
  const [softwareIds, setSoftwareIds] = useState([]);
  const [forUser, setForUser] = useState(null);
  const [requester, setRequester] = useState(null);
  const [files, setFiles] = useState([]);
  const [available, setAvailable] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [newPerson, setNewPerson] = useState(null);

  const type = lookups.ticketTypes.find((t) => t.Id === Number(typeId));
  const fields = useMemo(
    () => lookups.ticketTypeFields.filter((f) => f.TicketTypeId === Number(typeId)),
    [lookups, typeId]
  );
  const field = (key) => fields.find((f) => f.FieldKey === key);
  const onboarding = type?.ChecklistSource === "onboarding";
  const showItems = !!field("items") || onboarding;
  const showSoftware = !!field("software") || onboarding;
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  // Onboarding starts with the global defaults ticked
  useEffect(() => {
    if (onboarding) {
      setItems(lookups.inventoryItems.filter((i) => i.IsDefaultForOnboarding).map((i) => ({ inventoryItemId: i.Id, quantity: 1 })));
      setSoftwareIds(lookups.software.filter((s) => s.IsDefaultForOnboarding).map((s) => s.Id));
    } else {
      setItems([]);
      setSoftwareIds([]);
    }
  }, [onboarding, lookups]);

  // Free counts for the chosen dates, to warn about double-booking
  useEffect(() => {
    if (!showItems) return setAvailable(null);
    api.availability({ startDate: form.startDate, endDate: form.endDate }).then(setAvailable).catch(() => setAvailable(null));
  }, [showItems, form.startDate, form.endDate]);

  const subcategories = lookups.subcategories.filter((s) => s.CategoryId === Number(form.categoryId));
  const itemsTotal = items.reduce((sum, i) => {
    const item = lookups.inventoryItems.find((x) => x.Id === i.inventoryItemId);
    return sum + (item ? item.UnitCost * i.quantity : 0);
  }, 0);

  async function submit(e) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const data = {
        ...form,
        ticketTypeId: Number(typeId),
        items,
        softwareIds,
        forUserId: forUser?.Id,
        requesterId: requester?.Id
      };
      const result = await api.createTicket(data, files);
      if (result.warnings?.length) alert(`Ticket created. Please note:\n${result.warnings.join("\n")}`);
      navigate(`/tickets/${result.ticket.Id}`);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  async function addPerson(e) {
    e.preventDefault();
    try {
      const person = await api.createUser(newPerson);
      setRequester(person);
      setNewPerson(null);
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <form className="card form" onSubmit={submit}>
      <h1>Submit a request</h1>

      <label>
        What do you need?
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} required>
          <option value="">Choose a request type</option>
          {lookups.ticketTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
        </select>
      </label>

      {type && (
        <>
          {me.IsTechnician && (
            <fieldset>
              <legend>Logged by a technician</legend>
              <label>
                Requester (leave empty for yourself)
                <PersonPicker technician value={requester} onChange={setRequester} />
              </label>
              {!requester && !newPerson && (
                <button type="button" className="link" onClick={() => setNewPerson({ firstName: "", lastName: "", email: "" })}>
                  Add someone who isn't listed
                </button>
              )}
              {newPerson && (
                <div className="row">
                  <input placeholder="First name" value={newPerson.firstName} onChange={(e) => setNewPerson({ ...newPerson, firstName: e.target.value })} />
                  <input placeholder="Last name" value={newPerson.lastName} onChange={(e) => setNewPerson({ ...newPerson, lastName: e.target.value })} />
                  <input placeholder="Email" type="email" value={newPerson.email} onChange={(e) => setNewPerson({ ...newPerson, email: e.target.value })} />
                  <button type="button" onClick={addPerson}>Add</button>
                  <button type="button" className="link" onClick={() => setNewPerson(null)}>Cancel</button>
                </div>
              )}
              <label>
                Source
                <select value={form.sourceId || ""} onChange={set("sourceId")}>
                  <option value="">Web (default)</option>
                  {lookups.sources.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
                </select>
              </label>
            </fieldset>
          )}

          <label>
            Subject
            <input value={form.subject} onChange={set("subject")} maxLength={255} required />
          </label>

          {fields.map((f) => {
            const label = `${f.Label}${f.IsRequired ? "" : " (optional)"}`;
            switch (f.FieldKey) {
              case "category":
                return (
                  <label key={f.FieldKey}>
                    {label}
                    <select value={form.categoryId || ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value, subcategoryId: "" })} required={f.IsRequired}>
                      <option value="">Choose</option>
                      {lookups.categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
                    </select>
                  </label>
                );
              case "subcategory":
                return (
                  <label key={f.FieldKey}>
                    {label}
                    <select value={form.subcategoryId || ""} onChange={set("subcategoryId")} required={f.IsRequired && subcategories.length > 0} disabled={!subcategories.length}>
                      <option value="">{subcategories.length ? "Choose" : "None for this category"}</option>
                      {subcategories.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
                    </select>
                  </label>
                );
              case "startDate":
              case "endDate":
                return (
                  <label key={f.FieldKey}>
                    {label}
                    <input type="date" value={form[f.FieldKey] || ""} onChange={set(f.FieldKey)} required={f.IsRequired} />
                  </label>
                );
              case "forUser":
                return (
                  <label key={f.FieldKey}>
                    {label}
                    <PersonPicker technician={me.IsTechnician} value={forUser} onChange={setForUser} />
                  </label>
                );
              case "newHire":
                return (
                  <div key={f.FieldKey} className="row">
                    <label>
                      {label}
                      <input value={form.newHireName || ""} onChange={set("newHireName")} required={f.IsRequired} placeholder="Full name" />
                    </label>
                    <label>
                      Their department
                      <select value={form.newHireDepartmentId || ""} onChange={set("newHireDepartmentId")}>
                        <option value="">Choose</option>
                        {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
                      </select>
                    </label>
                  </div>
                );
              default:
                return null; // items and software are shown below
            }
          })}

          {showItems && (
            <fieldset>
              <legend>{field("items")?.Label || "Equipment"}</legend>
              <ItemsPicker inventory={lookups.inventoryItems} value={items} onChange={setItems} available={available} />
              {itemsTotal > 0 && <p className="muted">Equipment cost (tracking only): {money(itemsTotal)}</p>}
            </fieldset>
          )}

          {showSoftware && (
            <fieldset>
              <legend>{field("software")?.Label || "Software licenses"}</legend>
              {!lookups.software.length && <p className="muted">No software is set up yet (Settings, Software).</p>}
              {lookups.software.map((s) => (
                <label key={s.Id} className="check">
                  <input type="checkbox" checked={softwareIds.includes(s.Id)}
                    onChange={(e) => setSoftwareIds(e.target.checked ? [...softwareIds, s.Id] : softwareIds.filter((x) => x !== s.Id))} />
                  {s.Name} <span className="muted">{money(s.CostPerSeat)} per seat</span>
                </label>
              ))}
            </fieldset>
          )}

          <label>
            Description
            <textarea rows={6} value={form.description} onChange={set("description")} required />
          </label>

          <div className="row">
            <label>
              Priority
              <select value={form.priorityId} onChange={set("priorityId")}>
                {lookups.priorities.map((p) => <option key={p.Id} value={p.Id}>{p.Name}</option>)}
              </select>
            </label>
            <label className="grow">
              CC (emails, comma separated, optional)
              <input value={form.cc} onChange={set("cc")} />
            </label>
          </div>

          <label>
            Attachments (up to 10 files, 10 MB each)
            <input type="file" multiple onChange={(e) => setFiles([...e.target.files])} />
          </label>

          {error && <p className="error">{error}</p>}
          <button type="submit" className="primary" disabled={saving}>{saving ? "Submitting…" : "Submit"}</button>
        </>
      )}
    </form>
  );
}
