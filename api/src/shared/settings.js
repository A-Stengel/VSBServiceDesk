const { getConnection, sql } = require("./db");

// The automatic emails, each stored as a subject and a message setting.
// Placeholders: [Requester], [TicketNumber], [Subject], [Link], [DaysLeft],
// [Room], [When], [Description], [Changes].
const TEMPLATES = [
  { key: "Received", label: "Ticket received" },
  { key: "NewTicketAlert", label: "New ticket alert (IT team)" },
  { key: "ReplyAlert", label: "Requester replied (technician)" },
  { key: "Warning", label: "Waiting on you" },
  { key: "Closed", label: "Ticket closed" },
  { key: "Survey", label: "Satisfaction survey" },
  { key: "BookingRequest", label: "Room request (HR)" },
  { key: "BookingConfirmed", label: "Booking confirmed" },
  { key: "BookingDeclined", label: "Booking declined" },
  { key: "BookingChange", label: "Booking changed (HR and IT)" }
];

// On/Off switches. Each one is stored as "On" or "Off".
const switchMeta = (key, label, section) => ({ key, label, type: "switch", section });

// Every row in dbo.Settings the app knows about, how to edit it, and what it means.
// "lookup" settings store the Id of a row in that lookup table.
const SETTINGS_META = [
  { key: "AppName", label: "App name", type: "text", section: "organization" },
  { key: "OrganizationName", label: "Organization name", type: "text", section: "organization" },
  { key: "TimeZone", label: "Time zone", type: "timezone", section: "organization" },
  { key: "StaffEmailDomains", label: "Staff email domains (comma separated)", type: "text", section: "organization" },
  { key: "MailboxAddress", label: "Service desk mailbox", type: "email", section: "organization" },
  { key: "TestingMailboxAddress", label: "Testing mailbox", type: "email", section: "organization" },
  { key: "SiteUrl", label: "Web address of the app", type: "text", section: "organization" },
  switchMeta("StaffWebAccess", "Staff can use the web app", "access"),
  switchMeta("MaintenanceMode", "Maintenance mode", "access"),
  switchMeta("InCreateTickets", "Create tickets from new emails", "incoming"),
  switchMeta("InAddReplies", "Add replies to existing tickets", "incoming"),
  switchMeta("InCreateSenders", "Create accounts for new senders", "incoming"),
  switchMeta("InSaveAttachments", "Save attachments from emails", "incoming"),
  { key: "InProcessAfter", label: "Only read mail received after", type: "datetime", section: "incoming" },
  { key: "EmailTicketTypeId", label: "Ticket type for emailed tickets", type: "lookup", lookup: "ticketTypes", section: "incoming" },
  { key: "EmailSourceId", label: "Source for emailed tickets", type: "lookup", lookup: "sources", section: "incoming" },
  { key: "MaxEmailMB", label: "Largest email the mailbox sends or takes (MB)", type: "number", section: "incoming" },
  switchMeta("OutReceived", "Ticket received email to the requester", "outgoing"),
  switchMeta("OutNewTicketAlert", "New ticket alert to the IT team", "outgoing"),
  switchMeta("OutReply", "Technician replies to the requester", "outgoing"),
  switchMeta("OutHrReply", "HR replies to the requester", "outgoing"),
  switchMeta("OutRequesterReplyAlert", "Requester reply alert to the technician", "outgoing"),
  switchMeta("OutWarning", "Waiting on you warning", "outgoing"),
  switchMeta("OutClosed", "Ticket closed email", "outgoing"),
  switchMeta("OutSurvey", "Satisfaction survey", "outgoing"),
  switchMeta("OutBookingAlert", "Room request alert to HR", "outgoing"),
  switchMeta("OutBookingDecision", "Room confirmed and declined emails", "outgoing"),
  switchMeta("OutBookingChange", "Booking change alerts to HR and IT", "outgoing"),
  switchMeta("AutoClose", "Close tickets with no answer", "automations"),
  switchMeta("CalendarWrite", "Write room bookings to the events calendar", "automations"),
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
  { key: "WarningBusinessDays", label: "Business days before the warning email", type: "number", section: "automations" },
  { key: "CloseBusinessDays", label: "Business days before automatic close", type: "number", section: "automations" },
  { key: "MailboxCheckMinutes", label: "Minutes between mailbox checks", type: "number", section: "automations" },
  { key: "ITTeamEmails", label: "IT team notification emails (comma separated)", type: "text", section: "notifications" },
  { key: "ErrorAlertEmails", label: "Error alert recipients (comma separated)", type: "text", section: "notifications" },
  { key: "BookingPendingStatusId", label: "Status for new event bookings", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingConfirmedStatusId", label: "Status when an event manager confirms a booking", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingDeclinedStatusId", label: "Status when an event manager declines a booking", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingCancelledStatusId", label: "Status when a booking is cancelled", type: "lookup", lookup: "bookingStatuses" },
  { key: "BookingTicketTypeId", label: "Ticket type for rentals and event bookings", type: "lookup", lookup: "ticketTypes" },
  { key: "EventsCalendarAddress", label: "Events calendar address", type: "text", section: "automations" },
  { key: "EventGuidelines", label: "Event booking guidelines", type: "richtext" },
  { key: "HREmails", label: "HR notification emails (comma separated)", type: "text", section: "notifications" },
  ...TEMPLATES.flatMap((t) => [
    { key: `Template${t.key}Subject`, label: `${t.label}: subject`, type: "text", template: t.key },
    { key: `Template${t.key}Body`, label: `${t.label}: message`, type: "longtext", template: t.key }
  ])
];

const isOn = (settings, key) => settings[key] === "On";

// Comma or semicolon separated addresses from a setting, lower case.
const addressList = (value) => [...new Set(String(value || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")))];

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
      .input("Value", sql.NVarChar(sql.MAX), value === null || value === undefined ? null : String(value))
      .query(`
        UPDATE dbo.Settings SET [Value] = @Value WHERE [Key] = @Key;
        IF @@ROWCOUNT = 0 INSERT INTO dbo.Settings ([Key], [Value]) VALUES (@Key, @Value);
      `);
  }
  cache = undefined;
}

module.exports = { SETTINGS_META, TEMPLATES, getSettings, saveSettings, isOn, addressList };
