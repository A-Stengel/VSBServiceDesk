import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatDate, formatWallRange } from "../api.js";
import { useApp } from "../App.jsx";
import BookingForm from "../components/BookingForm.jsx";

// One rental or event record. The room part is HR's: Event Managers (and
// admins) confirm or decline it here. The equipment part is IT's:
// technicians check it out to the requester and mark it returned. Event
// Managers see no equipment information. The requester can change or cancel
// it while it's active.
export default function BookingPage() {
  const { id } = useParams();
  const { me, roles, lookups, notify } = useApp();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.booking(id).then(setData).catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const { booking, items, events, canChangeItems } = data;
  const active = booking.IsActiveBooking;
  const pending = booking.BookingStatusId === lookups.defaults.bookingPendingStatusId;
  const confirmed = booking.BookingStatusId === lookups.defaults.bookingConfirmedStatusId;
  const canDecide = roles.eventManagerOnly || roles.admin;
  const isRequester = booking.RequesterId === me.Id;
  const stage = (s) => lookups.equipmentStatuses?.find((x) => x.Stage === s)?.Name || s;
  const equipmentStage = !items.length ? null
    : items.some((i) => i.OutAt && !i.ReturnedAt) ? "out"
    : items.every((i) => i.ReturnedAt) ? "returned" : "requested";

  async function act(action, ask, message) {
    let reason;
    if (ask) {
      reason = prompt(ask);
      if (reason === null) return;
    }
    try {
      await api.bookingAction(booking.Id, action, reason || undefined);
      notify(message);
      load();
    } catch (err) {
      notify(err.message, true);
    }
  }

  async function equipment(change, message) {
    try {
      for (const item of items) {
        if (change === "out" && !item.OutAt) await api.updateItem(booking.TicketId, item.Id, { out: true });
        if (change === "returned" && !item.ReturnedAt) await api.updateItem(booking.TicketId, item.Id, { out: true, returned: true });
      }
      notify(message);
      load();
    } catch (err) {
      notify(err.message, true);
    }
  }

  async function save(changes) {
    const result = await api.updateBooking(booking.Id, changes);
    notify(["Changes saved.", ...(result.warnings || [])].join(" "));
    setEditing(false);
    load();
  }

  const facts = [
    ["When", formatWallRange(booking.StartAt, booking.EndAt)],
    ["Room", booking.RoomName],
    ["Attendee count", booking.AttendeeCount],
    ["Refreshments", booking.Refreshments ? "Yes" : "No"],
    ["FOIA", booking.Foia ? "Yes" : "No"],
    ["Lunch catered", booking.LunchCatered ? "Yes" : "No"],
    ["Requested by", `${booking.RequesterName} (${booking.RequesterEmail})`],
    ["Requested", formatDate(booking.CreatedAt)]
  ];

  return (
    <div className="split">
      <div>
        <div className="card">
          <div className="muted small">{roles.eventManagerOnly ? "Event booking" : "Rental / event"}</div>
          <h1 style={{ margin: "4px 0 10px" }}>{booking.Title}</h1>
          {booking.HasOverlap && (
            <p className="flag">Another active booking has {booking.RoomName} at an overlapping time. Check before confirming.</p>
          )}
          {editing ? (
            <BookingForm
              initial={{
                title: booking.Title,
                startAt: booking.StartAt,
                endAt: booking.EndAt,
                roomId: String(booking.RoomId),
                roomName: booking.RoomName,
                attendeeCount: String(booking.AttendeeCount),
                refreshments: booking.Refreshments,
                foia: booking.Foia,
                lunchCatered: booking.LunchCatered,
                comments: booking.Comments || "",
                items: items.map((i) => ({ inventoryItemId: i.InventoryItemId, quantity: i.Quantity }))
              }}
              canChangeItems={canChangeItems}
              excludeTicketId={booking.TicketId || undefined}
              submitLabel="Save changes"
              onSubmit={save}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              <dl className="facts">
                {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
              </dl>
              {booking.Comments && (
                <>
                  <h3 style={{ marginTop: 14 }}>Comments</h3>
                  <div className="body">{booking.Comments}</div>
                </>
              )}
              {active && (isRequester || roles.worker) && (
                <div className="row" style={{ marginTop: 14 }}>
                  <button className="btn sm" onClick={() => setEditing(true)}>Change</button>
                  <button className="btn sm danger" onClick={() => act("cancel", "Cancel this request? Add a reason if you like.", "Request cancelled.")}>Cancel request</button>
                </div>
              )}
              {!active && <p className="muted small">This request is {booking.StatusName.toLowerCase()}, so it can&apos;t be changed.</p>}
            </>
          )}
        </div>

        <div className="card">
          <h3>History</h3>
          {!events.length && <p className="muted small">Nothing yet.</p>}
          <ul className="history">
            {[...events].reverse().map((e) => (
              <li key={e.Id}>
                <span className="muted small">{formatDate(e.At)} · {e.ActorName || "System"}</span>
                <br />
                {e.Field === "Booked" ? "Submitted" : e.Field}{e.OldValue || e.NewValue ? ": " : ""}
                {e.OldValue && <s>{e.OldValue}</s>}{e.OldValue && e.NewValue ? " → " : ""}{e.NewValue}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <aside>
        <div className="card">
          <h3>Room</h3>
          <p style={{ margin: "0 0 10px" }}>
            {booking.RoomName} <span className="pill" style={{ background: booking.StatusColor || undefined }}>{booking.StatusName}</span>
          </p>
          {booking.ConfirmedByName && <p className="muted small">Confirmed by {booking.ConfirmedByName}, {formatDate(booking.ConfirmedAt)}</p>}
          {active && canDecide && (
            <div className="row">
              {pending && <button className="btn pri sm" onClick={() => act("confirm", null, "Room confirmed.")}>Confirm</button>}
              {(pending || confirmed) && (
                <button className="btn sm" onClick={() => act("decline", "Why is it declined? (optional, the requester sees this)", "Room declined.")}>Decline</button>
              )}
            </div>
          )}
          {active && !canDecide && pending && <p className="muted small">Only HR can confirm or decline the room.</p>}
        </div>

        {canChangeItems && (
          <div className="card">
            <h3>Equipment</h3>
            {!items.length && <p className="muted small">No equipment on this request.</p>}
            {items.length > 0 && (
              <>
                <p style={{ margin: "0 0 8px" }}><span className="pill">{stage(equipmentStage)}</span></p>
                <ul className="history">
                  {items.map((i) => (
                    <li key={i.Id}>
                      {i.Name}{i.Quantity > 1 ? ` x${i.Quantity}` : ""}
                      <span className="muted small"> · {i.ReturnedAt ? stage("returned") : i.OutAt ? stage("out") : stage("requested")}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {roles.technician && items.length > 0 && (
              <div className="row" style={{ marginTop: 10 }}>
                {equipmentStage === "requested" && (
                  <button className="btn pri sm" onClick={() => equipment("out", "Equipment checked out to the requester.")}>Check out to requester</button>
                )}
                {equipmentStage === "out" && (
                  <button className="btn pri sm" onClick={() => equipment("returned", "Equipment marked returned.")}>Mark returned</button>
                )}
              </div>
            )}
            {booking.TicketId && (
              <p className="muted small">
                IT ticket {roles.technician ? <Link to={`/tickets/${booking.TicketId}`}>#{booking.TicketNumber}</Link> : `#${booking.TicketNumber}`}
                {" "}({booking.TicketStatusName})
              </p>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
