import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, isSignedIn } from "./api.js";
import Icon from "./components/Icon.jsx";
import Logo, { updateTabIcon } from "./components/Logo.jsx";
import LoadingScreen, { ATTEMPTS } from "./components/LoadingScreen.jsx";
import Home from "./pages/Home.jsx";
import SubmitRequest from "./pages/SubmitRequest.jsx";
import Tickets from "./pages/Tickets.jsx";
import TicketPage from "./pages/TicketPage.jsx";
import People from "./pages/People.jsx";
import Person from "./pages/Person.jsx";
import Inventory from "./pages/Inventory.jsx";
import Settings from "./pages/Settings.jsx";
import BookEvent from "./pages/BookEvent.jsx";
import Rentals from "./pages/Rentals.jsx";
import BookingPage from "./pages/BookingPage.jsx";

// The signed-in person, every pick-list and the message banner, shared by
// every page.
const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

const SIGN_IN_TRIED = "signInTried";

// Seconds to wait before the second and third tries when the server doesn't
// answer (for example while the database starts up).
const RETRY_WAITS = [10, 15];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// No status means the request never reached the server.
const worthRetrying = (error) => !error.status || error.status >= 500 || error.status === 408 || error.status === 429;

// What someone can do, from their role. The API counts technicians and admins
// as event managers too, so "eventManagerOnly" is HR without IT access.
export function rolesOf(me) {
  const technician = !!me.IsTechnician;
  const eventManagerOnly = !!me.IsEventManager && !technician;
  return {
    technician,
    admin: !!me.IsAdmin,
    eventManagerOnly,
    worker: technician || eventManagerOnly,
    settings: !!me.IsAdmin || eventManagerOnly
  };
}

// Shown when the site has no sign-in. The site never sends people to
// Microsoft on its own, so a failed sign-in shows here instead of looping.
function SignIn() {
  const tried = sessionStorage.getItem(SIGN_IN_TRIED);
  const start = () => {
    sessionStorage.setItem(SIGN_IN_TRIED, "1");
    window.location.href = "/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(window.location.pathname);
  };
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 520 }}>
        <h1>VSB Service Desk</h1>
        {tried && (
          <p className="error">
            Microsoft signed you in, but the site didn&apos;t finish the sign-in. Check the Static Web App&apos;s
            AZURE_CLIENT_ID and AZURE_CLIENT_SECRET settings and the app registration (README Steps 4 and 5).
          </p>
        )}
        <p>Sign in with your @vsb.org Microsoft account.</p>
        <button className="btn pri" onClick={start}>Sign in</button>
      </div>
    </main>
  );
}

const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

// While the site is starting, "me" is null and grey placeholders stand in for
// the buttons and the person's name.
function Header({ me }) {
  if (!me) {
    return (
      <header className="topbar">
        <div className="topbar-inner">
          <span className="hbtn brand"><Logo size={36} />VSB Service Desk</span>
          <div className="top-actions placeholders" aria-hidden="true"><span className="b" /><span className="a" /><span className="n" /></div>
        </div>
      </header>
    );
  }
  return <SignedInHeader me={me} />;
}

