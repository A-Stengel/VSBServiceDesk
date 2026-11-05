import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, formatDay, formatWallRange, howLongAgo } from "../api.js";
import { useApp } from "../App.jsx";
import { ListTabs, ListToolbar, SortTh, useListView } from "../components/ListView.jsx";
import { eventList } from "../lists.js";

const day = (value) => (value ? formatDay(`${value.slice(0, 10)}T00:00:00Z`) : "");

// Rentals & Events: one row per Equipment Rental / Event Booking ticket, with
// its room part (HR) and its equipment part (IT). The list is view only; open
// the ticket to act on it.
// Event Managers see the room part only and the page is called Event
// bookings. Staff see their own requests.
export default function Rentals() {
  const { roles, lookups } = useApp();
  const [data, setData] = useState({});
  const [error, setError] = useState("");
  const scope = roles.worker ? "all" : "mine";
  const equipment = !roles.eventManagerOnly;
  const stageName = (stage) => lookups.equipmentStatuses?.find((s) => s.Stage === stage);

  const def = useMemo(() => eventList({ roles, lookups }), [roles, lookups]);
  const list = useListView(def);
  const when = list.base?.when || "upcoming";

  useEffect(() => {
    if (data[when]) return;
    api.rentals({ scope, when }).then((rows) => setData((d) => ({ ...d, [when]: rows }))).catch((e) => setError(e.message));
  }, [when, scope, data]);

  const rows = list.ready ? list.apply(data[when]) : null;
  const title = roles.eventManagerOnly ? "Event bookings" : roles.worker ? "Rentals & Events" : "My rentals & events";

  return (
    <>
      <div className="head-row">
        <h1>{title}</h1>
        <div className="row center">
          {rows && <span className="muted small">{rows.length} request{rows.length === 1 ? "" : "s"}</span>}
          <Link className="btn pri sm" to="/events/new">New rental or booking</Link>
        </div>
      </div>
      <ListTabs list={list} />
      <ListToolbar list={list} placeholder={equipment ? "Search title, room, person or equipment" : "Search title, room or person"} />
      {error && <p className="error">{error}</p>}
      {!rows && <p className="muted">Loading…</p>}
      {rows && !rows.length && <p className="empty">Nothing here.</p>}
      {rows && rows.length > 0 && (
        <div className="card flush scroll">
          <table className="tbl" style={{ minWidth: 960 }}>
            <thead>
              <tr>
                <SortTh list={list} col="title">Title</SortTh>
                <SortTh list={list} col="when">When</SortTh>
                <SortTh list={list} col="room">Room</SortTh>
                <SortTh list={list} col="roomStatus">Room status</SortTh>
                {equipment && <SortTh list={list} col="equipment">Equipment</SortTh>}
                <SortTh list={list} col="requester">Requested by</SortTh>
                <SortTh list={list} col="activity">Last activity</SortTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.Key}>
                  <td>
                    <Link className="link" to={`/tickets/${r.Id}`}>{r.Title}</Link>
                    <div className="muted small">#{r.TicketNumber}{r.IsClosed ? " · closed" : ""}</div>
                    {r.HasOverlap && <div className="warn small">Another booking has this room at the same time</div>}
                  </td>
                  <td className="small">{r.AllDay ? `${day(r.StartAt)}${r.EndAt && r.EndAt !== r.StartAt ? ` to ${day(r.EndAt)}` : ""}` : formatWallRange(r.StartAt, r.EndAt)}</td>
                  <td>{r.RoomName || <span className="muted">No room</span>}</td>
                  <td>{r.RoomStatusName ? <span className="pill" style={{ background: r.RoomStatusColor || undefined }}>{r.RoomStatusName}</span> : <span className="muted">–</span>}</td>
                  {equipment && (
                    <td>
                      {r.EquipmentStage === "none" ? <span className="muted">None</span> : (
                        <>
                          <span className="pill" style={{ background: stageName(r.EquipmentStage)?.Color || undefined }}>
                            {stageName(r.EquipmentStage)?.Name || r.EquipmentStage}
                          </span>
                          <div className="muted small">{r.Items}</div>
                        </>
                      )}
                    </td>
                  )}
                  <td>{r.RequesterName}</td>
                  <td className="small" title={formatDate(r.UpdatedAt)}>{howLongAgo(r.UpdatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
