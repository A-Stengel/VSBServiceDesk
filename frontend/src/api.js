// Small wrapper around fetch for the /api routes. Errors carry the server's
// message so pages can show it, and the HTTP status (none when the request
// never reached the server).
async function request(method, path, body) {
  const isForm = body instanceof FormData;
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });
  if (response.status === 401) {
    // Never redirect from here: an automatic redirect on 401 is what caused
    // the sign-in loop. App.jsx shows a Sign in button instead.
    throw httpError(
      401,
      (await isSignedIn())
        ? "You're signed in, but the service desk API didn't accept the sign-in. " +
            "Check the API is published and linked to the Static Web App (README Steps 3 and 5)."
        : "You're not signed in. Reload the page and click Sign in."
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw httpError(response.status, data?.error || `Request failed (${response.status})`);
  return data;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function isSignedIn() {
  try {
    const me = await (await fetch("/.auth/me")).json();
    return !!me?.clientPrincipal;
  } catch {
    return false;
  }
}

function query(params) {
  const clean = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "");
  return clean.length ? "?" + new URLSearchParams(clean).toString() : "";
}

// JSON data plus files, sent as multipart ("data" + "files").
function withFiles(data, files) {
  const form = new FormData();
  form.append("data", JSON.stringify(data));
  for (const file of files || []) form.append("files", file);
  return form;
}

// "per month", "per year" or "per <period>" for a license's billing period.
export function perPeriod(period) {
  if (!period) return "";
  if (period.MonthsPerPeriod === 1) return "per month";
  if (period.MonthsPerPeriod === 12) return "per year";
  return `per ${String(period.Name).toLowerCase()}`;
}

export const api = {
  me: () => request("GET", "me"),
  home: () => request("GET", "home"),
  rentals: (filters = {}) => request("GET", "rentals" + query(filters)),

  views: (list) => request("GET", "views" + query({ list })),
  createView: (data) => request("POST", "views", data),
  updateView: (id, data) => request("PATCH", `views/${id}`, data),
  deleteView: (id) => request("DELETE", `views/${id}`),
  orderViews: (list, ids) => request("PUT", "views/order", { list, ids }),
  resetViews: (list) => request("POST", "views/reset", { list }),
  defaultTabs: (list, audience) => request("GET", "manage/default-tabs" + query({ list, audience })),
  saveDefaultTabs: (list, audience, tabs) => request("PUT", "manage/default-tabs", { list, audience, tabs }),
  setDepartmentTickets: (on) => request("PUT", "me/department-tickets", { on }),

  inventory: () => request("GET", "inventory"),
  addInventory: (kind, data) => request("POST", `inventory/${kind}`, data),
  updateInventory: (kind, id, data) => request("PATCH", `inventory/${kind}/${id}`, data),
  deleteInventory: (kind, id) => request("DELETE", `inventory/${kind}/${id}`),
  printing: () => request("GET", "printing"),
  addPrinting: (kind, data) => request("POST", `printing/${kind}`, data),
  updatePrinting: (kind, id, data) => request("PATCH", `printing/${kind}/${id}`, data),
  deletePrinting: (kind, id) => request("DELETE", `printing/${kind}/${id}`),

  onboardingDefaults: (jobTitleId) => request("GET", "onboarding/defaults" + query({ jobTitleId })),
  saveOnboardingDefaults: (data) => request("PUT", "manage/onboarding", data),
  addJobTitle: (data) => request("POST", "manage/job-titles", data),

  person: (id) => request("GET", `users/${id}`),
  assignHolding: (id, data) => request("POST", `users/${id}/holdings`, data),
  returnHolding: (id, data) => request("POST", `users/${id}/holdings/return`, data),

  createBooking: (data, files) => request("POST", "bookings", withFiles(data, files)),
  updateBooking: (id, data, files) => request("PATCH", `bookings/${id}`, withFiles(data, files)),
  bookingAction: (id, action, reason) => request("POST", `bookings/${id}/${action}`, { reason }),
  rooms: () => request("GET", "bookings/rooms"),
  createRoom: (data) => request("POST", "bookings/rooms", data),
  updateRoom: (id, data) => request("PATCH", `bookings/rooms/${id}`, data),
  saveGuidelines: (text) => request("PUT", "bookings/guidelines", { text }),
  lookups: () => request("GET", "lookups"),

  tickets: (filters = {}) => request("GET", "tickets" + query(filters)),
  ticket: (id) => request("GET", `tickets/${id}`),
  createTicket: (data, files) => request("POST", "tickets", withFiles(data, files)),
  updateTicket: (id, data) => request("PATCH", `tickets/${id}`, data),
  addConversation: (id, data, files) => request("POST", `tickets/${id}/conversations`, withFiles(data, files)),
  closeTicket: (id, data, files) => request("POST", `tickets/${id}/close`, withFiles(data, files)),
  mergeTicket: (id, intoId) => request("POST", `tickets/${id}/merge`, { intoId }),
  heldMail: () => request("GET", "mail/held"),
  acceptHeldMail: (id) => request("POST", `mail/held/${id}/accept`),
  dismissHeldMail: (id) => request("POST", `mail/held/${id}/dismiss`),
  emailStatus: () => request("GET", "manage/email-status"),
  survey: (token) => request("GET", `survey/${token}`),
  answerSurvey: (token, data) => request("POST", `survey/${token}`, data),
  addItem: (id, data) => request("POST", `tickets/${id}/items`, data),
  updateItem: (id, itemId, data) => request("PATCH", `tickets/${id}/items/${itemId}`, data),
  updateChecklist: (id, itemId, isDone) => request("PATCH", `tickets/${id}/checklist/${itemId}`, { isDone }),
  changeChecklistLine: (id, itemId, data) => request("PATCH", `tickets/${id}/checklist/${itemId}`, data),
  deleteChecklistLine: (id, itemId) => request("DELETE", `tickets/${id}/checklist/${itemId}`),
  addChecklistLine: (id, data) => request("POST", `tickets/${id}/checklist`, data),
  takeInk: (id, lineId) => request("POST", `tickets/${id}/ink/${lineId}/take`),
  undoTakeInk: (id, lineId) => request("DELETE", `tickets/${id}/ink/${lineId}/take`),
  holdings: (personId) => request("GET", `people/${personId}/holdings`),
  availability: (params) => request("GET", "inventory/availability" + query(params)),
  licenses: () => request("GET", "licenses"),

  users: (filters = {}) => request("GET", "users" + query(filters)),
  searchPeople: (q) => request("GET", "people/search" + query({ q })),
  createUser: (data) => request("POST", "users", data),
  updateUser: (id, data) => request("PATCH", `users/${id}`, data),

  adminLookup: (table) => request("GET", `manage/lookups/${table}`),
  adminCreateLookup: (table, data) => request("POST", `manage/lookups/${table}`, data),
  adminUpdateLookup: (table, id, data, quiet) => request("PATCH", `manage/lookups/${table}/${id}` + query({ quiet: quiet ? 1 : "" }), data),
  settingsHistory: (section) => request("GET", "manage/history" + query({ section })),
  saveTicketTypeFields: (typeId, categoryId, fields) =>
    request("PUT", `manage/ticket-type-fields/${typeId}` + query({ categoryId }), fields),
  settings: () => request("GET", "manage/settings"),
  saveSettings: (values) => request("PUT", "manage/settings", values),
  uploadLogo: (file) => request("PUT", "manage/logo", withFiles({}, [file])),
  resetLogo: () => request("DELETE", "manage/logo"),
  appearance: () => request("GET", "appearance"),
  saveMyAppearance: (mode) => request("PUT", "me/appearance", { mode }),
  saveAppearance: (colors) => request("PUT", "manage/appearance", colors)
};

export function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// DATE columns arrive as midnight UTC; show them without a time zone shift.
export function formatDay(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString(undefined, { timeZone: "UTC", dateStyle: "medium" });
}

// Booking times are the desk's local time sent as "2026-11-10T09:00"; show them as
// typed, with no time zone shift.
export function formatWall(value) {
  if (!value) return "";
  return new Date(`${value}:00Z`).toLocaleString(undefined, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" });
}

export function formatWallRange(start, end) {
  if (!start || !end) return "";
  const time = (v) => new Date(`${v}:00Z`).toLocaleTimeString(undefined, { timeZone: "UTC", timeStyle: "short" });
  return start.slice(0, 10) === end.slice(0, 10) ? `${formatWall(start)} to ${time(end)}` : `${formatWall(start)} to ${formatWall(end)}`;
}

export const dayValue = (value) => (value ? String(value).slice(0, 10) : "");

export const money = (value) =>
  Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });

// "30 minutes ago", "1 day ago", "2 months ago": how long ago, at any age.
// Used for Last activity in the lists, with the exact time on hover.
export function howLongAgo(value) {
  if (!value) return "";
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) {
    const n = Math.floor(seconds / size);
    if (n >= 1) return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return "Just now";
}

// "3 minutes ago", "Yesterday", or the date, for activity lists.
export function timeAgo(value) {
  if (!value) return "";
  const then = new Date(value);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { dateStyle: "medium" });
}
