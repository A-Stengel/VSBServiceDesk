const { app } = require("@azure/functions");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings, isOn } = require("../shared/settings");
const { loadTicket, setStatus, recordEvents } = require("../shared/tickets");
const { wallNow, isTimeZone } = require("../shared/clock");
const { recordRun, getMarker, setMarker } = require("../shared/health");
const { waitingWarning, ticketClosed } = require("../shared/notify");

// The business day timers. A ticket in a "waiting on requester" status gets
// the waiting on you warning on business day 3 and closes on business day 4
// (Settings > Email > Automations), at 8:15 in the morning in the desk's
// time zone. Business days are Monday to Friday, skipping the Holidays
// list.
//
// Azure timers run on UTC, so this wakes every quarter hour and does the
// day's work once, on the first wake at or after 8:15 local time.

const RUN_AT = "08:15";

function localDay(date, zone) {
  return new Date(date).toLocaleString("sv-SE", { timeZone: zone }).slice(0, 10);
}

function isBusinessDay(day, holidays) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

// Business days after "from" up to and including "to" (both YYYY-MM-DD).
function businessDaysBetween(from, to, holidays) {
  let count = 0;
  const day = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  for (day.setUTCDate(day.getUTCDate() + 1); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (isBusinessDay(day.toISOString().slice(0, 10), holidays)) count += 1;
  }
  return count;
}

async function loadHolidays(db) {
  const result = await db.request().query("SELECT CONVERT(CHAR(10), HolidayDate, 23) AS D FROM dbo.Holidays WHERE IsActive = 1");
  return new Set(result.recordset.map((r) => r.D));
}

// The day's warnings and closes. Returns what it did.
async function runBusinessDayTimers(settings, today, context) {
  const db = await getConnection();
  const zone = isTimeZone(settings.TimeZone) ? settings.TimeZone : "America/New_York";
  const holidays = await loadHolidays(db);
  const warnAt = settings.WarningBusinessDays || 3;
  const closeAt = settings.CloseBusinessDays || 4;
  const done = { warned: 0, closed: 0 };

  const waiting = await db.request().query(`
    SELECT t.Id, t.WaitingSince, t.WarningSentAt
    FROM dbo.Tickets t
    JOIN dbo.Statuses s ON s.Id = t.StatusId
    WHERE s.IsWaitingOnRequester = 1 AND s.IsClosed = 0 AND t.WaitingSince IS NOT NULL
  `);
  for (const row of waiting.recordset) {
    const days = businessDaysBetween(localDay(row.WaitingSince, zone), today, holidays);
    if (days >= closeAt && isOn(settings, "AutoClose") && settings.ClosedStatusId) {
      await withTransaction(async (tx) => {
        const ticket = await loadTicket(tx, row.Id);
        if (!ticket || ticket.IsClosed || !ticket.IsWaitingOnRequester) return;
        await recordEvents(tx, row.Id, null, [{ field: "Closed automatically", newValue: `No answer after ${days} business days` }]);
        await setStatus(tx, ticket, settings.ClosedStatusId, null);
      });
      await ticketClosed(row.Id, context);
      done.closed += 1;
    } else if (days >= warnAt && !row.WarningSentAt) {
      await waitingWarning(row.Id, context);
      // Marked even when the warning is switched off, so turning it on later
      // doesn't send a pile of old warnings at once.
      await db.request().input("Id", sql.Int, row.Id).query("UPDATE dbo.Tickets SET WarningSentAt = SYSUTCDATETIME() WHERE Id = @Id");
      done.warned += 1;
    }
  }
  return done;
}

app.timer("businessDayTimers", {
  schedule: "0 */15 * * * *", // every quarter hour; acts once a day at 8:15 local
  handler: async (timer, context) => {
    try {
      const settings = await getSettings();
      const now = wallNow(settings);
      const today = now.slice(0, 10);
      if (now.slice(11) < RUN_AT) return;
      if ((await getMarker("timers")) === today) return;
      const db = await getConnection();
      if (isBusinessDay(today, await loadHolidays(db))) {
        const done = await runBusinessDayTimers(settings, today, context);
        if (done.warned || done.closed) context.log(`Business day timers: ${done.warned} warned, ${done.closed} closed`);
      }
      await setMarker("timers", today);
      await recordRun("timers", null, context);
    } catch (error) {
      context.error(error);
      await recordRun("timers", error, context);
    }
  }
});

module.exports = { businessDaysBetween, isBusinessDay, runBusinessDayTimers, localDay };
