import { useEffect, useState } from "react";
import { api, formatDate, money } from "../api.js";

// Seats in use and what they cost (tracking only).
export default function Licenses() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.licenses().then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="card">
      <h1>Licenses</h1>
      <p>Total spend: <strong>{money(data.totals.monthly)}</strong> a month, {money(data.totals.yearly)} a year.</p>
      <table className="grid">
        <thead><tr><th>Software</th><th>Cost per seat</th><th>Billed</th><th>Seats used</th><th>Seats bought</th><th>Monthly cost</th></tr></thead>
        <tbody>
          {data.software.map((s) => (
            <tr key={s.Id}>
              <td>{s.Name}</td>
              <td>{money(s.CostPerSeat)}</td>
              <td>{s.BillingPeriodName}</td>
              <td className={s.SeatsPurchased && s.SeatsUsed > s.SeatsPurchased ? "error" : ""}>{s.SeatsUsed}</td>
              <td>{s.SeatsPurchased}</td>
              <td>{money(s.MonthlyCost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Who has what</h2>
      <table className="grid">
        <thead><tr><th>Person</th><th>Software</th><th>Since</th></tr></thead>
        <tbody>
          {data.seats.map((seat) => (
            <tr key={seat.Id}>
              <td>{seat.UserName}</td>
              <td>{data.software.find((s) => s.Id === seat.SoftwareId)?.Name}</td>
              <td>{formatDate(seat.AssignedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
