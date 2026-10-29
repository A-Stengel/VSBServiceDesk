import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useApp } from "../App.jsx";
import BookingForm from "../components/BookingForm.jsx";
import RichText from "../components/RichText.jsx";
import { withPastedImages } from "../richtext.js";

// Equipment Rental / Event Booking: one form, one ticket, for a room,
// equipment, or both. HR confirms the room; IT handles the equipment.
export default function BookEvent() {
  const navigate = useNavigate();
  const { lookups, notify } = useApp();

  async function submit(fields) {
    const { data, files } = withPastedImages(fields, "comments");
    const result = await api.createBooking(data, files);
    const next = data.roomId ? "HR will confirm the room." : "IT will be in touch about the equipment.";
    notify([`Request ${result.ticket.Number} sent. ${next}`, ...(result.warnings || [])].join(" "));
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
          <RichText value={lookups.eventGuidelines} className="small" empty={<p className="muted small">No guidelines have been written yet.</p>} />
        </div>
      </aside>
    </div>
  );
}
