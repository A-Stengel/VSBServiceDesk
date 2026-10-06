const { endpoint, readJson } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { getConnection, withTransaction, sql } = require("../shared/db");
const { getSettings, saveSettings } = require("../shared/settings");
const { logChange } = require("../shared/changelog");

// Light and dark mode. Admins pick the colors for each mode (stored as JSON in
// dbo.Settings under AppearanceLight and AppearanceDark); everyone picks which
// mode they use (dbo.Users.AppearanceMode, added by script 12). Colors left
// unset use the built-in defaults in the site.
const COLOR_KEYS = ["head", "acc", "bg", "card", "text", "muted", "line"];
const COLOR_NAMES = {
  head: "Header bar",
  acc: "Buttons and links",
  bg: "Page background",
  card: "Panels",
  text: "Text",
  muted: "Secondary text",
  line: "Borders"
};
const MODES = ["light", "dark", "auto"];
const SETTING_KEY = { light: "AppearanceLight", dark: "AppearanceDark" };

function parseColors(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const colors = {};
    for (const key of COLOR_KEYS) if (/^#[0-9a-f]{6}$/.test(parsed?.[key])) colors[key] = parsed[key];
    return Object.keys(colors).length ? colors : null;
  } catch {
    return null;
  }
}

function cleanColors(input, label) {
  if (input === null) return null;
  if (typeof input !== "object") throw new HttpError(400, `Send the ${label} colors`);
  const colors = {};
  for (const key of COLOR_KEYS) {
    const value = String(input[key] || "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(value)) throw new HttpError(400, `${label}, ${COLOR_NAMES[key]}: use a color like #1d63a6`);
    colors[key] = value;
  }
  return colors;
}

// The person's own mode. Until script 12 has run the column doesn't exist, so
// everyone gets "Match device".
async function modeOf(userId) {
  try {
    const pool = await getConnection();
    const result = await pool.request().input("Id", sql.Int, userId).query("SELECT AppearanceMode FROM dbo.Users WHERE Id = @Id");
    return MODES.includes(result.recordset[0]?.AppearanceMode) ? result.recordset[0].AppearanceMode : "auto";
  } catch {
    return "auto";
  }
}

async function current() {
  const settings = await getSettings();
  return { light: parseColors(settings.AppearanceLight), dark: parseColors(settings.AppearanceDark) };
}

endpoint("getAppearance", { methods: ["GET"], route: "appearance" }, async (request, context, user) => {
  return { jsonBody: { ...(await current()), mode: await modeOf(user.Id) } };
});

endpoint(
  "saveMyAppearance",
  { methods: ["PUT"], route: "me/appearance", failMessage: "Could not save your choice" },
  async (request, context, user) => {
    const { mode } = await readJson(request);
    if (!MODES.includes(mode)) throw new HttpError(400, "Pick Light, Dark or Match device");
    const pool = await getConnection();
    try {
      await pool.request().input("Id", sql.Int, user.Id).input("Mode", sql.NVarChar(10), mode)
        .query("UPDATE dbo.Users SET AppearanceMode = @Mode WHERE Id = @Id");
    } catch (error) {
      context.error(error);
      throw new HttpError(503, "Your choice works on this computer, but it can't follow you to others until database script 12 is run");
    }
    return { jsonBody: { mode } };
  }
);

// Body: { light: {...7 colors} | null, dark: {...} | null }. null goes back to
// the built-in colors for that mode. A mode left out of the body is unchanged.
endpoint(
  "saveAppearance",
  { methods: ["PUT"], route: "manage/appearance", role: "admin", failMessage: "Could not save the colors" },
  async (request, context, user) => {
    const body = await readJson(request);
    const before = await current();
    const values = {};
    const lines = [];
    for (const mode of ["light", "dark"]) {
      if (!(mode in body)) continue;
      const label = mode === "light" ? "Light mode" : "Dark mode";
      const colors = cleanColors(body[mode], label);
      const old = before[mode];
      if (JSON.stringify(colors) === JSON.stringify(old)) continue;
      values[SETTING_KEY[mode]] = colors ? JSON.stringify(colors) : null;
      if (!colors) lines.push(`${label}: back to the built-in colors`);
      else {
        for (const key of COLOR_KEYS) {
          const was = old?.[key] || "built-in";
          if (was !== colors[key]) lines.push(`${label}, ${COLOR_NAMES[key]}: ${was} to ${colors[key]}`);
        }
      }
    }
    if (Object.keys(values).length) {
      await saveSettings(values);
      await withTransaction(async (tx) => {
        for (const summary of lines) await logChange(tx, { area: "settings", section: "appearance", actorId: user.Id, summary });
      });
    }
    return { jsonBody: { ...(await current()), mode: await modeOf(user.Id) } };
  }
);
