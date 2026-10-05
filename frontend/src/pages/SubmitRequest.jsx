import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, money } from "../api.js";
import { useApp } from "../App.jsx";
import PersonPicker from "../components/PersonPicker.jsx";
import ItemsPicker from "../components/ItemsPicker.jsx";

// One form that changes with the ticket type: pick the type first, then the
// fields set up for that type (Settings, Form fields) appear, plus the fields
// of the category picked (Access & Equipment has its own per category).
// Subject, Description, Priority, CC and Attachments are on every type.
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
  const [holdings, setHoldings] = useState(null);
  const [removals, setRemovals] = useState({ seatIds: [], ticketItemIds: [] });

  const type = lookups.ticketTypes.find((t) => t.Id === Number(typeId));
  const categories = lookups.categories.filter((c) => c.TicketTypeId === Number(typeId));
  const category = categories.find((c) => c.Id === Number(form.categoryId));
  const fields = useMemo(
    () => lookups.ticketTypeFields
      .filter((f) => f.TicketTypeId === Number(typeId) && (f.CategoryId === null || f.CategoryId === Number(form.categoryId)))
      .sort((a, b) => a.SortOrder - b.SortOrder),
    [lookups, typeId, form.categoryId]
  );
  const field = (key) => fields.find((f) => f.FieldKey === key);
  const onboarding = category?.ChecklistSource === "onboarding";
  const showRemovals = !!field("removals");
  // Technicians can pick from anyone's holdings; staff only from their own
  const canSeeHoldings = forUser && (me.IsTechnician || forUser.Id === me.Id);
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

  // What the person holds, for "to remove"
  useEffect(() => {
    setRemovals({ seatIds: [], ticketItemIds: [] });
    if (!showRemovals || !canSeeHoldings) return setHoldings(null);
    api.holdings(forUser.Id).then(setHoldings).catch(() => setHoldings(null));
  }, [showRemovals, canSeeHoldings, forUser]);

  const toggleRemoval = (key, id, on) =>
    setRemovals({ ...removals, [key]: on ? [...removals[key], id] : removals[key].filter((x) => x !== id) });

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
        removals: showRemovals ? removals : undefined,
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
        <select value={typeId} onChange={(e) => { setTypeId(e.target.value); setForm({ ...form, categoryId: "", subcategoryId: "" }); }} required>
          <option value="">Choose a request type</option>
          {lookups.ticketTypes.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
        </select>
      </label>

      {type && type.Id === lookups.defaults.bookingTicketTypeId && (
        <p className="muted">Need a conference room as well? <Link to="/events/new">Book an event</Link> instead, and add the equipment there.</p>
      )}

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
                      {categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
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

          {showRemovals && (
            <fieldset>
              <legend>{field("removals").Label}</legend>
              {!forUser && <p className="muted">Pick who it's for first.</p>}
              {forUser && !canSeeHoldings && (
                <p className="muted">Say what to remove in the description. IT will match it to what they hold.</p>
              )}
              {holdings && !holdings.seats.length && !holdings.items.length && <p className="muted">They don't hold any equipment or licenses.</p>}
              {holdings?.items.map((i) => (
                <label key={`i${i.Id}`} className="check">
                  <input type="checkbox" checked={removals.ticketItemIds.includes(i.Id)} onChange={(e) => toggleRemoval("ticketItemIds", i.Id, e.target.checked)} />
                  Collect: {i.Name}{i.Quantity > 1 ? ` (x${i.Quantity})` : ""}
                </label>
              ))}
              {holdings?.seats.map((s) => (
                <label key={`s${s.Id}`} className="check">
                  <input type="checkbox" checked={removals.seatIds.includes(s.Id)} onChange={(e) => toggleRemoval("seatIds", s.Id, e.target.checked)} />
                  Remove license: {s.Name}
                </label>
              ))}
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
