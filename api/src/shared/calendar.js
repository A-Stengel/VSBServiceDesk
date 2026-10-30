const { getConnection, sql } = require("./db");
const { getSettings, isOn } = require("./settings");
const { graph } = require("./graph");
const { loadTicket } = require("./tickets");
const { toWall } = require("./clock");
const { recordRun } = require("./health");
const { logEmail } = require("./notify");
const { toPlain } = require("./richtext");

// Room bookings on the events calendar (the EventsCalendarAddress setting),
// behind the "Write room bookings to the events calendar" switch. A booking
// goes on when it's asked for (marked Pending), changes when it changes, and
// comes off when it's declined, cancelled or loses its room. No attendees,
// so nobody gets an invitation.
//
// The calendar is reached as a mailbox (/users/{address}/events). Microsoft
// doesn't support the app's own access on Microsoft 365 group calendars; if
// the events calendar is a group, the first write fails, the error shows in
// Settings > Email and the error recipients are told (README, calendar
// step).

async function saveEventId(db, ticketId, eventId) {
  await db.request().input("Id", sql.Int, ticketId).input("EventId", sql.NVarChar(400), eventId)
    .query("UPDATE dbo.TicketRooms SET CalendarEventId = @EventId WHERE TicketId = @Id");
}

function eventBody(settings, ticket) {
  const pending = ticket.BookingStatusId === settings.BookingPendingStatusId;
  const lines = [
    `Requested by ${ticket.RequesterName} (${ticket.RequesterEmail})`,
    `Attendees: ${ticket.AttendeeCount ?? ""}`,
    `Refreshments: ${ticket.Refreshments ? "Yes" : "No"} · Lunch catered: ${ticket.LunchCatered ? "Yes" : "No"} · FOIA: ${ticket.Foia ? "Yes" : "No"}`,
    toPlain(ticket.Description)
  ].filter(Boolean);
  return {
    subject: `${pending ? "[Pending] " : ""}${ticket.Subject}`,
    body: { contentType: "Text", content: lines.join("\n") },
    start: { dateTime: `${toWall(ticket.StartAt)}:00`, timeZone: settings.TimeZone || "America/New_York" },
    end: { dateTime: `${toWall(ticket.EndAt)}:00`, timeZone: settings.TimeZone || "America/New_York" },
    location: { displayName: ticket.RoomName || "" },
    showAs: pending ? "tentative" : "busy",
    isReminderOn: false,
    responseRequested: false
  };
}

// Brings the calendar in line with the ticket's room: adds, updates or
// removes its event. Never throws.
async function syncCalendar(ticketId, context) {
  const settings = await getSettings();
  if (!isOn(settings, "CalendarWrite") || !settings.EventsCalendarAddress) return;
  const db = await getConnection();
  try {
    const ticket = await loadTicket(db, ticketId);
    if (!ticket) return;
    const row = (await db.request().input("Id", sql.Int, ticketId).query("SELECT CalendarEventId FROM dbo.TicketRooms WHERE TicketId = @Id")).recordset[0];
    const base = `/users/${encodeURIComponent(settings.EventsCalendarAddress)}/events`;
    const wanted = ticket.HasRoom && ticket.IsActiveBooking && ticket.StartAt && ticket.EndAt;
    const eventId = row?.CalendarEventId;

    if (!wanted) {
      if (eventId) {
        await graph("DELETE", `${base}/${encodeURIComponent(eventId)}`).catch((error) => {
          if (error.status !== 404) throw error;
        });
        if (row) await saveEventId(db, ticketId, null);
        await logEmail(db, ticketId, "Removed the booking from the events calendar", "Calendar");
      }
      await recordRun("calendar");
      return;
    }
    const event = eventBody(settings, ticket);
    if (eventId) {
      try {
        await graph("PATCH", `${base}/${encodeURIComponent(eventId)}`, event);
        await recordRun("calendar");
        return;
      } catch (error) {
        if (error.status !== 404) throw error;
        // Someone deleted it from the calendar; put it back
      }
    }
    const created = await graph("POST", base, event);
    await saveEventId(db, ticketId, created.id);
    await logEmail(db, ticketId, "Added the booking to the events calendar", "Calendar");
    await recordRun("calendar");
  } catch (error) {
    (context?.error || console.error)(error);
    await recordRun("calendar", error, context);
    await logEmail(db, ticketId, `Events calendar not updated: ${error.message}`, "Calendar").catch(() => {});
  }
}

module.exports = { syncCalendar };
