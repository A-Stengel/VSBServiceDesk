import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import SubmitRequest from "./pages/SubmitRequest.jsx";
import MyTickets from "./pages/MyTickets.jsx";
import Queue from "./pages/Queue.jsx";
import TicketPage from "./pages/TicketPage.jsx";
import People from "./pages/People.jsx";
import Licenses from "./pages/Licenses.jsx";
import Settings from "./pages/Settings.jsx";

// The signed-in person and every pick-list, loaded once and shared.
const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export default function App() {
  const [me, setMe] = useState(null);
  const [lookups, setLookups] = useState(null);
  const [error, setError] = useState("");

  const reloadLookups = useCallback(() => api.lookups().then(setLookups), []);

  useEffect(() => {
    Promise.all([api.me(), api.lookups()])
      .then(([user, lists]) => {
        setMe(user);
        setLookups(lists);
      })
      .catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="page"><p className="error">{error}</p></div>;
  if (!me || !lookups) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <AppContext.Provider value={{ me, lookups, reloadLookups }}>
      <header className="topbar">
        <span className="brand">VSB Service Desk</span>
        <nav>
          <NavLink to="/new">Submit a request</NavLink>
          <NavLink to="/mine">My tickets</NavLink>
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
          <Route path="/" element={<Navigate to={me.IsTechnician ? "/queue" : "/mine"} replace />} />
          <Route path="/new" element={<SubmitRequest />} />
          <Route path="/mine" element={<MyTickets />} />
          <Route path="/tickets/:id" element={<TicketPage />} />
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
