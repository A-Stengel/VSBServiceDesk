import { useNavigate } from "react-router-dom";
import { api, formatWallRange } from "../api.js";
import { useApp } from "../App.jsx";
import BookingForm from "../components/BookingForm.jsx";

// Equipment Rental / Event Booking: one form for a room, equipment, or both.
// With a room it's an event booking that HR confirms (any equipment goes to
// IT on a linked ticket); without one it's an Equipment Rental ticket for IT.
export default function BookEvent() {
  const navigate = useNavigate();
  const { lookups, notify } = useApp();

  async function submit(data) {
    if (data.roomId) {
      const result = await api.createBooking(data);
      notify(["Request sent. HR will confirm the room.", ...(result.warnings || [])].join(" "));
      navigate(`/events/${result.booking.Id}`);
      return;
    }
    const details = [
      `When: ${formatWallRange(data.startAt, data.endAt)}`,
      data.comments ? `Comments: ${data.comments}` : null
    ].filter(Boolean).join("\n");
    const result = await api.createTicket({
      ticketTypeId: lookups.defaults.bookingTicketTypeId,
      subject: data.title,
      description: details,
      startDate: data.startAt.slice(0, 10),
      endDate: data.endAt.slice(0, 10),
      items: data.items
    }, []);
    notify([`Rental request ${result.ticket.Number} sent to IT.`, ...(result.warnings || [])].join(" "));
    navigate(`/tickets/${result.ticket.Id}`);
  }

  return (
    <div className="split">
      <div className="card">
        <h1>Equipment Rental / Event Booking</h1>
        <p className="muted" style={{ marginTop: 0 }}>Borrow equipment, book a room, or both. HR confirms rooms; IT handles equipment.</p>
        <BookingForm submitLabel="Submit" onSubmit={submit} roomOptional showGuidelinesButton={false} />
      </div>
      <aside>
        <div className="card">
          <h3>Guidelines</h3>
          <div className="body small">{lookups.eventGuidelines || "No guidelines have been written yet."}</div>
        </div>
      </aside>
    </div>
  );
}
