import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import BookingForm from "../components/BookingForm.jsx";

// Book a conference room, and any equipment for it, in one go.
export default function BookEvent() {
  const navigate = useNavigate();

  async function submit(data) {
    const result = await api.createBooking(data);
    if (result.warnings?.length) alert(`Booking saved. Please note:\n${result.warnings.join("\n")}`);
    navigate(`/events/${result.booking.Id}`);
  }

  return (
    <div className="card">
      <h1>Book an event</h1>
      <p className="muted">HR confirms the room. Any equipment you pick goes to IT as a request linked to this booking.</p>
      <BookingForm submitLabel="Submit" onSubmit={submit} />
    </div>
  );
}
