import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, money, perPeriod } from "../api.js";
import { useApp } from "../App.jsx";
import PersonPicker from "../components/PersonPicker.jsx";
import ItemsPicker from "../components/ItemsPicker.jsx";
import RichEditor from "../components/RichEditor.jsx";
import { hasContent, plainToRich, withPastedImages } from "../richtext.js";

// One form that changes with the ticket type: pick the type first, then the
// fields set up for that type (Settings, Form fields) appear, plus the fields
// of the category picked (Access & Equipment has its own per category).
// Subject, Description, Priority, CC and Attachments are on every type.
//
// Links can pick the type (?type=support or ?type=access, plus &kind=
// onboarding, change or offboarding), and the People page opens it prefilled
// through the navigation state: { prefill: { type, kind, subject,
// description, person, newHireName } }.
const TYPE_DESCRIPTIONS = {
  "Support": "Something is broken or you have a question",
  "Access & Equipment": "Onboarding, changes, off boarding",
  "Equipment Rental": "Borrow equipment, book a room, or both",
  "Equipment Rental / Event Booking": "Borrow equipment, book a room, or both"
};

function startingPoint(lookups, params, state) {
  const prefill = state?.prefill || {};
  const typeKey = prefill.type || params.get("type");
  const byKey = { support: "Support", access: "Access & Equipment" };
  const type = lookups.ticketTypes.find((t) => String(t.Id) === typeKey || t.Name === byKey[typeKey]);
  const kind = prefill.kind || params.get("kind");
  const category = type && kind ? lookups.categories.find((c) => c.TicketTypeId === type.Id && c.ChecklistSource === kind) : null;
  return {
    typeId: type ? String(type.Id) : "",
    form: {
      subject: prefill.subject || "",
      description: plainToRich(prefill.description || ""),
      priorityId: lookups.defaults.defaultPriorityId || "",
      cc: "",
      categoryId: category ? String(category.Id) : "",
      newHireName: prefill.newHireName || ""
    },
    person: prefill.person || null
  };
}

export default function SubmitRequest() {
  const { me, lookups, notify } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const [start] = useState(() => startingPoint(lookups, params, location.state));
  const [typeId, setTypeId] = useState(start.typeId);
  const [form, setForm] = useState(start.form);
  const [items, setItems] = useState([]);
  const [softwareIds, setSoftwareIds] = useState([]);
  const [forUser, setForUser] = useState(start.person);
  const [requester, setRequester] = useState(null);
  const [forColleague, setForColleague] = useState(false);
  const [colleague, setColleague] = useState(null);
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
  // Everyone but technicians (who use the Requester box) can ask for a
  // coworker. Access & Equipment asks who it's for itself, so it's left out.
  const canSubmitForColleague = !me.IsTechnician && !type?.UsesChecklist && !field("forUser") && !field("newHire") && !category?.ChecklistSource;
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
    if (!hasContent(form.description)) {
      setError("Description is required.");
      return;
    }
    if (canSubmitForColleague && forColleague && !colleague) {
      setError("Pick who the request is for, or untick \"This is for someone else\".");
      return;
    }
    setSaving(true);
    try {
      const fields = {
        ...form,
        ticketTypeId: Number(typeId),
        items,
        softwareIds,
        forUserId: forUser?.Id,
        removals: showRemovals ? removals : undefined,
        requesterId: requester?.Id,
        onBehalfOfId: canSubmitForColleague && forColleague ? colleague?.Id : undefined
      };
      const { data, files: withImages } = withPastedImages(fields, "description", files);
      const result = await api.createTicket(data, withImages);
      notify([`Ticket ${result.ticket.Number} created.`, ...(result.warnings || [])].join(" "));
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

  const pickType = (t) => {
    // Equipment Rental and Event Booking share one form
    if (t.Id === lookups.defaults.bookingTicketTypeId) return navigate("/events/new");
    setTypeId(String(t.Id));
    setForm({ ...form, categoryId: "", subcategoryId: "" });
  };

  return (
    <form className="card form" onSubmit={submit} style={{ maxWidth: 820 }}>
      <h1>Submit a request</h1>

      <fieldset>
        <legend>What do you need?</legend>
        <div className="choices">
          {lookups.ticketTypes.map((t) => (
            <button type="button" key={t.Id} className={`choice ${String(t.Id) === typeId ? "on" : ""}`} onClick={() => pickType(t)}
              aria-pressed={String(t.Id) === typeId}>
              <strong>{t.Id === lookups.defaults.bookingTicketTypeId ? "Equipment Rental / Event Booking" : t.Name}</strong>
              {TYPE_DESCRIPTIONS[t.Name] && <span className="qd">{TYPE_DESCRIPTIONS[t.Name]}</span>}
            </button>
          ))}
        </div>
      </fieldset>

      {type && category?.ChecklistSource === "onboarding" && forUser && !field("forUser") && (
        <p className="muted small" style={{ margin: 0 }}>
          This brings back {forUser.DisplayName}&apos;s account. Closing the ticket turns it on again.
        </p>
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
                  <button type="button" className="btn sm" onClick={addPerson}>Add</button>
                  <button type="button" className="btn sm ghost" onClick={() => setNewPerson(null)}>Cancel</button>
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

          {canSubmitForColleague && (
            <fieldset>
              <legend>Who is it for?</legend>
              <label className="check">
                <input type="checkbox" checked={forColleague} onChange={(e) => setForColleague(e.target.checked)} />
                This is for someone else
              </label>
              {forColleague && (
                <>
                  <label>
                    Who is it for?
                    <PersonPicker value={colleague} onChange={setColleague} />
                  </label>
                  <p className="muted small" style={{ margin: 0 }}>They become the requester and you&apos;re added to the CC line, so you both get the emails and can see the ticket.</p>
                </>
              )}
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
              {me.IsTechnician && itemsTotal > 0 && <p className="muted">Equipment cost (tracking only): {money(itemsTotal)}</p>}
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
                  {s.Name}
                  {me.IsTechnician && (
                    <span className="muted">{money(s.CostPerSeat)} per seat {perPeriod(lookups.billingPeriods.find((b) => b.Id === s.BillingPeriodId))}</span>
                  )}
                </label>
              ))}
            </fieldset>
          )}

          <div className="field">
            <span>Description</span>
            <RichEditor value={form.description} onChange={(description) => setForm((f) => ({ ...f, description }))} images
              label="Description" minHeight={150} onError={setError} />
          </div>

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
          <div>
            <button type="submit" className="btn pri" disabled={saving}>{saving ? "Submitting…" : "Submit"}</button>
          </div>
        </>
      )}
    </form>
  );
}
