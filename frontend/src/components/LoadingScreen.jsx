import { useEffect, useState } from "react";
import Logo from "./Logo.jsx";

// The card everyone sees while the site starts: each step ticks off, a note
// appears when a step is slow, the countdown shows while the app retries, and
// a Try again button shows when it gives up.
export const STEPS = ["Checking your sign-in", "Loading your account", "Loading the service desk"];
export const ATTEMPTS = 3;
const SLOW_SECONDS = 5;

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12l5 5 9-10" />
  </svg>
);
const Cross = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const Retry = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5" />
  </svg>
);
const Clock = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  </svg>
);

// boot: { step, attempt, since, retryIn, wait, failed: { message, gaveUp } }
export default function LoadingScreen({ boot, onRetry }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { step, attempt, since, retryIn, wait, failed } = boot;
  const retrying = !failed && retryIn > 0;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const slow = !failed && !retrying && seconds >= SLOW_SECONDS;
  const state = failed ? "fail" : retrying ? "warn" : "";

  let title = "Getting things ready";
  let sub = "This usually takes a few seconds.";
  if (retrying) {
    title = "Still trying to connect";
    sub = "The server didn't answer, so we're trying again.";
  } else if (failed?.gaveUp) {
    title = "The service desk isn't responding";
    sub = `We tried ${ATTEMPTS} times and couldn't reach the server.`;
  } else if (failed) {
    title = "The service desk couldn't open";
    sub = failed.message;
  }

  return (
    <main className="page boot">
      <section className="card boot-card" aria-live="polite">
        <div className={`boot-badge ${state}`}>
          {!failed && (
            <svg className="ring" width="104" height="104" viewBox="0 0 104 104" aria-hidden="true">
              <circle cx="52" cy="52" r="49" fill="none" stroke="var(--ring-soft)" strokeWidth="3" />
              <path d="M52 3a49 49 0 0 1 49 49" fill="none" stroke="var(--ring)" strokeWidth="3" strokeLinecap="round" />
            </svg>
          )}
          <Logo size={84} className="boot-logo" />
          {state && <span className="boot-dot">{failed ? <Cross /> : <Retry size={14} />}</span>}
        </div>
        <h1>{title}</h1>
        <p className="muted boot-sub">{sub}</p>
        <ol className="boot-steps">
          {STEPS.map((label, i) => {
            const cls = i < step ? "done" : i > step ? "" : failed ? "bad" : "now";
            return (
              <li key={label} className={cls}>
                <span className="ic">{cls === "done" ? <Check /> : cls === "bad" ? <Cross /> : null}</span>
                {label}
                {cls === "now" && slow && <span className="t">{seconds} s</span>}
              </li>
            );
          })}
        </ol>
        {slow && (
          <div className="boot-note slow">
            <Clock />
            <div>This is taking longer than usual. Still working, there&apos;s no need to reload.</div>
          </div>
        )}
        {retrying && (
          <div className="boot-note retry">
            <Retry />
            <div style={{ flex: 1 }}>
              Couldn&apos;t reach the server. Trying again (attempt {attempt + 1} of {ATTEMPTS}) in <b>{retryIn}</b> second{retryIn === 1 ? "" : "s"}.
              <div className="boot-bar"><i style={{ width: `${((wait - retryIn) / wait) * 100}%` }} /></div>
            </div>
          </div>
        )}
        {failed && (
          <div className="boot-actions">
            <button className="btn pri" onClick={onRetry}><Retry size={16} />Try again</button>
            <div className="muted small">
              If this keeps happening, email <b className="select">servicedesk@vsb.org</b> or call IT.
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
