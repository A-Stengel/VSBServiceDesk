import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api, isSignedIn } from "./api.js";
import SubmitRequest from "./pages/SubmitRequest.jsx";
import MyTickets from "./pages/MyTickets.jsx";
import Queue from "./pages/Queue.jsx";
import TicketPage from "./pages/TicketPage.jsx";
import People from "./pages/People.jsx";
import Licenses from "./pages/Licenses.jsx";
import Settings from "./pages/Settings.jsx";
import BookEvent from "./pages/BookEvent.jsx";
import MyBookings from "./pages/MyBookings.jsx";
import EventBookings from "./pages/EventBookings.jsx";
import BookingPage from "./pages/BookingPage.jsx";

// The signed-in person and every pick-list, loaded once and shared.
const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const SIGN_IN_TRIED = "signInTried";

// Shown when the site has no sign-in. The site never sends people to
// Microsoft on its own, so a failed sign-in shows here instead of looping.
function SignIn() {
  const tried = sessionStorage.getItem(SIGN_IN_TRIED);
  const start = () => {
    sessionStorage.setItem(SIGN_IN_TRIED, "1");
    window.location.href = "/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(window.location.pathname);
  };
  return (
    <div className="page">
      <div className="card narrow">
        <h1>VSB Service Desk</h1>
        {tried && (
          <p className="error">
            Microsoft signed you in, but the site didn't finish the sign-in. Check the Static Web App&apos;s
            AZURE_CLIENT_ID and AZURE_CLIENT_SECRET settings and the app registration (README Steps 4 and 5).
          </p>
        )}
        <p>Sign in with your @vsb.org Microsoft account.</p>
        <button className="primary" onClick={start}>Sign in</button>
      </div>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [lookups, setLookups] = useState(null);
  const [error, setError] = useState("");
  const [signedIn, setSignedIn] = useState(null);

  const reloadLookups = useCallback(() => api.lookups().then(setLookups), []);

  useEffect(() => {
    isSignedIn().then((yes) => {
      setSignedIn(yes);
      if (!yes) return;
      sessionStorage.removeItem(SIGN_IN_TRIED);
      Promise.all([api.me(), api.lookups()])
        .then(([user, lists]) => {
          setMe(user);
          setLookups(lists);
        })
        .catch((e) => setError(e.message));
    });
  }, []);

  if (signedIn === false) return <SignIn />;
  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!me || !lookups) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <AppContext.Provider value={{ me, lookups, reloadLookups }}>
      <header className="topbar">
        <span className="brand">VSB Service Desk</span>
        <nav>
          <NavLink to="/new">Submit a request</NavLink>
          <NavLink to="/mine">My tickets</NavLink>
          <NavLink to="/events/new">Book an event</NavLink>
          <NavLink to="/events/mine">My bookings</NavLink>
          {me.IsEventManager && <NavLink to="/events" end>Event bookings</NavLink>}
          {me.IsTechnician && <NavLink to="/queue">Queue</NavLink>}
          {me.IsTechnician && <NavLink to="/people">People</NavLink>}
          {me.IsTechnician && <NavLink to="/licenses">Licenses</NavLink>}
          {me.IsAdmin && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <span className="who">
          {me.DisplayName} · <a href="/logout">Sign out</a>
        </span>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Navigate to={me.IsTechnician ? "/queue" : me.IsEventManager ? "/events" : "/mine"} replace />} />
          <Route path="/new" element={<SubmitRequest />} />
          <Route path="/mine" element={<MyTickets />} />
          <Route path="/tickets/:id" element={<TicketPage />} />
          <Route path="/events/new" element={<BookEvent />} />
          <Route path="/events/mine" element={<MyBookings />} />
          <Route path="/events/:id" element={<BookingPage />} />
          {me.IsEventManager && <Route path="/events" element={<EventBookings />} />}
          {me.IsTechnician && <Route path="/queue" element={<Queue />} />}
          {me.IsTechnician && <Route path="/people" element={<People />} />}
          {me.IsTechnician && <Route path="/licenses" element={<Licenses />} />}
          {me.IsAdmin && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </AppContext.Provider>
  );
}
