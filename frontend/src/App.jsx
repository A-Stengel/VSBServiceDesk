import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, isSignedIn } from "./api.js";
import Icon from "./components/Icon.jsx";
import Logo, { updateTabIcon } from "./components/Logo.jsx";
import LoadingScreen, { ATTEMPTS } from "./components/LoadingScreen.jsx";
import { MODE_NAMES, getAppearance, onAppearanceChange, setAppearance } from "./theme.js";
import { organization, rememberOrganization } from "./organization.js";
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
import Survey from "./pages/Survey.jsx";
import HeldMail from "./pages/HeldMail.jsx";
import MyTeam from "./pages/MyTeam.jsx";
import Search from "./pages/Search.jsx";

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
  const manager = (me.ManagedDepartmentIds || []).length > 0;
  return {
    manager,
    // Access & Equipment: managers (their own departments), IT and HR
    accessRequests: technician || !!me.IsEventManager || manager,
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
  const domain = organization().staffDomains.split(",")[0].trim();
  const start = () => {
    sessionStorage.setItem(SIGN_IN_TRIED, "1");
    window.location.href = "/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(window.location.pathname);
  };
  return (
    <main className="page">
      <div className="card" style={{ maxWidth: 520 }}>
        <h1>{organization().appName}</h1>
        {tried && (
          <p className="error">
            Microsoft signed you in, but the site didn&apos;t finish the sign-in. Check the Static Web App&apos;s
            AZURE_CLIENT_ID and AZURE_CLIENT_SECRET settings and the app registration (README Steps 4 and 5).
          </p>
        )}
        <p>Sign in with your {domain ? `@${domain} ` : "work "}Microsoft account.</p>
        <button className="btn pri" onClick={start}>Sign in</button>
      </div>
    </main>
  );
}

// Shown instead of the app when it's closed to this person: maintenance mode,
// or staff before the desk opens to them (Settings > System > Access).
function Gate({ me }) {
  const mailbox = me.MailboxAddress;
  const maintenance = me.Gate === "maintenance";
  return (
    <>
      <Header me={me} />
      <main className="page">
        <div className="card" style={{ maxWidth: 560 }}>
          <h1>{maintenance ? "Down for maintenance" : "Coming soon"}</h1>
          <p>
            {maintenance
              ? "The service desk is down for maintenance. Please try again later."
              : "The new service desk isn't open to staff yet."}
            {mailbox && <> Until then, email <a className="link" href={`mailto:${mailbox}`}>{mailbox}</a> for help.</>}
          </p>
        </div>
      </main>
    </>
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
          <span className="hbtn brand"><Logo size={36} />{organization().appName}</span>
          <div className="top-actions placeholders" aria-hidden="true"><span className="b" /><span className="a" /><span className="n" /></div>
        </div>
      </header>
    );
  }
  return <SignedInHeader me={me} />;
}

function SignedInHeader({ me }) {
  const roles = rolesOf(me);
  const appName = useApp()?.lookups?.organization?.appName || organization().appName;
  const gated = !!me.Gate;
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
          {appName}
        </Link>
        <div className="top-actions">
          {roles.technician && !gated && <HeaderSearch />}
          {!gated && (
            <Link to="/new" className="btn submit">
              <Icon name="plus" size={16} strokeWidth={2.4} />
              Submit a request
            </Link>
          )}
          {roles.settings && !gated && (
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
                <ModePicker />
                <a className="btn ghost sm" href="/logout">Sign out</a>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

// Technicians search every ticket from the header; the results are on the
// Search page.
function HeaderSearch() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [text, setText] = useState("");
  useEffect(() => { if (pathname !== "/search") setText(""); }, [pathname]);
  return (
    <>
      <form className="top-search" role="search" onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) navigate(`/search?q=${encodeURIComponent(text.trim())}`);
      }}>
        <Icon name="search" size={16} strokeWidth={2.2} />
        <input type="search" placeholder="Search tickets" aria-label="Search tickets" value={text} onChange={(e) => setText(e.target.value)} />
      </form>
      <Link to="/search" className="hbtn top-search-icon" aria-label="Search tickets" title="Search tickets">
        <Icon name="search" size={20} strokeWidth={2} />
      </Link>
    </>
  );
}

// Light, Dark or Match device, for this person only. It changes the page
// straight away and then saves to their account so it follows them to other
// computers.
function ModePicker() {
  const [mode, setMode] = useState(getAppearance().mode);
  const [note, setNote] = useState("");
  useEffect(() => onAppearanceChange((state) => setMode(state.mode)), []);

  async function pick(next) {
    setAppearance({ mode: next });
    setNote("");
    try {
      await api.saveMyAppearance(next);
    } catch (err) {
      setNote(err.message);
    }
  }

  return (
    <div className="mode-picker">
      <div className="lbl" id="mode-label">Appearance</div>
      <div className="seg" role="group" aria-labelledby="mode-label">
        {Object.entries(MODE_NAMES).map(([value, name]) => (
          <button key={value} type="button" className={mode === value ? "on" : ""} aria-pressed={mode === value} onClick={() => pick(value)}>
            {name}
          </button>
        ))}
      </div>
      {note && <div className="muted small">{note}</div>}
    </div>
  );
}

// "Home / Page" above every page but the home page.
const CRUMBS = [
  [/^\/new/, "Submit a request"],
  [/^\/tickets\/\d+/, "Ticket"],
  [/^\/tickets/, "Tickets"],
  [/^\/events\/new/, "Equipment Rental / Event Booking"],
  [/^\/events/, "Rentals & Events"],
  [/^\/team/, "My team"],
  [/^\/people\/\d+/, "Person"],
  [/^\/people/, "People"],
  [/^\/inventory/, "Inventory"],
  [/^\/held-mail/, "Held mail"],
  [/^\/search/, "Search"],
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
  useEffect(() => {
    if (lookups?.organization) rememberOrganization(lookups.organization);
  }, [lookups]);
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
      if (user?.Gate) {
        if (current()) setMe(user);
        return;
      }
      step = 2;
      const lists = await attemptStep(step, api.lookups);
      if (!current()) return;
      setMe(user);
      setLookups(lists);
      // The saved colors and this person's mode. If it fails the site keeps
      // the last ones this browser saw.
      api.appearance().then(setAppearance).catch(() => {});
    } catch (error) {
      show({ step, attempt: ATTEMPTS, since: Date.now(), retryIn: 0, wait: 0, failed: { message: error.message, gaveUp: !!error.gaveUp } });
    }
  }, []);

  const survey = pathname.startsWith("/survey/");
  useEffect(() => { if (!survey) start(); }, [start, survey]);

  // The survey works without signing in (outside people get it too)
  if (survey) return <Routes><Route path="/survey/:token" element={<Survey />} /></Routes>;
  if (signedIn === false) return <SignIn />;
  if (me?.Gate) return <Gate me={me} />;
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
          {/* Bookings used to have their own page; they're tickets now */}
          <Route path="/events/:id" element={<Navigate to="/events" replace />} />
          {roles.manager && <Route path="/team" element={<MyTeam />} />}
          {roles.technician && <Route path="/people" element={<People />} />}
          {roles.technician && <Route path="/people/:id" element={<Person />} />}
          {roles.technician && <Route path="/inventory" element={<Inventory />} />}
          {roles.technician && <Route path="/held-mail" element={<HeldMail />} />}
          {roles.technician && <Route path="/search" element={<Search />} />}
          {roles.technician && <Route path="/licenses" element={<Navigate to="/inventory?tab=licenses" replace />} />}
          {roles.settings && <Route path="/settings" element={<Settings />} />}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </AppContext.Provider>
  );
}
