import { Link } from "react-router-dom";
import { formatWallRange } from "../api.js";

// A list of event bookings. "manage" adds the requester and the overlap
// hint, for the Event bookings page.
export default function BookingTable({ bookings, manage = false }) {
  if (!bookings.length) return <p className="muted">No bookings here.</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Title</th>
          <th>When</th>
          <th>Location</th>
          {manage && <th>Booked by</th>}
          <th>Attendees</th>
          <th>Status</th>
          <th>Equipment</th>
          {manage && <th>Check</th>}
        </tr>
      </thead>
      <tbody>
        {bookings.map((b) => (
          <tr key={b.Id} style={{ background: b.StatusColor || undefined }}>
            <td><Link to={`/events/${b.Id}`}>{b.Title}</Link></td>
            <td>{formatWallRange(b.StartAt, b.EndAt)}</td>
            <td>{b.RoomName}</td>
            {manage && <td>{b.RequesterName}</td>}
            <td>{b.AttendeeCount}</td>
            <td>{b.StatusName}</td>
            <td>{b.TicketId ? `Ticket #${b.TicketNumber}` : <span className="muted">None</span>}</td>
            {manage && <td>{b.HasOverlap && <span className="error" title="Another booking has this room at the same time">Room overlap</span>}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
