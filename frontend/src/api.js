// Small wrapper around fetch for the /api routes. Errors carry the server's
// message so pages can show it.
async function request(method, path, body) {
  const isForm = body instanceof FormData;
  const response = await fetch(`/api/${path}`, {
    method,
    headers: body && !isForm ? { "Content-Type": "application/json" } : undefined,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined
  });
  if (response.status === 401) {
    // Only send people to Microsoft when they really aren't signed in. If the
    // site already has a sign-in but the API still says 401, redirecting again
    // would loop forever, so show the problem instead.
    if (!(await isSignedIn())) {
      window.location.href = "/.auth/login/aad?post_login_redirect_uri=" + encodeURIComponent(window.location.pathname);
      throw new Error("Please sign in");
    }
    throw new Error(
      "You're signed in, but the service desk API didn't accept the sign-in. " +
        "Check the API is published and linked to the Static Web App (README Steps 3 and 5)."
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
}

async function isSignedIn() {
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

export const api = {
  me: () => request("GET", "me"),
  lookups: () => request("GET", "lookups"),

  tickets: (filters = {}) => request("GET", "tickets" + query(filters)),
  ticket: (id) => request("GET", `tickets/${id}`),
  createTicket: (data, files) => request("POST", "tickets", withFiles(data, files)),
  updateTicket: (id, data) => request("PATCH", `tickets/${id}`, data),
  addConversation: (id, data, files) => request("POST", `tickets/${id}/conversations`, withFiles(data, files)),
  addItem: (id, data) => request("POST", `tickets/${id}/items`, data),
  updateItem: (id, itemId, data) => request("PATCH", `tickets/${id}/items/${itemId}`, data),
  updateChecklist: (id, itemId, isDone) => request("PATCH", `tickets/${id}/checklist/${itemId}`, { isDone }),
  availability: (params) => request("GET", "inventory/availability" + query(params)),
  licenses: () => request("GET", "licenses"),

  users: (filters = {}) => request("GET", "users" + query(filters)),
  searchPeople: (q) => request("GET", "people/search" + query({ q })),
  createUser: (data) => request("POST", "users", data),
  updateUser: (id, data) => request("PATCH", `users/${id}`, data),

  adminLookup: (table) => request("GET", `admin/lookups/${table}`),
  adminCreateLookup: (table, data) => request("POST", `admin/lookups/${table}`, data),
  adminUpdateLookup: (table, id, data) => request("PATCH", `admin/lookups/${table}/${id}`, data),
  saveTicketTypeFields: (typeId, fields) => request("PUT", `admin/ticket-type-fields/${typeId}`, fields),
  settings: () => request("GET", "admin/settings"),
  saveSettings: (values) => request("PUT", "admin/settings", values)
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

export const dayValue = (value) => (value ? String(value).slice(0, 10) : "");

export const money = (value) =>
  Number(value || 0).toLocaleString(undefined, { style: "currency", currency: "USD" });
