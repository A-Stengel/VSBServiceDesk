import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import BookingTable from "../components/BookingTable.jsx";

// The Event Managers' page (HR): every booking, the room list and the
// guidelines shown on the booking form.
export default function EventBookings() {
  const [tab, setTab] = useState("bookings");
  return (
    <div className="card">
      <div className="row spread">
        <h1>Event bookings</h1>
        <Link className="button primary" to="/events/new">Book an event</Link>
      </div>
      <div className="tabs">
        <button className={tab === "bookings" ? "active" : ""} onClick={() => setTab("bookings")}>Bookings</button>
        <button className={tab === "rooms" ? "active" : ""} onClick={() => setTab("rooms")}>Rooms</button>
        <button className={tab === "guidelines" ? "active" : ""} onClick={() => setTab("guidelines")}>Guidelines</button>
      </div>
      {tab === "bookings" && <Bookings />}
      {tab === "rooms" && <Rooms />}
      {tab === "guidelines" && <Guidelines />}
    </div>
  );
}

function Bookings() {
  const { lookups } = useApp();
  const [filters, setFilters] = useState({ when: "upcoming", statusId: "", roomId: "" });
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState("");
  const set = (key) => (e) => setFilters({ ...filters, [key]: e.target.value });

  useEffect(() => {
    api.bookings({ scope: "all", ...filters }).then(setBookings).catch((e) => setError(e.message));
  }, [filters]);

  return (
    <>
      <div className="filters">
        <select value={filters.when} onChange={set("when")}>
          <option value="upcoming">Upcoming</option>
          <option value="past">Past</option>
          <option value="all">All</option>
        </select>
        <select value={filters.statusId} onChange={set("statusId")}>
          <option value="">Any status</option>
          {lookups.bookingStatuses.map((s) => <option key={s.Id} value={s.Id}>{s.Name}</option>)}
        </select>
        <select value={filters.roomId} onChange={set("roomId")}>
          <option value="">Any room</option>
          {lookups.rooms.map((r) => <option key={r.Id} value={r.Id}>{r.Name}</option>)}
        </select>
      </div>
      <p className="muted">Pending bookings are listed first. "Room overlap" means another active booking has the same room at the same time. It's only a hint, so check before confirming.</p>
      {error && <p className="error">{error}</p>}
      {bookings ? <BookingTable bookings={bookings} manage /> : <p className="muted">Loading…</p>}
    </>
  );
}

function Rooms() {
  const { reloadLookups } = useApp();
  const [rooms, setRooms] = useState(null);
  const [edits, setEdits] = useState({});
  const [newRoom, setNewRoom] = useState({ name: "", sortOrder: "" });
  const [error, setError] = useState("");

  const load = () => api.rooms().then((r) => {
    setRooms(r);
    setEdits({});
  }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const valueOf = (room) => ({ name: room.Name, sortOrder: room.SortOrder, isActive: room.IsActive, ...(edits[room.Id] || {}) });
  const change = (room, key, value) => setEdits({ ...edits, [room.Id]: { ...(edits[room.Id] || {}), [key]: value } });

  async function save(promise) {
    try {
      await promise;
      await reloadLookups();
      setNewRoom({ name: "", sortOrder: "" });
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!rooms) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="muted">Rooms can't be deleted, because old bookings point at them. Untick Active to stop people booking one.</p>
      <table className="grid compact">
        <thead><tr><th>Room</th><th>Sort order</th><th>Active</th><th /></tr></thead>
        <tbody>
          {rooms.map((room) => {
            const v = valueOf(room);
            return (
              <tr key={room.Id}>
                <td><input value={v.name} maxLength={100} onChange={(e) => change(room, "name", e.target.value)} /></td>
                <td><input type="number" className="qty" value={v.sortOrder} onChange={(e) => change(room, "sortOrder", e.target.value)} /></td>
                <td><input type="checkbox" checked={!!v.isActive} onChange={(e) => change(room, "isActive", e.target.checked)} /></td>
                <td>{edits[room.Id] && <button onClick={() => save(api.updateRoom(room.Id, edits[room.Id]))}>Save</button>}</td>
              </tr>
            );
          })}
          <tr className="new-row">
            <td><input value={newRoom.name} maxLength={100} placeholder="New room name" onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })} /></td>
            <td><input type="number" className="qty" value={newRoom.sortOrder} onChange={(e) => setNewRoom({ ...newRoom, sortOrder: e.target.value })} /></td>
            <td />
            <td><button disabled={!newRoom.name.trim()} onClick={() => save(api.createRoom(newRoom))}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function Guidelines() {
  const { lookups, reloadLookups } = useApp();
  const [text, setText] = useState(lookups.eventGuidelines || "");

  async function save() {
    try {
      await api.saveGuidelines(text);
      await reloadLookups();
      alert("Saved");
    } catch (err) {
      alert(err.message);
    }
  }

  return (
    <div className="form">
      <p className="muted">People see this when they click Guidelines on the booking form.</p>
      <textarea rows={12} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
      <button className="primary" onClick={save}>Save guidelines</button>
    </div>
  );
}
