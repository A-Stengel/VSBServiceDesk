import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, formatDate } from "../api.js";
import { useApp } from "../App.jsx";

// Email waiting for a technician: mail from people the desk doesn't know yet
// (while "Create accounts for new senders" is off) and mail that couldn't be
// handled. Accept makes the sender's account and turns the email into a
// ticket (or a reply on its ticket); Dismiss leaves it in the mailbox only.
export function HeldMailList({ onChange }) {
  const { notify } = useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(0);

  const load = useCallback(() => {
    api.heldMail().then(setRows).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function act(row, accept) {
    setBusy(row.Id);
    try {
      if (accept) {
        const result = await api.acceptHeldMail(row.Id);
        notify(result.ticketId ? `Email from ${row.FromEmail} added to ticket ${String(result.ticketId).padStart(7, "0")}.` : `Email from ${row.FromEmail}: ${result.outcome}.`);
        if (result.ticketId) navigate(`/tickets/${result.ticketId}`);
      } else {
        await api.dismissHeldMail(row.Id);
        notify("Email dismissed. It stays in the mailbox.");
      }
      load();
      onChange?.();
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(0);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!rows) return <p className="muted">Loading…</p>;
  if (!rows.length) return <p className="empty">No held mail.</p>;
  return (
    <div className="card flush scroll">
      <table className="tbl" style={{ minWidth: 760 }}>
        <thead><tr><th>From</th><th>Subject</th><th>Received</th><th>Why it's here</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.Id}>
              <td>{r.FromName || r.FromEmail}<div className="muted small">{r.FromEmail}</div></td>
              <td>{r.Subject || "(no subject)"}<div className="muted small">{(r.Preview || "").slice(0, 140)}</div></td>
              <td className="small">{formatDate(r.ReceivedAt)}</td>
              <td className="small">
                {r.Outcome === "failed" ? <span className="warn">Couldn't be handled: {r.Detail}</span> : r.Detail}
                {r.TicketNumber && <div><Link className="link" to={`/tickets/${r.TicketId}`}>#{r.TicketNumber}</Link></div>}
              </td>
              <td>
                <div className="row" style={{ flexWrap: "nowrap" }}>
                  <button className="btn pri sm" disabled={!!busy} onClick={() => act(r, true)}>{r.Outcome === "failed" ? "Try again" : "Accept"}</button>
                  <button className="btn sm" disabled={!!busy} onClick={() => act(r, false)}>Dismiss</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HeldMail() {
  return (
    <>
      <h1>Held mail</h1>
      <p className="muted">Email from people the desk doesn't know yet, and email that couldn't be handled. Accepting creates the sender's account.</p>
      <HeldMailList />
    </>
  );
}
