import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../api.js";
import Logo from "../components/Logo.jsx";
import { organization } from "../organization.js";

// The satisfaction survey from the closed email. It shows before (and
// without) signing in, because outside people get it too; the link's token
// is the only way in. A rating picked in the email arrives as ?rating=.
export default function Survey() {
  const { token } = useParams();
  const [params] = useSearchParams();
  const [about, setAbout] = useState(null);
  const [error, setError] = useState("");
  const [rating, setRating] = useState(() => {
    const n = Number(params.get("rating"));
    return n >= 1 && n <= 5 ? n : 0;
  });
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.survey(token).then(setAbout).catch((e) => setError(e.message));
  }, [token]);

  async function send(e) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      setAbout(await api.answerSurvey(token, { rating, comment }));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const appName = about?.appName || organization().appName;
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="hbtn brand"><Logo size={36} />{appName}</span>
        </div>
      </header>
      <main className="page">
        <div className="card" style={{ maxWidth: 560, margin: "0 auto" }}>
          {!about && !error && <p className="muted">Loading…</p>}
          {!about && error && <p className="error">{error}</p>}
          {about?.answered && (
            <>
              <h1>Thank you</h1>
              <p>Your answer for ticket #{about.ticketNumber} is saved. It helps us do better.</p>
            </>
          )}
          {about && !about.answered && (
            <form className="form" onSubmit={send}>
              <h1 style={{ marginBottom: 0 }}>How did we do?</h1>
              <p className="muted" style={{ margin: 0 }}>Ticket #{about.ticketNumber}: {about.subject}</p>
              <div>
                <div className="lbl" id="rating-label">Your rating (1 is poor, 5 is great)</div>
                <div className="seg" role="group" aria-labelledby="rating-label" style={{ maxWidth: 320, marginTop: 6 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" className={rating === n ? "on" : ""} aria-pressed={rating === n} onClick={() => setRating(n)}>{n}</button>
                  ))}
                </div>
              </div>
              <label>
                Anything else you'd like to tell us? (optional)
                <textarea rows={4} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
              </label>
              {error && <p className="error">{error}</p>}
              <div><button className="btn pri" disabled={!rating || saving}>{saving ? "Sending…" : "Send"}</button></div>
            </form>
          )}
        </div>
      </main>
    </>
  );
}
