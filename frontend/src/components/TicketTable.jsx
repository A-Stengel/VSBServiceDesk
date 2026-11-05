import { Link } from "react-router-dom";
import { formatDate, howLongAgo } from "../api.js";
import { SortTh } from "./ListView.jsx";

// The ticket list, with sortable headers (the list's useListView decides the
// order).
export default function TicketTable({ tickets, list, technician }) {
  if (!tickets.length) return <p className="empty">No tickets here.</p>;
  return (
    <div className="card flush scroll">
      <table className="tbl" style={{ minWidth: 1000 }}>
        <thead>
          <tr>
            <SortTh list={list} col="number">#</SortTh>
            <SortTh list={list} col="subject">Title</SortTh>
            <SortTh list={list} col="type">Type</SortTh>
            <SortTh list={list} col="assigned">Assigned to</SortTh>
            <SortTh list={list} col="requester">Requester</SortTh>
            <SortTh list={list} col="status">Status</SortTh>
            <SortTh list={list} col="priority">Priority</SortTh>
            <SortTh list={list} col="created">Created</SortTh>
            <SortTh list={list} col="activity">Last activity</SortTh>
            {technician && <SortTh list={list} col="department">Department</SortTh>}
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.Id}>
              <td><Link to={`/tickets/${t.Id}`}>{t.Number}</Link></td>
              <td>
                <Link to={`/tickets/${t.Id}`} className="link">{t.Subject}</Link>
                {t.DepartmentTag && <> <span className="pill dept-pill">{t.DepartmentTag}</span></>}
                {(t.CategoryName || t.ForUserName || t.ForPersonName) && (
                  <div className="muted small">{[t.CategoryName, t.SubcategoryName, t.ForUserName || t.ForPersonName].filter(Boolean).join(" · ")}</div>
                )}
              </td>
              <td>{t.TicketTypeName}</td>
              <td>{t.TechnicianName || <span className="muted">Unassigned</span>}</td>
              <td>{t.RequesterName}</td>
              <td><span className="pill" style={{ background: t.StatusColor || undefined }}>{t.StatusName}</span></td>
              <td>{t.PriorityName}</td>
              <td className="small">{formatDate(t.CreatedAt)}</td>
              <td className="small" title={formatDate(t.UpdatedAt)}>{howLongAgo(t.UpdatedAt)}</td>
              {technician && <td>{t.DepartmentName}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
