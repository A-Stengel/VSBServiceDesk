import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, dayValue, formatDate, formatDay, formatWallRange, money } from "../api.js";
import { useApp } from "../App.jsx";
import { ACCESS_TEXT, IMIS_LEVELS } from "../access.js";
import PersonPicker from "../components/PersonPicker.jsx";
import BookingForm from "../components/BookingForm.jsx";
import RichEditor from "../components/RichEditor.jsx";
import RichText from "../components/RichText.jsx";
import { hasContent, plainToRich, withPastedImages } from "../richtext.js";

// One ticket. An Equipment Rental / Event Booking ticket also has an event
// panel: the event's details and its room, which HR (Event Managers)
// confirms or declines. HR sees only that part: the event, the room, replies,
// HR notes and the room's history, but no equipment, technician notes,
// status or technician.
export default function TicketPage() {
  const { id } = useParams();
  const { me, lookups } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.ticket(id).then(setData).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => setEditing(false), [id]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { ticket, access } = data;

  const isTech = me.IsTechnician;
  const hrView = access.roomOnlyView;
  const isBooking = ticket.TicketTypeId === lookups.defaults.bookingTicketTypeId && (ticket.HasRoom || ticket.StartAt);
  const noteLabel = (c) => (c.VisibleToEventManagers ? "HR note (the requester can't see this)" : "Internal note (only technicians see this)");

  return (
    <div className="split">
      <div>
        <div className="card">
          <div className="muted small">
            #{ticket.Number} · {hrView ? "Event booking" : ticket.TicketTypeName}{ticket.CategoryName ? ` · ${ticket.CategoryName}` : ""}
            {ticket.LegacyId ? ` · imported ${ticket.LegacyId}` : ""}
          </div>
          <h1 style={{ margin: "4px 0 6px" }}>{ticket.Subject}</h1>
          <div className="row center" style={{ gap: 8, marginBottom: 12 }}>
            {hrView
              ? <span className="pill" style={{ background: ticket.RoomStatusColor || undefined }}>Room {String(ticket.RoomStatusName).toLowerCase()}</span>
              : <span className="pill" style={{ background: ticket.StatusColor || undefined }}>{ticket.StatusName}</span>}
            {hrView && ticket.IsClosed && <span className="pill">Closed</span>}
            <span className="muted small">
              {ticket.RequesterName} ({ticket.RequesterEmail}) · {formatDate(ticket.CreatedAt)}{hrView ? "" : ` · via ${ticket.SourceName}`}
            </span>
          </div>
          {editing ? (
            <EditBooking ticket={ticket} access={access} items={data.items} onDone={(saved) => { setEditing(false); if (saved) load(); }} />
          ) : (
            <>
              {isBooking && ticket.Description && <h3 style={{ margin: "0 0 6px" }}>Comments</h3>}
              <RichText value={ticket.Description} />
            </>
          )}
          <Files attachments={data.attachments.filter((a) => !a.ConversationId)} />
          {data.cc.length > 0 && <p className="muted small">CC: {data.cc.join(", ")}</p>}
        </div>

        {ticket.MergedIntoId && (
          <p className="flag">
            Merged into <Link className="link" to={`/tickets/${ticket.MergedIntoId}`}>Ticket #{ticket.MergedIntoNumber}</Link>. Replies to this ticket's emails go there.
          </p>
        )}

        {/* Newest first, like the emails, with the reply box on top */}
        <ReplyBox ticket={ticket} access={access} onSaved={load} />

        {data.conversations.map((c) => (
          <div key={c.Id} className={`card message ${c.IsResolution ? "resolution" : c.IsTechnicianNote ? "note" : c.Direction === "out" ? "out" : ""}`}>
            <div className="meta">
              <strong>{c.AuthorName}</strong> · {formatDate(c.CreatedAt)}
              {c.IsResolution ? " · Resolution (only technicians see this)" : c.IsTechnicianNote && ` · ${noteLabel(c)}`}
              {c.CameByEmail === 1 && " · by email"}
              {c.MergedFromTicketId && <> · merged from <Link className="link" to={`/tickets/${c.MergedFromTicketId}`}>#{String(c.MergedFromTicketId).padStart(7, "0")}</Link></>}
              {!c.IsTechnicianNote && c.Direction === "out" && c.EmailedAt && " · Emailed"}
              {!c.IsTechnicianNote && c.Direction === "out" && c.EmailNote && <span className="warn"> · {c.EmailNote}</span>}
            </div>
            <RichText value={c.Body} />
            <Files attachments={data.attachments.filter((a) => a.ConversationId === c.Id)} />
          </div>
        ))}
      </div>

      <aside>
        {isBooking && <EventPanel ticket={ticket} access={access} editing={editing} onEdit={() => setEditing(true)} onSaved={load} />}
        {/* A room-only request is HR's, so its IT status means nothing to the requester */}
        {isTech && data.survey?.AnsweredAt && (
          <div className="card">
            <h3>Satisfaction survey</h3>
            <p style={{ margin: 0 }}><strong>{data.survey.Rating} of 5</strong> <span className="muted small">· {formatDate(data.survey.AnsweredAt)}</span></p>
            {data.survey.Comment && <p style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{data.survey.Comment}</p>}
          </div>
        )}
        {isTech && !ticket.IsClosed && !ticket.MergedIntoId && !(ticket.HasRoom && !ticket.HasEquipment) && (
          <TicketActions ticket={ticket} onSaved={load} />
        )}
        {isTech ? <TechnicianPanel ticket={ticket} onSaved={load} />
          : !hrView && !(ticket.HasRoom && !ticket.HasEquipment) && <RequesterPanel ticket={ticket} />}
        {(ticket.NewHireFirstName || ticket.JobTitleName) && <NewHirePanel ticket={ticket} />}
        {(ticket.AsksForInk || data.ink?.length > 0) && <InkPanel ticket={ticket} ink={data.ink || []} onSaved={load} />}
        {access.equipment && (ticket.UsesInventory || data.items.length > 0) && <ItemsPanel ticket={ticket} items={data.items} onSaved={load} />}
        {access.equipment && (data.checklist.length > 0 || (isTech && ticket.UsesChecklist)) && (
          <ChecklistPanel ticket={ticket} checklist={data.checklist} onSaved={load} />
        )}
        {data.events.length > 0 && (
          <div className="card">
            <h3>History</h3>
            <ul className="history">
              {[...data.events].reverse().map((e) => (
                <li key={e.Id}>
                  <span className="muted small">{formatDate(e.At)} · {e.ActorName || "System"}</span>
                  <br />
                  {e.Field}{e.OldValue || e.NewValue ? ": " : ""}
                  {e.OldValue && <s>{e.OldValue}</s>}{e.OldValue && e.NewValue ? " → " : ""}{e.NewValue}
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

// The event and its room: details, the room's status, Confirm and Decline for
// HR, and Change and Cancel for anyone who can change it.
function EventPanel({ ticket, access, editing, onEdit, onSaved }) {
  const { me, lookups, notify } = useApp();
  const pending = ticket.BookingStatusId === lookups.defaults.bookingPendingStatusId;
  const confirmed = ticket.BookingStatusId === lookups.defaults.bookingConfirmedStatusId;
  const roomActive = ticket.HasRoom && ticket.IsActiveBooking;
  const open = !ticket.IsClosed;
  const isRequester = ticket.RequesterId === me.Id || ticket.ForUserId === me.Id;

  async function act(action, ask, message) {
    let reason;
    if (ask) {
      reason = prompt(ask);
      if (reason === null) return;
    }
    try {
      const result = await api.bookingAction(ticket.Id, action, reason || undefined);
      notify([message, ...(result.warnings || [])].join(" "));
      onSaved();
    } catch (err) {
      notify(err.message, true);
    }
  }

  const when = ticket.StartAt ? formatWallRange(ticket.StartAt, ticket.EndAt)
    : [formatDay(ticket.StartDate), formatDay(ticket.EndDate)].filter(Boolean).join(" to ");
  const facts = [
    ["When", when],
    ...(ticket.HasRoom
      ? [
          ["Attendee count", ticket.AttendeeCount],
          ["Refreshments", ticket.Refreshments ? "Yes" : "No"],
          ["FOIA", ticket.Foia ? "Yes" : "No"],
          ["Lunch catered", ticket.LunchCatered ? "Yes" : "No"]
        ]
      : [])
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  return (
    <div className="card">
      <h3>Event</h3>
      <dl className="facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <h3 style={{ marginTop: 14 }}>Room</h3>
      {!ticket.HasRoom && <p className="muted small" style={{ margin: 0 }}>No room on this request.</p>}
      {ticket.HasRoom && (
        <>
          <p style={{ margin: "0 0 8px" }}>
            {ticket.RoomName} <span className="pill" style={{ background: ticket.RoomStatusColor || undefined }}>{ticket.RoomStatusName}</span>
          </p>
          {ticket.HasOverlap && <p className="flag">Another active booking has {ticket.RoomName} at an overlapping time. Check before confirming.</p>}
          {ticket.ConfirmedByName && <p className="muted small">Confirmed by {ticket.ConfirmedByName}, {formatDate(ticket.ConfirmedAt)}</p>}
          {open && roomActive && access.canDecideRoom && (
            <div className="row">
              {pending && <button className="btn pri sm" onClick={() => act("confirm", null, "Room confirmed.")}>Confirm</button>}
              {(pending || confirmed) && (
                <button className="btn sm" onClick={() => act("decline", "Why is it declined? (optional, the requester sees this)", "Room declined.")}>Decline</button>
              )}
            </div>
          )}
          {open && roomActive && !access.canDecideRoom && pending && <p className="muted small">HR confirms or declines the room.</p>}
        </>
      )}
      {open && !editing && (isRequester || me.IsTechnician || access.hrNotes) && (
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn sm" onClick={onEdit}>Change</button>
          <button className="btn sm danger" onClick={() => act("cancel", "Cancel this request? Add a reason if you like.", "Request cancelled.")}>
            Cancel request
          </button>
        </div>
      )}
    </div>
  );
}

// Changing the event, room, comments and (for the requester and IT) the
// equipment, with the same form used to ask for it.
function EditBooking({ ticket, access, items, onDone }) {
  const { notify } = useApp();
  async function save(fields) {
    const { data, files } = withPastedImages(fields, "comments");
    const result = await api.updateBooking(ticket.Id, data, files);
    notify(["Changes saved.", ...(result.warnings || [])].join(" "));
    onDone(true);
  }
  return (
    <BookingForm
      initial={{
        title: ticket.Subject,
        startAt: ticket.StartAt || (ticket.StartDate ? `${dayValue(ticket.StartDate)}T09:00` : ""),
        endAt: ticket.EndAt || (ticket.EndDate ? `${dayValue(ticket.EndDate)}T17:00` : ""),
        roomId: ticket.RoomId ? String(ticket.RoomId) : "",
        roomName: ticket.RoomName,
        attendeeCount: ticket.AttendeeCount === null || ticket.AttendeeCount === undefined ? "" : String(ticket.AttendeeCount),
        refreshments: !!ticket.Refreshments,
        foia: !!ticket.Foia,
        lunchCatered: !!ticket.LunchCatered,
        comments: plainToRich(ticket.Description || ""),
        items: items.map((i) => ({ inventoryItemId: i.InventoryItemId, quantity: i.Quantity }))
      }}
      canChangeItems={access.equipment && !items.some((i) => i.OutAt)}
      roomOptional={access.equipment}
      excludeTicketId={ticket.Id}
      commentsLabel="Comments"
      submitLabel="Save changes"
      onSubmit={save}
      onCancel={() => onDone(false)}
    />
  );
}

function Files({ attachments }) {
  if (!attachments.length) return null;
  return (
    <ul className="files">
      {attachments.map((a) => (
        <li key={a.Id}>
          <a href={`/api/attachments/${a.Id}`}>{a.FileName}</a>{" "}
          <span className="muted">({Math.ceil(a.SizeBytes / 1024)} KB)</span>
        </li>
      ))}
    </ul>
  );
}

// Technicians write public replies or internal notes; HR write replies or HR
// notes (which technicians see too); the requester writes replies.
function ReplyBox({ ticket, access, onSaved }) {
  const { me, lookups, notify } = useApp();
  const [body, setBody] = useState("");
  const [isNote, setIsNote] = useState(false);
  const [statusId, setStatusId] = useState("");
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fileKey, setFileKey] = useState(0);
  const tech = me.IsTechnician;
  const hr = !tech && access.hrNotes;

  if (ticket.IsClosed && !tech && !hr) {
    return <div className="card"><p className="muted" style={{ margin: 0 }}>This ticket is closed. If you still need help, please submit a new request.</p></div>;
  }

  async function send(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { data, files: withImages } = withPastedImages({ body, isTechnicianNote: isNote, statusId: statusId || undefined }, "body", files);
      const result = await api.addConversation(ticket.Id, data, withImages);
      setBody("");
      setFiles([]);
      setStatusId("");
      setFileKey((k) => k + 1);
      notify([isNote ? "Note added." : "Reply sent.", ...(result.warnings || [])].join(" "));
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const noteName = tech ? "Internal note" : "HR note";
  const tooBig = !!lookups.email && files.reduce((sum, f) => sum + f.size, 0) > lookups.email.maxAttachmentBytes;
  const placeholder = isNote
    ? tech ? "Internal note, only technicians see this" : "HR note, HR and technicians see this"
    : tech || hr ? "Write a reply to the requester" : "Write a reply";

  return (
    <form className={`card form ${isNote ? "note" : ""}`} onSubmit={send}>
      {(tech || hr) && (
        <div className="composer-tabs">
          <button type="button" className={`btn sm ${!isNote ? "on" : ""}`} onClick={() => setIsNote(false)}>{tech ? "Public reply" : "Reply"}</button>
          <button type="button" className={`btn sm ${isNote ? "on" : ""}`} onClick={() => setIsNote(true)}>{noteName}</button>
        </div>
      )}
      <RichEditor value={body} onChange={setBody} images label={isNote ? noteName : "Reply"} placeholder={placeholder} onError={setError} />
      <input key={fileKey} type="file" multiple onChange={(e) => setFiles([...e.target.files])} aria-label="Attach files" />
      {(tech || hr) && !isNote && tooBig && (
        <p className="warn small" style={{ margin: 0 }}>
          These files are more than one email can carry (about {(lookups.email.maxAttachmentBytes / 1024 / 1024).toFixed(0)} MB). Attach fewer or smaller files.
        </p>
      )}
      {tech && (
        <label>
          Then set status to
          <select value={statusId} onChange={(e) => setStatusId(e.target.value)}>
            <option value="">{isNote ? "Leave as is" : "Awaiting User Response (default)"}</option>
            {lookups.statuses.filter((s) => !s.IsClosed).map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div>
        <button className="btn pri" disabled={saving || (!hasContent(body) && !files.length)}>
          {saving ? "Sending…" : isNote ? "Add note" : (tech || hr) && !(tech ? lookups.email?.reply : lookups.email?.hrReply) ? "Save reply (not emailed)" : "Send reply"}
        </button>
      </div>
    </form>
  );
}

function RequesterPanel({ ticket }) {
  const rows = [
    ["Assigned to", ticket.TechnicianName || "Not yet assigned"],
    ["Status", ticket.StatusName],
    ["Priority", ticket.PriorityName],
    ["Category", [ticket.CategoryName, ticket.SubcategoryName].filter(Boolean).join(" / ")],
    ["Source", ticket.SourceName],
    ["Created", formatDate(ticket.CreatedAt)],
    ["For", ticket.ForUserName || ticket.ForPersonName],
    ["Start date", formatDay(ticket.StartDate)],
    ["End date", formatDay(ticket.EndDate)]
  ].filter(([, v]) => v);
  return (
    <div className="card">
      <dl className="facts">
        {rows.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function TechnicianPanel({ ticket, onSaved }) {
  const { lookups, notify } = useApp();
  const [technicians, setTechnicians] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, []);

  async function save(changes, message) {
    setError("");
    try {
      const result = await api.updateTicket(ticket.Id, changes);
      const lines = [message, ...(result.warnings || [])].filter(Boolean);
      if (lines.length) notify(lines.join(" "));
      onSaved();
    } catch (err) {
      setError(err.message);
    }
  }

  const select = (label, key, list, value, allowEmpty) => (
    <label>
      {label}
      <select value={value ?? ""} onChange={(e) => save({ [key]: e.target.value || null })}>
        {allowEmpty && <option value="">None</option>}
        {list.map((o) => <option key={o.Id} value={o.Id}>{o.Name || o.DisplayName}</option>)}
      </select>
    </label>
  );
  const subcategories = lookups.subcategories.filter((s) => s.CategoryId === ticket.CategoryId);
  const categories = lookups.categories.filter((c) => c.TicketTypeId === ticket.TicketTypeId);
  // A retired type or category stays visible on tickets that already have it
  const types = lookups.ticketTypes.some((t) => t.Id === ticket.TicketTypeId)
    ? lookups.ticketTypes
    : [...lookups.ticketTypes, { Id: ticket.TicketTypeId, Name: `${ticket.TicketTypeName} (retired)` }];
  if (ticket.CategoryId && !categories.some((c) => c.Id === ticket.CategoryId)) {
    categories.push({ Id: ticket.CategoryId, Name: ticket.CategoryName });
  }

  return (
    <div className="card form">
      {select("Assigned to", "technicianId", technicians, ticket.TechnicianId, true)}
      {select("Status", "statusId", lookups.statuses.filter((s) => !s.IsClosed || s.Id === ticket.StatusId), ticket.StatusId)}
      {ticket.IsClosed && <p className="muted small" style={{ margin: "-8px 0 0" }}>Pick another status to reopen it.</p>}
      {select("Priority", "priorityId", lookups.priorities, ticket.PriorityId)}
      <label>
        Type
        <select value={ticket.TicketTypeId} onChange={(e) => save({ ticketTypeId: e.target.value, categoryId: null, subcategoryId: null })}>
          {types.map((t) => <option key={t.Id} value={t.Id}>{t.Name}</option>)}
        </select>
      </label>
      {categories.length > 0 && (
        <label>
          Category
          <select value={ticket.CategoryId ?? ""} onChange={(e) => save({ categoryId: e.target.value || null, subcategoryId: null })}>
            <option value="">None</option>
            {categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
          </select>
        </label>
      )}
      {subcategories.length > 0 && select("Subcategory", "subcategoryId", subcategories, ticket.SubcategoryId, true)}
      {select("Source", "sourceId", lookups.sources, ticket.SourceId)}
      {select("Department", "departmentId", lookups.departments, ticket.DepartmentId, true)}
      <label>
        For
        {ticket.ForPersonName && !ticket.ForUserId && <span className="muted"> (new hire: {ticket.ForPersonName})</span>}
        <PersonPicker technician
          value={ticket.ForUserId ? { Id: ticket.ForUserId, DisplayName: ticket.ForUserName } : null}
          onChange={(p) => save({ forUserId: p?.Id ?? null })} />
      </label>
      {!ticket.StartAt && (ticket.UsesDates || ticket.StartDate || ticket.EndDate) && (
        <div className="row">
          <label>
            Start date
            <input type="date" value={dayValue(ticket.StartDate)} onChange={(e) => save({ startDate: e.target.value || null })} />
          </label>
          <label>
            End date
            <input type="date" value={dayValue(ticket.EndDate)} onChange={(e) => save({ endDate: e.target.value || null })} />
          </label>
        </div>
      )}
      <dl className="facts">
        <div><dt>Created</dt><dd>{formatDate(ticket.CreatedAt)}</dd></div>
      </dl>
      {error && <p className="error">{error}</p>}
      {ticket.ClosedAt && <p className="muted small">Closed {formatDate(ticket.ClosedAt)}</p>}
      {!ticket.MergedIntoId && !ticket.HasRoom && <MergeBox ticket={ticket} />}
    </div>
  );
}

// The top of the side panel for technicians. An unassigned ticket shows Pick
// up: it asks for any of Category, Subcategory and Department that are blank
// (and have choices), then assigns the ticket to you, which moves a New
// ticket on. Once it's assigned it shows Close ticket, which asks for a
// written resolution (technicians only see it) and closes the ticket. That's
// the only way to close one by hand.
function TicketActions({ ticket, onSaved }) {
  const { me, lookups, notify } = useApp();
  const [dialog, setDialog] = useState(null);
  const categories = lookups.categories.filter((c) => c.TicketTypeId === ticket.TicketTypeId && c.IsActive !== false);
  const missing = [
    !ticket.CategoryId && categories.length > 0 && "category",
    !ticket.SubcategoryId && ticket.CategoryId && lookups.subcategories.some((s) => s.CategoryId === ticket.CategoryId) && "subcategory",
    !ticket.DepartmentId && lookups.departments.length > 0 && "department"
  ].filter(Boolean);

  async function pickUp(extra = {}) {
    const result = await api.updateTicket(ticket.Id, { ...extra, technicianId: me.Id });
    notify([`You picked up ticket ${ticket.Number}.`, ...(result.warnings || [])].join(" "));
    setDialog(null);
    onSaved();
  }

  return (
    <div className="card">
      {!ticket.TechnicianId ? (
        <button type="button" className="btn pri block"
          onClick={() => (missing.length ? setDialog("pickup") : pickUp().catch((e) => notify(e.message, true)))}>
          Pick up
        </button>
      ) : (
        <button type="button" className="btn pri block" onClick={() => setDialog("close")}>Close ticket</button>
      )}
      {dialog === "pickup" && <PickUpDialog ticket={ticket} missing={missing} onPickUp={pickUp} onCancel={() => setDialog(null)} />}
      {dialog === "close" && <CloseDialog ticket={ticket} onCancel={() => setDialog(null)} onClosed={() => { setDialog(null); onSaved(); }} />}
    </div>
  );
}

function PickUpDialog({ ticket, missing, onPickUp, onCancel }) {
  const { lookups } = useApp();
  const [form, setForm] = useState({ categoryId: ticket.CategoryId || "", subcategoryId: ticket.SubcategoryId || "", departmentId: ticket.DepartmentId || "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const categories = lookups.categories.filter((c) => c.TicketTypeId === ticket.TicketTypeId && c.IsActive !== false);
  const subcategories = lookups.subcategories.filter((s) => s.CategoryId === Number(form.categoryId) && s.IsActive !== false);
  const asks = (key) => missing.includes(key) || (key === "subcategory" && missing.includes("category"));
  const needsSub = asks("subcategory") && subcategories.length > 0;
  const ready = (!asks("category") || form.categoryId) && (!needsSub || form.subcategoryId) && (!asks("department") || form.departmentId);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    const changes = {};
    if (asks("category")) changes.categoryId = Number(form.categoryId);
    if (needsSub) changes.subcategoryId = Number(form.subcategoryId);
    if (asks("department")) changes.departmentId = Number(form.departmentId);
    try {
      await onPickUp(changes);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <form className="card form dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Pick up ticket {ticket.Number}</h2>
        <p className="muted small" style={{ margin: 0 }}>Fill in what&apos;s missing, then it&apos;s assigned to you.</p>
        {asks("category") && (
          <label>
            Category
            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value, subcategoryId: "" })} autoFocus>
              <option value="">Choose</option>
              {categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
            </select>
          </label>
        )}
        {needsSub && (
          <label>
            Subcategory
            <select value={form.subcategoryId} onChange={(e) => setForm({ ...form, subcategoryId: e.target.value })}>
              <option value="">Choose</option>
              {subcategories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
            </select>
          </label>
        )}
        {asks("department") && (
          <label>
            Department
            <select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })}>
              <option value="">Choose</option>
              {lookups.departments.map((d) => <option key={d.Id} value={d.Id}>{d.Name}</option>)}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn pri" disabled={!ready || saving}>{saving ? "Picking up…" : "Pick up"}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function CloseDialog({ ticket, onCancel, onClosed }) {
  const { lookups, notify } = useApp();
  const [resolution, setResolution] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const { closed, survey } = lookups.email || {};
  const told = closed || survey
    ? `The ${[closed && "closed email", survey && "survey"].filter(Boolean).join(" and ")} go${closed && survey ? "" : "es"} to the requester.`
    : "No closed email or survey goes out while they're switched off.";

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const { data, files } = withPastedImages({ resolution }, "resolution");
      const result = await api.closeTicket(ticket.Id, data, files);
      notify([`Ticket ${ticket.Number} closed. ${told}`, ...(result.warnings || [])].join(" "));
      onClosed();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <form className="card form dialog resolution" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Close ticket {ticket.Number}</h2>
        <RichEditor value={resolution} onChange={setResolution} images label="Resolution"
          placeholder="What was the problem and what fixed it? Only technicians see this." onError={setError} />
        <p className="muted small" style={{ margin: 0 }}>{told}</p>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="btn pri" disabled={saving || !hasContent(resolution)}>{saving ? "Closing…" : "Close ticket"}</button>
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

// Merging this ticket into another (for example when someone emails twice).
// This one closes with a link to the other, and sends no email.
function MergeBox({ ticket }) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState("");
  const [error, setError] = useState("");

  async function merge(e) {
    e.preventDefault();
    const intoId = Number(number.replace(/\D/g, ""));
    if (!intoId) return setError("Type the ticket number to merge into");
    if (!confirm(`Merge ticket ${ticket.Number} into ${String(intoId).padStart(7, "0")}? This ticket closes and its replies are copied there.`)) return;
    try {
      await api.mergeTicket(ticket.Id, intoId);
      notify(`Ticket ${ticket.Number} merged into ${String(intoId).padStart(7, "0")}.`);
      navigate(`/tickets/${intoId}`);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!open) return <button type="button" className="link small" onClick={() => setOpen(true)}>Merge into another ticket</button>;
  return (
    <form onSubmit={merge} className="form" style={{ gap: 8 }}>
      <label>
        Merge into ticket number
        <input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="0010023" inputMode="numeric" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="btn sm pri">Merge</button>
        <button type="button" className="btn sm" onClick={() => { setOpen(false); setError(""); }}>Cancel</button>
      </div>
    </form>
  );
}

function ItemsPanel({ ticket, items, onSaved }) {
  const { me, lookups } = useApp();
  const [adding, setAdding] = useState({ inventoryItemId: "", quantity: 1 });
  const total = items.reduce((sum, i) => sum + Number(i.TotalCost || 0), 0);

  async function act(promise) {
    try {
      const result = await promise;
      if (result?.warnings?.length) alert(result.warnings.join("\n"));
      onSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="card">
      <h3>Equipment</h3>
      {!items.length && <p className="muted">No equipment on this ticket.</p>}
      {items.length > 0 && (
        <table className="tbl compact">
          <thead><tr><th>Item</th><th>Qty</th>{me.IsTechnician && <th>Cost</th>}{me.IsTechnician && <th>Out</th>}{me.IsTechnician && <th>Back</th>}</tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.Id}>
                <td>{i.Name}</td>
                <td>{i.Quantity}</td>
                {me.IsTechnician && <td>{money(i.TotalCost)}</td>}
                {me.IsTechnician && (
                  <td><input type="checkbox" checked={!!i.OutAt} onChange={(e) => act(api.updateItem(ticket.Id, i.Id, { out: e.target.checked }))} /></td>
                )}
                {me.IsTechnician && (
                  <td><input type="checkbox" checked={!!i.ReturnedAt} onChange={(e) => act(api.updateItem(ticket.Id, i.Id, { returned: e.target.checked }))} /></td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {me.IsTechnician && total > 0 && <p className="muted">Total (tracking only): {money(total)}</p>}
      {me.IsTechnician && (
        <div className="row">
          <select value={adding.inventoryItemId} onChange={(e) => setAdding({ ...adding, inventoryItemId: e.target.value })}>
            <option value="">Add an item</option>
            {lookups.inventoryItems.map((i) => <option key={i.Id} value={i.Id}>{i.Name}</option>)}
          </select>
          <input type="number" min="1" className="qty" value={adding.quantity}
            onChange={(e) => setAdding({ ...adding, quantity: Math.max(1, parseInt(e.target.value || "1", 10)) })} />
          <button type="button" className="btn sm" disabled={!adding.inventoryItemId}
            onClick={() => act(api.addItem(ticket.Id, { inventoryItemId: Number(adding.inventoryItemId), quantity: adding.quantity }))}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}


// The checklist. Software lines say which license to give, with a dropdown
// to change it; iMIS module lines have their level. Both can change, or a
// line can come off, until it's ticked.
function ChecklistPanel({ ticket, checklist, onSaved }) {
  const { me, lookups } = useApp();
  const [adding, setAdding] = useState("");
  const [text, setText] = useState("");
  const [holdings, setHoldings] = useState(null);
  const personId = ticket.ForUserId || (ticket.ForPersonName ? null : ticket.RequesterId);
  const tech = me.IsTechnician;

  useEffect(() => {
    if (!tech || !personId) return setHoldings(null);
    api.holdings(personId).then(setHoldings).catch(() => setHoldings(null));
  }, [tech, personId, checklist.length]);

  async function run(promise) {
    try {
      await promise;
      onSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  // The picker's value says what kind of line it is, then the id:
  // item:, software:, app:, seat:, held:, given:, printer:, imisModule:,
  // imisRole:, imisGroup:, or a text kind (mailbox, calendar, phone)
  const [addKind, addId] = adding.split(":");
  const typing = !!ACCESS_TEXT[addKind];
  async function addLine() {
    const id = Number(addId);
    const body = {
      item: { inventoryItemId: id, quantity: 1 },
      software: { softwareId: id },
      app: { applicationId: id },
      seat: { seatId: id },
      held: { ticketItemId: id },
      given: { accessId: id },
      printer: { access: { kind: "printer", refId: id } },
      imisModule: { access: { kind: "imisModule", refId: id, level: 0 } },
      imisRole: { access: { kind: "imisRole", refId: id } },
      imisGroup: { access: { kind: "imisGroup", refId: id } }
    }[addKind] || { access: { kind: addKind, text } };
    await run(api.addChecklistLine(ticket.Id, body).then(() => { setAdding(""); setText(""); }));
  }

  const licensesFor = (applicationId) => lookups.software.filter((s) => s.ApplicationId === applicationId);
  const done = checklist.filter((c) => c.IsDone).length;
  const options = (list, kind) => (list || []).map((x) => <option key={`${kind}${x.Id}`} value={`${kind}:${x.Id}`}>{x.Name}</option>);
  return (
    <div className="card">
      <h3>Checklist ({done} of {checklist.length})</h3>
      {ticket.ChecklistSource === "offboarding" && <p className="muted small">Closing this ticket turns the person's account off.</p>}
      {ticket.ChecklistSource === "onboarding" && ticket.ForUserId && <p className="muted small">Closing this ticket turns the person's account on.</p>}
      {ticket.ChecklistSource === "onboarding" && !ticket.ForUserId && tech && (
        <p className="muted small">Link the new hire&apos;s account in the For field before ticking licenses and access.</p>
      )}
      <div className="stack-list">
        {checklist.map((c) => {
          const open = tech && !c.IsDone;
          const licenses = c.ApplicationId ? licensesFor(c.ApplicationId) : [];
          return (
            <div key={c.Id} className="stack-row">
              <label className="check grow">
                <input type="checkbox" checked={c.IsDone} disabled={!tech} onChange={(e) => run(api.updateChecklist(ticket.Id, c.Id, e.target.checked))} />
                <span>
                  {c.Label}
                  {c.IsDone && <span className="muted"> · {c.DoneByName}, {formatDate(c.DoneAt)}</span>}
                </span>
              </label>
              {open && c.ApplicationId && (
                <select aria-label="License" value={c.SoftwareId || ""} onChange={(e) => run(api.changeChecklistLine(ticket.Id, c.Id, { softwareId: Number(e.target.value) || null }))}>
                  <option value="">Pick a license</option>
                  {licenses.map((l) => <option key={l.Id} value={l.Id}>{l.Name}</option>)}
                </select>
              )}
              {open && c.AccessKind === "imisModule" && (
                <select aria-label="iMIS level" value={c.AccessLevel ?? 0} onChange={(e) => run(api.changeChecklistLine(ticket.Id, c.Id, { level: Number(e.target.value) }))}>
                  {IMIS_LEVELS.map(([n, name]) => <option key={n} value={n}>{n} - {name}</option>)}
                </select>
              )}
              {open && (
                <button type="button" className="link small" aria-label={`Remove the line ${c.Label}`}
                  onClick={() => run(api.deleteChecklistLine(ticket.Id, c.Id))}>Remove</button>
              )}
            </div>
          );
        })}
      </div>
      {tech && ticket.UsesChecklist && (
        <>
          <div className="row">
            <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a line">
              <option value="">Add a line</option>
              <optgroup label="Hand out to keep">{options(lookups.inventoryItems, "item")}</optgroup>
              <optgroup label="Give software">{options(lookups.applications, "app")}</optgroup>
              <optgroup label="Grant a license">{options(lookups.software, "software")}</optgroup>
              <optgroup label="Give access">
                {Object.entries(ACCESS_TEXT).map(([kind, label]) => <option key={kind} value={`${kind}:`}>{label} (type it)</option>)}
                {(lookups.printers || []).map((p) => <option key={`p${p.Id}`} value={`printer:${p.Id}`}>Printer: {p.Name}</option>)}
              </optgroup>
              {(lookups.imisModules || []).length > 0 && <optgroup label="iMIS module">{options(lookups.imisModules, "imisModule")}</optgroup>}
              {(lookups.imisRoles || []).length > 0 && <optgroup label="iMIS role">{options(lookups.imisRoles, "imisRole")}</optgroup>}
              {(lookups.imisGroups || []).length > 0 && <optgroup label="iMIS security group">{options(lookups.imisGroups, "imisGroup")}</optgroup>}
              {holdings && (holdings.items.length > 0 || holdings.seats.length > 0 || holdings.access?.length > 0) && (
                <optgroup label="Take back from them">
                  {holdings.items.map((i) => <option key={`h${i.Id}`} value={`held:${i.Id}`}>Collect: {i.Name}{i.Quantity > 1 ? ` (x${i.Quantity})` : ""}</option>)}
                  {holdings.seats.map((s) => <option key={`r${s.Id}`} value={`seat:${s.Id}`}>Remove license: {s.Name}</option>)}
                  {(holdings.access || []).map((a) => <option key={`g${a.Id}`} value={`given:${a.Id}`}>Remove access: {a.Label}</option>)}
                </optgroup>
              )}
            </select>
            {typing && <input value={text} onChange={(e) => setText(e.target.value)} placeholder={ACCESS_TEXT[addKind]} aria-label={ACCESS_TEXT[addKind]} maxLength={200} />}
            <button type="button" className="btn sm" disabled={!adding || (typing && !text.trim())} onClick={addLine}>Add</button>
          </div>
        </>
      )}
    </div>
  );
}

// The new hire on an onboarding ticket
function NewHirePanel({ ticket }) {
  const rows = [
    ["Name", ticket.ForPersonName],
    ["Department", ticket.ForDepartmentName],
    ["Job title", ticket.JobTitleName],
    ["Start date", formatDay(ticket.StartDate)]
  ].filter(([, v]) => v);
  return (
    <div className="card">
      <h3>New hire</h3>
      <dl className="facts">
        {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  );
}

// Low ink: the printer and the cartridges reported. Technicians see the
// stock, take one ("Take 1" lowers the count, never below zero) and can jump
// to those cartridges on the Inventory page.
function InkPanel({ ticket, ink, onSaved }) {
  const { me } = useApp();
  const navigate = useNavigate();
  const tech = me.IsTechnician;
  async function run(promise) {
    try {
      await promise;
      onSaved();
    } catch (err) {
      alert(err.message);
    }
  }
  return (
    <div className="card">
      <h3>Low ink</h3>
      <p style={{ marginTop: 0 }}>
        <strong>{ticket.PrinterName || "Printer not picked"}</strong>
        {ticket.PrinterLocation && <span className="muted"> · {ticket.PrinterLocation}</span>}
      </p>
      {!ink.length && <p className="muted small">No cartridges were picked.</p>}
      <div className="stack-list">
        {ink.map((c) => {
          const low = c.LowStockAt !== null && c.LowStockAt !== undefined && c.QuantityOnHand <= c.LowStockAt;
          return (
            <div key={c.Id} className="stack-row">
              <span className="grow">
                {c.Name} {c.Color}
                {tech && <span className={low || !c.QuantityOnHand ? "warn" : "muted"}> · {c.QuantityOnHand} in stock</span>}
                {c.TakenAt && <span className="muted small"> · taken by {c.TakenByName}, {formatDate(c.TakenAt)}</span>}
              </span>
              {tech && !c.TakenAt && (
                <button type="button" className="btn sm" disabled={!c.QuantityOnHand} title={c.QuantityOnHand ? "" : "None in stock"}
                  onClick={() => run(api.takeInk(ticket.Id, c.Id))}>{c.QuantityOnHand ? "Take 1" : "Out of stock"}</button>
              )}
              {tech && c.TakenAt && <button type="button" className="link small" onClick={() => run(api.undoTakeInk(ticket.Id, c.Id))}>Undo</button>}
            </div>
          );
        })}
      </div>
      {tech && ink.length > 0 && (
        <p style={{ marginBottom: 0 }}>
          <button type="button" className="link" onClick={() => navigate(`/inventory?tab=ink&highlight=${ink.map((c) => c.InkCartridgeId).join(",")}`)}>
            Open in Inventory
          </button>
        </p>
      )}
    </div>
  );
}