function SignedInHeader({ me }) {
  const roles = rolesOf(me);
  const [open, setOpen] = useState(false);
  const menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!menu.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link to="/" className="hbtn brand">
          <Logo size={36} />
          VSB Service Desk
        </Link>
        <div className="top-actions">
          <Link to="/new" className="btn submit">
            <Icon name="plus" size={16} strokeWidth={2.4} />
            Submit a request
          </Link>
          {roles.settings && (
            <Link to="/settings" className="hbtn" aria-label="Settings" title="Settings" style={{ width: 44, justifyContent: "center", padding: 0 }}>
              <Icon name="gear" size={22} strokeWidth={1.8} />
            </Link>
          )}
          <div style={{ position: "relative" }} ref={menu}>
            <button className="hbtn" onClick={() => setOpen(!open)} aria-label="Account menu" aria-expanded={open}>
              <span className="avatar">{initials(me.DisplayName || me.Email)}</span>
              <span>{me.DisplayName}</span>
              <Icon name="chevron" size={14} strokeWidth={2.4} />
            </button>
            {open && (
              <div className="card menu">
                <div className="who">{me.Email}<br />{me.RoleName}</div>
                <a className="btn ghost sm" href="/logout">Sign out</a>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

// "Home / Page" above every page but the home page.
const CRUMBS = [
  [/^\/new/, "Submit a request"],
  [/^\/tickets\/\d+/, "Ticket"],
  [/^\/tickets/, "Tickets"],
  [/^\/events\/new/, "Equipment Rental / Event Booking"],
  [/^\/events\/\d+/, "Rental or event"],
  [/^\/events/, "Rentals & Events"],
  [/^\/people\/\d+/, "Person"],
  [/^\/people/, "People"],
  [/^\/inventory/, "Inventory"],
  [/^\/settings/, "Settings"]
];

function Crumbs({ me }) {
  const { pathname } = useLocation();
  if (pathname === "/") return null;
  let label = CRUMBS.find(([pattern]) => pattern.test(pathname))?.[1];
  if (!label) return null;
  if (label === "Rentals & Events" && rolesOf(me).eventManagerOnly) label = "Event bookings";
  const parent = pathname.startsWith("/people/") ? ["/people", "People"]
    : pathname.startsWith("/tickets/") ? ["/tickets", "Tickets"]
    : /^\/events\/\d+/.test(pathname) ? ["/events", rolesOf(me).eventManagerOnly ? "Event bookings" : "Rentals & Events"]
    : null;
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <Link className="link" to="/">Home</Link>
      <span className="muted">/</span>
      {parent && (
        <>
          <Link className="link" to={parent[0]}>{parent[1]}</Link>
          <span className="muted">/</span>
        </>
      )}
      <span className="muted">{label}</span>
    </nav>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">
      <span className="body">{toast.text}</span>
      <button className="link" onClick={onClose}>Dismiss</button>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [lookups, setLookups] = useState(null);
  const [signedIn, setSignedIn] = useState(null);
  const [boot, setBoot] = useState({ step: 0, attempt: 1, since: Date.now(), retryIn: 0, wait: 0, failed: null });
  const run = useRef(0);
  const [toast, setToast] = useState(null);
  const { pathname } = useLocation();
  const reloadLookups = useCallback(() => api.lookups().then(setLookups), []);
  // A message stays through the navigation that follows it, then clears on
  // the next page change.
  const notify = useCallback((text, bad = false) => {
    setToast(text ? { text, bad, at: Date.now() } : null);
  }, []);

  useEffect(() => {
    setToast((current) => (current && Date.now() - current.at > 1500 ? null : current));
  }, [pathname]);

  // Starts the site one step at a time so the loading screen can say what is
  // happening. A step the server doesn't answer is tried up to ATTEMPTS times.
  const start = useCallback(async () => {
    const id = ++run.current;
    const current = () => run.current === id;
    const show = (state) => { if (current()) setBoot(state); };

    async function attemptStep(step, call) {
      for (let attempt = 1; ; attempt += 1) {
        show({ step, attempt, since: Date.now(), retryIn: 0, wait: 0, failed: null });
        try {
          return await call();
        } catch (error) {
          if (!worthRetrying(error)) throw error;
          if (attempt >= ATTEMPTS) { error.gaveUp = true; throw error; }
          const seconds = RETRY_WAITS[attempt - 1];
          for (let left = seconds; left > 0; left -= 1) {
            if (!current()) return undefined;
            show({ step, attempt, since: Date.now(), retryIn: left, wait: seconds, failed: null });
            await wait(1000);
          }
        }
      }
    }

    let step = 0;
    try {
      show({ step, attempt: 1, since: Date.now(), retryIn: 0, wait: 0, failed: null });
      const yes = await isSignedIn();
      if (!current()) return;
      setSignedIn(yes);
      if (!yes) return;
      sessionStorage.removeItem(SIGN_IN_TRIED);
      updateTabIcon();
      step = 1;
      const user = await attemptStep(step, api.me);
      step = 2;
      const lists = await attemptStep(step, api.lookups);
      if (!current()) return;
      setMe(user);
      setLookups(lists);
    } catch (error) {
      show({ step, attempt: ATTEMPTS, since: Date.now(), retryIn: 0, wait: 0, failed: { message: error.message, gaveUp: !!error.gaveUp } });
    }
  }, []);

  useEffect(() => { start(); }, [start]);

  if (signedIn === false) return <SignIn />;
  if (!me || !lookups) {
    return (
      <>
        <Header me={null} />
        <LoadingScreen boot={boot} onRetry={start} />
      </>
    );
  }
  const roles = rolesOf(me);

  return (
    <AppContext.Provider value={{ me, roles, lookups, reloadLookups, notify }}>
      <Header me={me} />
      <main className="page">
        <Toast toast={toast} onClose={() => setToast(null)} />
        <Crumbs me={me} />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/new" element={<SubmitRequest />} />
          <Route path="/tickets" element={<Tickets />} />
          <Route path="/tickets/:id" element={<TicketPage />} />
          <Route path="/mine" element={<Navigate to="/tickets" replace />} />
          <Route path="/queue" element={<Navigate to="/tickets?tab=all" replace />} />
          <Route path="/events" element={<Rentals />} />
          <Route path="/events/new" element={<BookEvent />} />
          <Route path="/events/mine" element={<Navigate to="/events" replace />} />
          <Route path="/events/:id" element={<BookingPage />} />
          {roles.technician && <Route path="/people" element={<People />} />}
          {roles.technician && <Route path="/people/:id" element={<Person />} />}
          {roles.technician && <Route path="/inventory" element={<Inventory />} />}
          {roles.technician && <Route path="/licenses" element={<Navigate to="/inventory?tab=licenses" replace />} />}
          {roles.settings && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </AppContext.Provider>
  );
}
