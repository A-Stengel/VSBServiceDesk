// Rental and event times are the desk's local wall time, stored as typed
// ("2026-10-12T09:00"). The SQL driver reads and writes DATETIME2 as UTC, so
// a wall time is passed as that same time in UTC and comes back unchanged.
// The desk's time zone is the TimeZone setting.

const DEFAULT_TIME_ZONE = "America/New_York";

const toSqlTime = (wall) => (wall ? new Date(`${wall}:00Z`) : null);
const toWall = (date) => (date ? date.toISOString().slice(0, 16) : null);

function isTimeZone(name) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

// Now in the desk's time zone, in the same wall-time form.
function wallNow(settings) {
  const zone = settings?.TimeZone && isTimeZone(settings.TimeZone) ? settings.TimeZone : DEFAULT_TIME_ZONE;
  return new Date().toLocaleString("sv-SE", { timeZone: zone }).replace(" ", "T").slice(0, 16);
}

// "Jan 10, 2030, 9:00 AM" for a wall time, for history lines.
function wallLabel(wall) {
  if (!wall) return null;
  return new Date(`${wall}:00Z`).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
}

module.exports = { toSqlTime, toWall, wallNow, wallLabel, isTimeZone };
