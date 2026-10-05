import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatDate, formatWallRange } from "../api.js";
import { useApp } from "../App.jsx";
import BookingForm from "../components/BookingForm.jsx";

// One event booking: its details, Confirm and Decline for Event Managers,
// Change and Cancel for the requester (and Event Managers), the equipment on
// the linked ticket, and the history.
export default function BookingPage() {
  const { id } = useParams();
  const { me, lookups } = useApp();
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

  async function act(action, ask) {
    let reason;
    if (ask) {
      reason = prompt(ask);
      if (reason === null) return;
    }
    try {
      await api.bookingAction(booking.Id, action, reason || undefined);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function save(changes) {
    const result = await api.updateBooking(booking.Id, changes);
    if (result.warnings?.length) alert(`Booking saved. Please note:\n${result.warnings.join("\n")}`);
    setEditing(false);
    load();
  }

  const facts = [
    ["Status", booking.StatusName],
    ["When", formatWallRange(booking.StartAt, booking.EndAt)],
    ["Location", booking.RoomName],
    ["Attendee Count", booking.AttendeeCount],
    ["Refreshments", booking.Refreshments ? "Yes" : "No"],
    ["FOIA", booking.Foia ? "Yes" : "No"],
    ["Will Lunch Be Catered?", booking.LunchCatered ? "Yes" : "No"],
    booking.Comments && ["User Comments", booking.Comments],
    ["Booked by", `${booking.RequesterName} (${booking.RequesterEmail})`],
    ["Booked", formatDate(booking.CreatedAt)],
    booking.ConfirmedByName && ["Confirmed by", `${booking.ConfirmedByName}, ${formatDate(booking.ConfirmedAt)}`]
  ].filter(Boolean);

  return (
    <div className="ticket">
      <div className="ticket-main">
        <div className="card">
          <p className="muted">Event booking</p>
          <h1>{booking.Title}</h1>
          {booking.HasOverlap && (
            <p className="error">Another active booking has {booking.RoomName} at an overlapping time. Check before confirming.</p>
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
              {active && (
                <div className="row">
                  {me.IsEventManager && pending && <button className="primary" onClick={() => act("confirm")}>Confirm</button>}
                  {me.IsEventManager && <button onClick={() => act("decline", "Why is it declined? (optional, the requester will see this)")}>Decline</button>}
                  <button onClick={() => setEditing(true)}>Change</button>
                  <button onClick={() => act("cancel", "Cancel this booking? Add a reason if you like.")}>Cancel booking</button>
                </div>
              )}
              {!active && <p className="muted">This booking is {booking.StatusName.toLowerCase()}, so it can't be changed.</p>}
            </>
          )}
        </div>
      </div>

      <aside className="ticket-side">
        <div className="card">
          <h3>Equipment</h3>
          {!items.length && <p className="muted">No equipment on this booking.</p>}
          {items.length > 0 && (
            <table className="grid compact">
              <thead><tr><th>Item</th><th>Qty</th><th>Status</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.Id}>
                    <td>{i.Name}</td>
                    <td>{i.Quantity}</td>
                    <td>{i.ReturnedAt ? "Returned" : i.OutAt ? "Handed out" : "Not yet handed out"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {booking.TicketId && (
            <p className="muted">
              IT ticket{" "}
              {canChangeItems ? <Link to={`/tickets/${booking.TicketId}`}>#{booking.TicketNumber}</Link> : `#${booking.TicketNumber}`}
              {" "}({booking.TicketStatusName})
            </p>
          )}
        </div>
        {events.length > 0 && (
          <div className="card">
            <h3>History</h3>
            <ul className="history">
              {events.map((e) => (
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
