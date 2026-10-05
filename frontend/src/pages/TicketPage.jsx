import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, dayValue, formatDate, formatDay, formatWallRange, money } from "../api.js";
import { useApp } from "../App.jsx";
import PersonPicker from "../components/PersonPicker.jsx";

export default function TicketPage() {
  const { id } = useParams();
  const { me } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.ticket(id).then(setData).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { ticket } = data;

  const isTech = me.IsTechnician;
  return (
    <div className="split">
      <div>
        <div className="card">
          <div className="muted small">
            #{ticket.Number} · {ticket.TicketTypeName}{ticket.CategoryName ? ` · ${ticket.CategoryName}` : ""}
            {ticket.LegacyId ? ` · imported ${ticket.LegacyId}` : ""}
          </div>
          <h1 style={{ margin: "4px 0 6px" }}>{ticket.Subject}</h1>
          <div className="row center" style={{ gap: 8, marginBottom: 12 }}>
            <span className="pill" style={{ background: ticket.StatusColor || undefined }}>{ticket.StatusName}</span>
            <span className="muted small">
              {ticket.RequesterName} ({ticket.RequesterEmail}) · {formatDate(ticket.CreatedAt)} · via {ticket.SourceName}
            </span>
          </div>
          <div className="body">{ticket.Description}</div>
          <Files attachments={data.attachments.filter((a) => !a.ConversationId)} />
          {data.cc.length > 0 && <p className="muted small">CC: {data.cc.join(", ")}</p>}
        </div>

        {data.conversations.map((c) => (
          <div key={c.Id} className={`card message ${c.IsTechnicianNote ? "note" : c.Direction === "out" ? "out" : ""}`}>
            <div className="meta">
              <strong>{c.AuthorName}</strong> · {formatDate(c.CreatedAt)}
              {c.IsTechnicianNote && " · Internal note (the requester can't see this)"}
            </div>
            <div className="body">{c.Body}</div>
            <Files attachments={data.attachments.filter((a) => a.ConversationId === c.Id)} />
          </div>
        ))}

        <ReplyBox ticket={ticket} onSaved={load} />
      </div>

      <aside>
        {isTech ? <TechnicianPanel ticket={ticket} onSaved={load} /> : <RequesterPanel ticket={ticket} />}
        {data.booking && (
          <div className="card">
            <h3>Event booking</h3>
            <p style={{ margin: 0 }}><Link to={`/events/${data.booking.Id}`}>{data.booking.Title}</Link></p>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {data.booking.RoomName} · {formatWallRange(data.booking.StartAt.slice(0, 16), data.booking.EndAt.slice(0, 16))} · {data.booking.StatusName}
            </p>
          </div>
        )}
        {(ticket.UsesInventory || data.items.length > 0) && <ItemsPanel ticket={ticket} items={data.items} onSaved={load} />}
        {(data.checklist.length > 0 || (isTech && ticket.UsesChecklist)) && (
          <ChecklistPanel ticket={ticket} checklist={data.checklist} onSaved={load} />
        )}
        {isTech && data.events.length > 0 && (
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

function ReplyBox({ ticket, onSaved }) {
  const { me, lookups, notify } = useApp();
  const [body, setBody] = useState("");
  const [isNote, setIsNote] = useState(false);
  const [statusId, setStatusId] = useState("");
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fileKey, setFileKey] = useState(0);

  if (ticket.IsClosed && !me.IsTechnician) {
    return <div className="card"><p className="muted" style={{ margin: 0 }}>This ticket is closed. If you still need help, please submit a new request.</p></div>;
  }

  async function send(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api.addConversation(ticket.Id, { body, isTechnicianNote: isNote, statusId: statusId || undefined }, files);
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

  return (
    <form className={`card form ${isNote ? "note" : ""}`} onSubmit={send}>
      {me.IsTechnician && (
        <div className="composer-tabs">
          <button type="button" className={`btn sm ${!isNote ? "on" : ""}`} onClick={() => setIsNote(false)}>Public reply</button>
          <button type="button" className={`btn sm ${isNote ? "on" : ""}`} onClick={() => setIsNote(true)}>Internal note</button>
        </div>
      )}
      <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} aria-label={isNote ? "Internal note" : "Reply"}
        placeholder={isNote ? "Internal note, only technicians see this" : me.IsTechnician ? "Write a reply to the requester" : "Write a reply"} />
      <input key={fileKey} type="file" multiple onChange={(e) => setFiles([...e.target.files])} aria-label="Attach files" />
      {me.IsTechnician && (
        <label>
          Then set status to
          <select value={statusId} onChange={(e) => setStatusId(e.target.value)}>
            <option value="">{isNote ? "Leave as is" : "Awaiting User Response (default)"}</option>
            {lookups.statuses.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
          </select>
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <div>
        <button className="btn pri" disabled={saving || (!body.trim() && !files.length)}>
          {saving ? "Sending…" : isNote ? "Add note" : "Send reply"}
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

  function close() {
    const held = lookups.defaults.emailSwitch === "On"
      ? "The survey goes to the requester."
      : "The survey email is held while outgoing email is off.";
    save({ statusId: lookups.defaults.closedStatusId }, `Ticket ${ticket.Number} closed. ${held}`);
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
      {select("Status", "statusId", lookups.statuses, ticket.StatusId)}
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
      {(ticket.UsesDates || ticket.StartDate || ticket.EndDate) && (
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
      {!ticket.IsClosed && <button type="button" className="btn pri block" onClick={close}>Move to closure</button>}
      {ticket.ClosedAt && <p className="muted small">Closed {formatDate(ticket.ClosedAt)}</p>}
    </div>
  );
}

function ItemsPanel({ ticket, items, onSaved }) {
  const { me, lookups } = useApp();
  const [adding, setAdding] = useState({ inventoryItemId: "", quantity: 1 });
  const total = items.reduce((sum, i) => sum + Number(i.TotalCost), 0);

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
          <thead><tr><th>Item</th><th>Qty</th><th>Cost</th>{me.IsTechnician && <th>Out</th>}{me.IsTechnician && <th>Back</th>}</tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.Id}>
                <td>{i.Name}</td>
                <td>{i.Quantity}</td>
                <td>{money(i.TotalCost)}</td>
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
      {total > 0 && <p className="muted">Total (tracking only): {money(total)}</p>}
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

function ChecklistPanel({ ticket, checklist, onSaved }) {
  const { me, lookups } = useApp();
  const [adding, setAdding] = useState("");
  const [holdings, setHoldings] = useState(null);
  const personId = ticket.ForUserId || (ticket.ForPersonName ? null : ticket.RequesterId);

  useEffect(() => {
    if (!me.IsTechnician || !personId) return setHoldings(null);
    api.holdings(personId).then(setHoldings).catch(() => setHoldings(null));
  }, [me.IsTechnician, personId, checklist.length]);

  // The picker's value says what kind of line it is: item:, software:,
  // seat: or held: followed by the id.
  async function addLine() {
    const [kind, id] = adding.split(":");
    const body = { item: { inventoryItemId: Number(id), quantity: 1 }, software: { softwareId: Number(id) }, seat: { seatId: Number(id) }, held: { ticketItemId: Number(id) } }[kind];
    try {
      await api.addChecklistLine(ticket.Id, body);
      setAdding("");
      onSaved();
    } catch (err) {
      alert(err.message);
    }
  }
  async function toggle(item, isDone) {
    try {
      await api.updateChecklist(ticket.Id, item.Id, isDone);
      onSaved();
    } catch (err) {
      alert(err.message);
    }
  }
  const done = checklist.filter((c) => c.IsDone).length;
  return (
    <div className="card">
      <h3>Checklist ({done} of {checklist.length})</h3>
      {ticket.ChecklistSource === "offboarding" && <p className="muted small">Closing this ticket turns the person's account off.</p>}
      {ticket.ChecklistSource === "onboarding" && ticket.ForUserId && <p className="muted small">Closing this ticket turns the person's account on.</p>}
      {checklist.map((c) => (
        <label key={c.Id} className="check">
          <input type="checkbox" checked={c.IsDone} disabled={!me.IsTechnician} onChange={(e) => toggle(c, e.target.checked)} />
          <span>
            {c.Label}
            {c.IsDone && <span className="muted"> · {c.DoneByName}, {formatDate(c.DoneAt)}</span>}
          </span>
        </label>
      ))}
      {me.IsTechnician && ticket.UsesChecklist && (
        <div className="row">
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a line</option>
            <optgroup label="Hand out to keep">
              {lookups.inventoryItems.map((i) => <option key={`i${i.Id}`} value={`item:${i.Id}`}>{i.Name}</option>)}
            </optgroup>
            <optgroup label="Grant a license">
              {lookups.software.map((s) => <option key={`s${s.Id}`} value={`software:${s.Id}`}>{s.Name}</option>)}
            </optgroup>
            {holdings && (holdings.items.length > 0 || holdings.seats.length > 0) && (
              <optgroup label="Take back from them">
                {holdings.items.map((i) => <option key={`h${i.Id}`} value={`held:${i.Id}`}>Collect: {i.Name}{i.Quantity > 1 ? ` (x${i.Quantity})` : ""}</option>)}
                {holdings.seats.map((s) => <option key={`r${s.Id}`} value={`seat:${s.Id}`}>Remove license: {s.Name}</option>)}
              </optgroup>
            )}
          </select>
          <button type="button" className="btn sm" disabled={!adding} onClick={addLine}>Add</button>
        </div>
      )}
    </div>
  );
}
