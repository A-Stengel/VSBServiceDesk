import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, dayValue, formatDate, formatDay, money } from "../api.js";
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

  return (
    <div className="ticket">
      <div className="ticket-main">
        <div className="card">
          <p className="muted">#{ticket.Number} · {ticket.TicketTypeName}{ticket.LegacyId ? ` · imported ${ticket.LegacyId}` : ""}</p>
          <h1>{ticket.Subject}</h1>
          <p className="muted">
            {ticket.RequesterName} ({ticket.RequesterEmail}) · {formatDate(ticket.CreatedAt)} · via {ticket.SourceName}
          </p>
          <div className="body">{ticket.Description}</div>
          <Files attachments={data.attachments.filter((a) => !a.ConversationId)} />
          {data.cc.length > 0 && <p className="muted">CC: {data.cc.join(", ")}</p>}
        </div>

        {data.conversations.map((c) => (
          <div key={c.Id} className={`card message ${c.IsTechnicianNote ? "note" : c.Direction === "out" ? "out" : ""}`}>
            <p className="muted">
              <strong>{c.AuthorName}</strong> · {formatDate(c.CreatedAt)}
              {c.IsTechnicianNote && " · Technician note (requester can't see this)"}
            </p>
            <div className="body">{c.Body}</div>
            <Files attachments={data.attachments.filter((a) => a.ConversationId === c.Id)} />
          </div>
        ))}

        <ReplyBox ticket={ticket} onSaved={load} />
      </div>

      <aside className="ticket-side">
        {me.IsTechnician ? <TechnicianPanel ticket={ticket} onSaved={load} /> : <RequesterPanel ticket={ticket} />}
        {(ticket.UsesInventory || data.items.length > 0) && <ItemsPanel ticket={ticket} items={data.items} onSaved={load} />}
        {data.checklist.length > 0 && <ChecklistPanel ticket={ticket} checklist={data.checklist} onSaved={load} />}
        {me.IsTechnician && data.events.length > 0 && (
          <div className="card">
            <h3>History</h3>
            <ul className="history">
              {data.events.map((e) => (
                <li key={e.Id}>
                  <span className="muted">{formatDate(e.At)} · {e.ActorName || "System"}</span>
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
  const { me, lookups } = useApp();
  const [body, setBody] = useState("");
  const [isNote, setIsNote] = useState(false);
  const [statusId, setStatusId] = useState("");
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fileKey, setFileKey] = useState(0);

  if (ticket.IsClosed && !me.IsTechnician) {
    return <div className="card"><p className="muted">This ticket is closed. If you still need help, please submit a new request.</p></div>;
  }

  async function send(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.addConversation(ticket.Id, { body, isTechnicianNote: isNote, statusId: statusId || undefined }, files);
      setBody("");
      setFiles([]);
      setStatusId("");
      setFileKey((k) => k + 1);
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
        <div className="tabs">
          <button type="button" className={!isNote ? "active" : ""} onClick={() => setIsNote(false)}>Reply</button>
          <button type="button" className={isNote ? "active" : ""} onClick={() => setIsNote(true)}>Technician note</button>
        </div>
      )}
      <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)}
        placeholder={isNote ? "Internal note, only technicians see this" : "Write a reply"} />
      <input key={fileKey} type="file" multiple onChange={(e) => setFiles([...e.target.files])} />
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
      <button className="primary" disabled={saving || (!body.trim() && !files.length)}>
        {saving ? "Sending…" : isNote ? "Add note" : "Send reply"}
      </button>
    </form>
  );
}

function RequesterPanel({ ticket }) {
  const rows = [
    ["Status", ticket.StatusName],
    ["Priority", ticket.PriorityName],
    ["Assigned To", ticket.TechnicianName || "Not yet assigned"],
    ["Category", [ticket.CategoryName, ticket.SubcategoryName].filter(Boolean).join(" / ")],
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
  const { lookups } = useApp();
  const [technicians, setTechnicians] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api.users({ technicians: 1 }).then(setTechnicians).catch(() => {});
  }, []);

  async function save(changes) {
    setError("");
    try {
      await api.updateTicket(ticket.Id, changes);
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

  return (
    <div className="card form">
      {select("Status", "statusId", lookups.statuses, ticket.StatusId)}
      {select("Assigned To", "technicianId", technicians, ticket.TechnicianId, true)}
      {select("Priority", "priorityId", lookups.priorities, ticket.PriorityId)}
      {select("Type", "ticketTypeId", lookups.ticketTypes, ticket.TicketTypeId)}
      <label>
        Category
        <select value={ticket.CategoryId ?? ""} onChange={(e) => save({ categoryId: e.target.value || null, subcategoryId: null })}>
          <option value="">None</option>
          {lookups.categories.map((c) => <option key={c.Id} value={c.Id}>{c.Name}</option>)}
        </select>
      </label>
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
      {error && <p className="error">{error}</p>}
      {!ticket.IsClosed && (
        <button type="button" className="primary" onClick={() => save({ statusId: lookups.defaults.closedStatusId })}>
          Move to Closure
        </button>
      )}
      {ticket.ClosedAt && <p className="muted">Closed {formatDate(ticket.ClosedAt)}</p>}
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
        <table className="grid compact">
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
          <button type="button" disabled={!adding.inventoryItemId}
            onClick={() => act(api.addItem(ticket.Id, { inventoryItemId: Number(adding.inventoryItemId), quantity: adding.quantity }))}>
            Add
          </button>
        </div>
      )}
    </div>
  );
}

function ChecklistPanel({ ticket, checklist, onSaved }) {
  const { me } = useApp();
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
      {checklist.map((c) => (
        <label key={c.Id} className="check">
          <input type="checkbox" checked={c.IsDone} disabled={!me.IsTechnician} onChange={(e) => toggle(c, e.target.checked)} />
          <span>
            {c.Label}
            {c.IsDone && <span className="muted"> · {c.DoneByName}, {formatDate(c.DoneAt)}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}
