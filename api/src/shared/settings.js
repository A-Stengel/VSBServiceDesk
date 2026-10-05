const { getConnection, sql } = require("./db");

// Every row in dbo.Settings the app knows about, how to edit it, and what it means.
// "lookup" settings store the Id of a row in that lookup table.
const SETTINGS_META = [
  { key: "NewStatusId", label: "Status for new tickets", type: "lookup", lookup: "statuses" },
  { key: "AssignedStatusId", label: "Status when a New ticket gets a technician", type: "lookup", lookup: "statuses" },
  { key: "AwaitingStatusId", label: "Status after a technician replies", type: "lookup", lookup: "statuses" },
  { key: "RequesterReplyStatusId", label: "Status after the requester replies", type: "lookup", lookup: "statuses" },
  { key: "ClosedStatusId", label: "Status for Move to Closure", type: "lookup", lookup: "statuses" },
  { key: "DefaultPriorityId", label: "Default priority", type: "lookup", lookup: "priorities" },
  { key: "WebSourceId", label: "Source for tickets made in the app", type: "lookup", lookup: "sources" },
  { key: "DefaultRoleId", label: "Role for people signing in the first time", type: "lookup", lookup: "roles" },
  { key: "StaffUserTypeId", label: "User type for staff", type: "lookup", lookup: "userTypes" },
  { key: "ExternalUserTypeId", label: "User type for outside people", type: "lookup", lookup: "userTypes" },
  { key: "SharedMailboxUserTypeId", label: "User type for shared mailboxes", type: "lookup", lookup: "userTypes" },
  { key: "EmailSwitch", label: "Outgoing email", type: "choice", choices: ["Off", "IT only", "On"] },
  { key: "WarningBusinessDays", label: "Business days before the warning email", type: "number" },
  { key: "CloseBusinessDays", label: "Business days before automatic close", type: "number" },
  { key: "MailboxAddress", label: "Service desk mailbox", type: "text" },
  { key: "ITTeamEmails", label: "IT team notification emails (comma separated)", type: "text" },
  { key: "MailboxCheckMinutes", label: "Minutes between mailbox checks", type: "number" },
  { key: "BookingPendingStatusId", label: "Status for new event bookings", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingConfirmedStatusId", label: "Status when an event manager confirms a booking", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingDeclinedStatusId", label: "Status when an event manager declines a booking", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingCancelledStatusId", label: "Status when a booking is cancelled", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingTicketTypeId", label: "Ticket type for a booking's equipment", type: "lookup", lookup: "ticketTypes" },
  { key: "EventsCalendarAddress", label: "Events calendar address", type: "text" },
  { key: "EventGuidelines", label: "Event booking guidelines", type: "longtext" }
];

let cache;
let cachedAt = 0;

// Settings as an object, with Id and number settings converted to numbers.
// Cached for 30 seconds per instance.
async function getSettings() {
  if (cache && Date.now() - cachedAt < 30000) return cache;
  const pool = await getConnection();
  const result = await pool.request().query("SELECT [Key], [Value] FROM dbo.Settings");
  const settings = {};
  for (const { Key, Value } of result.recordset) {
    const meta = SETTINGS_META.find((m) => m.key === Key);
    settings[Key] = meta && (meta.type === "lookup" || meta.type === "number") && Value !== null && Value !== ""
      ? Number(Value)
      : Value;
  }
  cache = settings;
  cachedAt = Date.now();
  return settings;
}

async function saveSettings(values) {
  const pool = await getConnection();
  for (const [key, value] of Object.entries(values)) {
    await pool
      .request()
      .input("Key", sql.NVarChar(100), key)
      .input("Value", sql.NVarChar(4000), value === null || value === undefined ? null : String(value))
      .query(`
        UPDATE dbo.Settings SET [Value] = @Value WHERE [Key] = @Key;
        IF @@ROWCOUNT = 0 INSERT INTO dbo.Settings ([Key], [Value]) VALUES (@Key, @Value);
      `);
  }
  cache = undefined;
}

module.exports = { SETTINGS_META, getSettings, saveSettings };
