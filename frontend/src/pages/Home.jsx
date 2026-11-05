import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, timeAgo } from "../api.js";
import { useApp } from "../App.jsx";
import Icon from "../components/Icon.jsx";

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function Quick({ to, icon, title, desc }) {
  return (
    <Link className="qc" to={to}>
      <span className="qi"><Icon name={icon} /></span>
      <span className="qt"><strong>{title}</strong><span className="qd">{desc}</span></span>
    </Link>
  );
}

function Tiles({ tiles }) {
  return (
    <div className="tiles">
      {tiles.map((t) => (
        <Link key={t.label} className="tile" to={t.to}>
          <span className="n" style={t.warn && t.n > 0 ? { color: "var(--warn)" } : undefined}>{t.n ?? "–"}</span>
          <span className="lbl">{t.label}</span>
        </Link>
      ))}
    </div>
  );
}

// The home page. Technicians, admins and event managers get Go to and
// Manage requests at the top; everyone gets the Create new buttons and the
// five latest things that happened.
export default function Home() {
  const { me, roles } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.home().then(setData).catch((e) => setError(e.message));
  }, []);
  const c = data?.counts || {};
  const firstName = (me.DisplayName || "").split(" ")[0];
  const eventsName = roles.eventManagerOnly ? "Event bookings" : "Rentals & Events";

  const goTo = (
    <div className="quick">
      <Quick to="/tickets" icon="ticket" title="Tickets" desc={roles.technician ? "Your tabs for your requests and the IT queue" : "Requests you made or are on"} />
      {roles.worker && (
        <Quick to="/events" icon="calendar" title={eventsName}
          desc={roles.eventManagerOnly ? "Confirm or decline room requests" : "Rooms and equipment, one record each"} />
      )}
      {!roles.worker && <Quick to="/events" icon="calendar" title="My rentals & events" desc="Equipment and rooms you asked for" />}
      {roles.manager && !roles.technician && <Quick to="/team" icon="people" title="My team" desc="Your people and what each one has" />}
      {roles.technician && <Quick to="/people" icon="people" title="People" desc="Roles, departments, what each person holds" />}
      {roles.technician && <Quick to="/inventory" icon="key" title="Inventory" desc="Equipment and software licenses" />}
    </div>
  );

  let manage = [];
  if (roles.technician) {
    manage = [
      { label: "Unassigned", n: c.Unassigned, to: "/tickets?tab=unassigned", warn: true },
      { label: "Assigned to me", n: c.AssignedToMe, to: "/tickets?tab=assigned" },
      { label: "Waiting on requester", n: c.WaitingOnRequester, to: "/tickets?tab=waiting" },
      roles.admin
        ? { label: "Rooms pending HR", n: c.RoomsPending, to: "/events?tab=pending", warn: true }
        : { label: "Equipment out", n: c.EquipmentOut, to: "/events?tab=out" }
    ];
  } else if (roles.eventManagerOnly) {
    manage = [
      { label: "Rooms pending", n: c.RoomsPending, to: "/events?tab=pending", warn: true },
      { label: "Upcoming events", n: c.UpcomingEvents, to: "/events?tab=confirmed" },
      { label: "My open tickets", n: c.MyOpen, to: "/tickets" },
      { label: "Waiting on me", n: c.WaitingOnMe, to: "/tickets?tab=waitingOnMe", warn: true }
    ];
  }

  return (
    <>
      <h1 style={{ fontSize: 28 }}>{greeting()}, {firstName}</h1>
      <div className="muted">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
      {error && <p className="error">{error}</p>}

      <div className="home">
        <div className="home-main">
          {roles.worker && (
            <>
              <div className="sec">Go to</div>
              {goTo}
              <div className="sec">Manage requests</div>
              <Tiles tiles={manage} />
            </>
          )}

          <div className="sec">Create new</div>
          <div className="quick">
            <Quick to="/new?type=support" icon="support" title="Support" desc="Something is broken or you have a question" />
            {roles.accessRequests && <Quick to="/new?type=access" icon="access" title="Access & Equipment" desc="Onboarding, changes, off boarding" />}
            <Quick to="/events/new" icon="calendar" title="Equipment Rental / Event Booking" desc="Borrow equipment, book a room, or both" />
          </div>

          {!roles.worker && (
            <>
              <div className="sec">At a glance</div>
              <Tiles tiles={[
                { label: "My open tickets", n: c.MyOpen, to: "/tickets" },
                { label: "Waiting on me", n: c.WaitingOnMe, to: "/tickets?tab=waitingOnMe", warn: true }
              ]} />
              <div className="sec">Go to</div>
              {goTo}
            </>
          )}
        </div>

        <aside className="home-side">
          <div className="sec">Recent activity</div>
          <div className="card flush" style={{ padding: "4px 0" }}>
            {data && !data.activity.length && <p className="empty">Nothing yet.</p>}
            {!data && !error && <p className="empty">Loading…</p>}
            {data?.activity.map((a, i) => (
              <Link key={i} className="act" to={`/tickets/${a.id}`}>
                <span className="row center" style={{ gap: 8 }}>
                  <span className="dot" style={{ background: a.kind === "ticket" ? "var(--acc)" : "#7a5bb5" }} />
                  <span className="muted small">{timeAgo(a.at)}</span>
                </span>
                <span style={{ fontSize: 14 }}><strong>{a.who}</strong> {a.what}</span>
                <span className="muted small">{a.target}</span>
              </Link>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
