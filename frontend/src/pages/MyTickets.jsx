import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import TicketTable from "../components/TicketTable.jsx";

// The requester's own tickets (asked for by them, or for them).
export default function MyTickets() {
  const [state, setState] = useState("open");
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setTickets(null);
    api.tickets({ scope: "mine", state }).then(setTickets).catch((e) => setError(e.message));
  }, [state]);

  return (
    <div className="card">
      <div className="row spread">
        <h1>My tickets</h1>
        <Link className="button primary" to="/new">Submit a request</Link>
      </div>
      <div className="tabs">
        <button className={state === "open" ? "active" : ""} onClick={() => setState("open")}>Active</button>
        <button className={state === "closed" ? "active" : ""} onClick={() => setState("closed")}>Closed</button>
      </div>
      {error && <p className="error">{error}</p>}
      {tickets ? <TicketTable tickets={tickets} /> : <p className="muted">Loading…</p>}
    </div>
  );
}
