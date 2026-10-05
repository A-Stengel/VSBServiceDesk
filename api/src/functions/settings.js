const { endpoint, readJson } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { SETTINGS_META, getSettings, saveSettings } = require("../shared/settings");

// Admin routes live under "manage/" because Azure Functions reserves routes
// that start with "admin".
endpoint("getSettings", { methods: ["GET"], route: "manage/settings", role: "admin" }, async () => {
  return { jsonBody: { meta: SETTINGS_META, values: await getSettings() } };
});

endpoint(
  "saveSettings",
  { methods: ["PUT"], route: "manage/settings", role: "admin", failMessage: "Could not save the settings" },
  async (request) => {
    const body = await readJson(request);
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
      values[meta.key] = value;
    }
    await saveSettings(values);
    return { jsonBody: { meta: SETTINGS_META, values: await getSettings() } };
  }
);
