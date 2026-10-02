import { Link } from "react-router-dom";
import { formatDate } from "../api.js";

// The ticket list, with the same columns as the current desk.
export default function TicketTable({ tickets, showAssignee = true }) {
  if (!tickets.length) return <p className="muted">No tickets here.</p>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>#</th>
          <th>Title</th>
          <th>Type</th>
          {showAssignee && <th>Assigned To</th>}
          <th>Category</th>
          <th>Requester</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Created</th>
          <th>Department</th>
        </tr>
      </thead>
      <tbody>
        {tickets.map((t) => (
          <tr key={t.Id} style={{ background: t.StatusColor || undefined }}>
            <td><Link to={`/tickets/${t.Id}`}>{t.Number}</Link></td>
            <td><Link to={`/tickets/${t.Id}`}>{t.Subject}</Link></td>
            <td>{t.TicketTypeName}</td>
            {showAssignee && <td>{t.TechnicianName || <span className="muted">Unassigned</span>}</td>}
            <td>{[t.CategoryName, t.SubcategoryName].filter(Boolean).join(" / ")}</td>
            <td>{t.RequesterName}</td>
            <td>{t.StatusName}</td>
            <td>{t.PriorityName}</td>
            <td>{formatDate(t.CreatedAt)}</td>
            <td>{t.DepartmentName}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
