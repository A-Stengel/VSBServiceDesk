import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import ItemsPicker from "./ItemsPicker.jsx";

export const emptyBooking = {
  title: "",
  startAt: "",
  endAt: "",
  roomId: "",
  attendeeCount: "",
  refreshments: false,
  foia: false,
  lunchCatered: false,
  comments: "",
  items: []
};

// The event booking form, matching the Power App's Event Booking form. Used
// to book and to change a booking. "canChangeItems" is false for Event
// Managers, who handle the room but not the equipment.
export default function BookingForm({ initial, submitLabel, onSubmit, onCancel, canChangeItems = true, excludeTicketId }) {
  const { lookups } = useApp();
  const [form, setForm] = useState(initial || emptyBooking);
  const [available, setAvailable] = useState(null);
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  // Free counts for the event's dates, to warn about double-booking equipment
  const startDay = form.startAt.slice(0, 10);
  const endDay = form.endAt.slice(0, 10);
  useEffect(() => {
    if (!canChangeItems || !startDay) return setAvailable(null);
    api.availability({ startDate: startDay, endDate: endDay || startDay, excludeTicketId })
      .then(setAvailable).catch(() => setAvailable(null));
  }, [canChangeItems, startDay, endDay, excludeTicketId]);

  // A retired room stays on a booking that already has it
  const rooms = lookups.rooms.some((r) => r.Id === Number(form.roomId)) || !initial?.roomName
    ? lookups.rooms
    : [...lookups.rooms, { Id: Number(form.roomId), Name: initial.roomName }];

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (form.endAt && form.startAt && form.endAt <= form.startAt) {
      setError("The end time must be after the start time.");
      return;
    }
    setSaving(true);
    try {
      const data = { ...form, roomId: Number(form.roomId), attendeeCount: Number(form.attendeeCount) };
      if (!canChangeItems) delete data.items;
      await onSubmit(data);
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  const toggle = (key, label) => (
    <label className="check">
      <input type="checkbox" checked={form[key]} onChange={set(key)} />
      {label} <strong>{form[key] ? "Yes" : "No"}</strong>
    </label>
  );

  return (
    <form className="form" onSubmit={submit}>
      <div className="row spread">
        <span className="muted">Fields marked * are required.</span>
        <button type="button" onClick={() => setShowGuidelines(true)}>Guidelines</button>
      </div>

      <label>
        Title *
        <input value={form.title} onChange={set("title")} maxLength={255} placeholder="Event title to be displayed" required />
      </label>

      <div className="row">
        <label>
          Start Time *
          <input type="datetime-local" value={form.startAt} onChange={set("startAt")} required />
        </label>
        <label>
          End Time *
          <input type="datetime-local" value={form.endAt} min={form.startAt || undefined} onChange={set("endAt")} required />
        </label>
      </div>

      <div className="row">
        <label className="grow">
          Location *
          <select value={form.roomId} onChange={set("roomId")} required>
            <option value="">Select room</option>
            {rooms.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
          </select>
        </label>
        <label>
          Attendee Count *
          <input type="number" min="0" max="10000" value={form.attendeeCount} onChange={set("attendeeCount")}
            placeholder="Expected number of attendees" required />
        </label>
      </div>
      {!lookups.rooms.length && <p className="muted">No rooms are set up yet. An event manager adds them on the Event bookings page.</p>}

      <fieldset>
        <legend>Refreshments, FOIA and lunch *</legend>
        {toggle("refreshments", "Refreshments")}
        {toggle("foia", "FOIA")}
        {toggle("lunchCatered", "Will Lunch Be Catered?")}
      </fieldset>

      <fieldset>
        <legend>Items to Checkout</legend>
        {canChangeItems ? (
          <>
            <ItemsPicker inventory={lookups.inventoryItems} value={form.items} onChange={(items) => setForm({ ...form, items })} available={available} />
            <p className="muted">Picking any equipment sends a request to IT, linked to this booking.</p>
          </>
        ) : (
          <p className="muted">Only the person who booked it or IT can change the equipment.</p>
        )}
      </fieldset>

      <label>
        User Comments
        <textarea rows={4} value={form.comments} onChange={set("comments")} maxLength={4000} placeholder="Notes for HR or IT" />
      </label>

      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="primary" disabled={saving}>{saving ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>

      {showGuidelines && (
        <div className="dialog-backdrop" onClick={() => setShowGuidelines(false)}>
          <div className="card dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Guidelines</h2>
            <div className="body">{lookups.eventGuidelines || "No guidelines have been written yet."}</div>
            <button type="button" onClick={() => setShowGuidelines(false)}>Close</button>
          </div>
        </div>
      )}
    </form>
  );
}
