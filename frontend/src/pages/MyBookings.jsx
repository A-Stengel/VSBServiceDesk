import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import BookingTable from "../components/BookingTable.jsx";

// The signed-in person's own event bookings.
export default function MyBookings() {
  const [when, setWhen] = useState("upcoming");
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setBookings(null);
    api.bookings({ scope: "mine", when }).then(setBookings).catch((e) => setError(e.message));
  }, [when]);

  return (
    <div className="card">
      <div className="row spread">
        <h1>My bookings</h1>
        <Link className="button primary" to="/events/new">Book an event</Link>
      </div>
      <div className="tabs">
        <button className={when === "upcoming" ? "active" : ""} onClick={() => setWhen("upcoming")}>Upcoming</button>
        <button className={when === "past" ? "active" : ""} onClick={() => setWhen("past")}>Past</button>
      </div>
      {error && <p className="error">{error}</p>}
      {bookings ? <BookingTable bookings={bookings} /> : <p className="muted">Loading…</p>}
    </div>
  );
}
