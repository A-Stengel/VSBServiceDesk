import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api, money, perPeriod } from "../api.js";
import { useApp } from "../App.jsx";
import PersonPicker from "../components/PersonPicker.jsx";
import ItemsPicker from "../components/ItemsPicker.jsx";
import OnboardingFields, { emptyOnboarding, onboardingBody, printerLabel } from "../components/OnboardingFields.jsx";
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
// description, person, newHire: { firstName, lastName, displayName,
// departmentId } } }.
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
      categoryId: category ? String(category.Id) : ""
    },
    person: prefill.person || null,
    newHire: prefill.newHire || {}
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
  const [onboardingForm, setOnboardingForm] = useState(() => emptyOnboarding(start.newHire));
  const [printerSearch, setPrinterSearch] = useState("");
  const [inkIds, setInkIds] = useState([]);
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
  const [removals, setRemovals] = useState({ seatIds: [], ticketItemIds: [], accessIds: [] });

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
  // Onboarding has its own equipment and software pickers
  const showItems = !!field("items") && !onboarding;
  const showSoftware = !!field("software") && !onboarding;
  const showNewHire = onboarding && !!field("newHire");
  const subcategory = lookups.subcategories.find((s) => s.Id === Number(form.subcategoryId));
  const asksForInk = !!subcategory?.AsksForInk;
  // Onboarding and low ink tickets write their own subject and description
  const autoText = showNewHire || asksForInk;
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  // Low ink: which printer, and which of its cartridges are low
  const printers = lookups.printers || [];
  const shownPrinters = printers.filter((p) => printerLabel(p).toLowerCase().includes(printerSearch.trim().toLowerCase()));
  const printerInk = (lookups.printerInk || []).filter((c) => c.PrinterId === Number(form.printerId));
  useEffect(() => { setInkIds([]); }, [form.printerId]);

  // What the person holds, for "to remove"
  useEffect(() => {
    setRemovals({ seatIds: [], ticketItemIds: [], accessIds: [] });
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
    if (!autoText && !hasContent(form.description)) {
      setError("Description is required.");
      return;
    }
    if (asksForInk && !form.printerId) {
      setError("Pick the printer that's low on ink.");
      return;
    }
    if (asksForInk && printerInk.length && !inkIds.length) {
      setError("Pick which colors are low.");
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
        ...(onboarding ? onboardingBody(onboardingForm, showNewHire) : {}),
        printerId: asksForInk ? Number(form.printerId) : undefined,
        inkCartridgeIds: asksForInk ? inkIds : undefined,
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
    setForm({ ...form, categoryId: "", subcategoryId: "", printerId: "" });
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
            Subject{autoText ? " (optional, filled in for you)" : ""}
            <input value={form.subject} onChange={set("subject")} maxLength={255} required={!autoText} />
          </label>

          {fields.map((f) => {
            const label = `${f.Label}${f.IsRequired ? "" : " (optional)"}`;
            switch (f.FieldKey) {
              case "category":
                return (
                  <label key={f.FieldKey}>
                    {label}
                    <select value={form.categoryId || ""} onChange={(e) => setForm({ ...form, categoryId: e.target.value, subcategoryId: "", printerId: "" })} required={f.IsRequired}>
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
              default:
                return null; // the new hire, items and software are shown below
            }
          })}

          {asksForInk && (
            <fieldset>
              <legend>Which printer?</legend>
              {!printers.length && <p className="muted">No printers are set up yet. Say which printer in the description.</p>}
              {printers.length > 8 && (
                <input value={printerSearch} onChange={(e) => setPrinterSearch(e.target.value)} placeholder="Search printers" aria-label="Search printers" />
              )}
              {printers.length > 0 && (
                <div className="pick-list" role="radiogroup" aria-label="Printer">
                  {shownPrinters.map((p) => (
                    <label key={p.Id} className="check">
                      <input type="radio" name="printer" checked={Number(form.printerId) === p.Id} onChange={() => setForm({ ...form, printerId: String(p.Id) })} />
                      {printerLabel(p)}
                    </label>
                  ))}
                  {!shownPrinters.length && <span className="muted small">No printer matches.</span>}
                </div>
              )}
              {form.printerId && (
                <div className="field">
                  <span>Which colors are low?</span>
                  {!printerInk.length && <p className="muted small" style={{ margin: 0 }}>No cartridges are listed for this printer. Say which colors in the description.</p>}
                  <div className="checks">
                    {printerInk.map((c) => (
                      <label key={c.InkCartridgeId} className="check">
                        <input type="checkbox" checked={inkIds.includes(c.InkCartridgeId)}
                          onChange={(e) => setInkIds(e.target.checked ? [...inkIds, c.InkCartridgeId] : inkIds.filter((x) => x !== c.InkCartridgeId))} />
                        {c.Color} ({c.Name})
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </fieldset>
          )}

          {onboarding && (
            <OnboardingFields lookups={lookups} value={onboardingForm} onChange={setOnboardingForm} showNewHire={showNewHire} isTechnician={me.IsTechnician} />
          )}

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
              {holdings && !holdings.seats.length && !holdings.items.length && !holdings.access?.length && (
                <p className="muted">They don't hold any equipment, licenses or access.</p>
              )}
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
              {holdings?.access?.map((a) => (
                <label key={`a${a.Id}`} className="check">
                  <input type="checkbox" checked={removals.accessIds.includes(a.Id)} onChange={(e) => toggleRemoval("accessIds", a.Id, e.target.checked)} />
                  Remove access: {a.Label}
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
            <span>Description{autoText ? " (optional)" : ""}</span>
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
