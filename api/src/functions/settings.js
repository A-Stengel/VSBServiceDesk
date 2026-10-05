const { endpoint, readJson } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction } = require("../shared/db");
const { SETTINGS_META, getSettings, saveSettings } = require("../shared/settings");
const { logChange, listChanges } = require("../shared/changelog");

// Which Settings section each setting's history belongs to.
function sectionOf(meta) {
  if (meta.template) return "templates";
  if (["ITTeamEmails", "HREmails"].includes(meta.key)) return "notifications";
  if (meta.key === "LowStockThreshold") return "lowStock";
  if (meta.key === "EventGuidelines") return "guidelines";
  return "general";
}

const shown = (meta, value) => {
  if (value === null || value === undefined || value === "") return "empty";
  if (meta.type === "longtext") return "new text";
  return String(value);
};

// Admin routes live under "manage/" because Azure Functions reserves routes
// that start with "admin".
endpoint("getSettings", { methods: ["GET"], route: "manage/settings", role: "admin" }, async () => {
  return { jsonBody: { meta: SETTINGS_META, values: await getSettings() } };
});

endpoint(
  "saveSettings",
  { methods: ["PUT"], route: "manage/settings", role: "admin", failMessage: "Could not save the settings" },
  async (request, context, user) => {
    const body = await readJson(request);
    const before = await getSettings();
    const values = {};
    for (const meta of SETTINGS_META) {
      if (!(meta.key in body)) continue;
      let value = body[meta.key];
      if (value === "" || value === undefined) value = null;
      if (value !== null && (meta.type === "lookup" || meta.type === "number")) {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${meta.label} must be a whole number`);
        value = n;
      }
      if (value !== null && meta.type === "choice" && !meta.choices.includes(value)) {
        throw new HttpError(400, `${meta.label} must be one of: ${meta.choices.join(", ")}`);
      }
      if (value !== null && meta.type === "text") value = String(value).slice(0, 1000);
      if (value !== null && meta.type === "longtext") value = String(value).slice(0, 4000);
      if ((before[meta.key] ?? null) === value || String(before[meta.key] ?? "") === String(value ?? "")) continue;
      values[meta.key] = value;
    }
    await saveSettings(values);
    await withTransaction(async (tx) => {
      for (const [key, value] of Object.entries(values)) {
        const meta = SETTINGS_META.find((m) => m.key === key);
        await logChange(tx, {
          area: "settings",
          section: sectionOf(meta),
          actorId: user.Id,
          summary: meta.type === "longtext" ? `Changed ${meta.label}` : `${meta.label}: ${shown(meta, before[key])} to ${shown(meta, value)}`
        });
      }
    });
    return { jsonBody: { meta: SETTINGS_META, values: await getSettings() } };
  }
);

// One Settings section's history (?section=statuses, or a few joined with
// commas). Event Managers can read the sections they
// edit (rooms, room statuses and the booking guidelines).
const EVENT_MANAGER_SECTIONS = ["rooms", "bookingStatuses", "guidelines"];

endpoint("settingsHistory", { methods: ["GET"], route: "manage/history" }, async (request, context, user) => {
  const sections = (request.query.get("section") || "").split(",").map((s) => s.trim().slice(0, 50)).filter(Boolean).slice(0, 5);
  if (!sections.length) throw new HttpError(400, "Say which section");
  if (!user.IsAdmin && !(user.IsEventManager && sections.every((s) => EVENT_MANAGER_SECTIONS.includes(s)))) {
    throw new HttpError(403, "Only admins can do that");
  }
  const pool = await getConnection();
  return { jsonBody: await listChanges(pool, { area: "settings", section: sections, top: 50 }) };
});
