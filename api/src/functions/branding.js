const { app } = require("@azure/functions");
const { endpoint, readBodyWithFiles } = require("../shared/endpoint");
const { HttpError } = require("../shared/errors");
const { withTransaction } = require("../shared/db");
const { uploadFile, downloadWithProperties, deleteFile } = require("../shared/storage");
const { logChange } = require("../shared/changelog");

// The logo shown in the header, on the loading screen and in the browser tab.
// It lives in Blob Storage, not the database, so it still shows while the
// database is starting up. With no logo uploaded the site uses its built-in
// VSB seal.
const LOGO_PATH = "branding/logo";
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// Anyone signed in can fetch it (the Static Web App only lets signed-in people
// reach /api). It skips the user lookup so it doesn't wait on the database.
app.http("getLogo", {
  methods: ["GET"],
  route: "branding/logo",
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const logo = await downloadWithProperties(LOGO_PATH);
      if (!logo) return { status: 404, headers: { "Cache-Control": "no-cache" } };
      const headers = { "Cache-Control": "private, no-cache", ETag: logo.etag, "X-Content-Type-Options": "nosniff" };
      if (request.headers.get("if-none-match") === logo.etag) return { status: 304, headers };
      return { status: 200, body: logo.buffer, headers: { ...headers, "Content-Type": logo.contentType || "image/png" } };
    } catch (error) {
      context.error(error);
      return { status: 500, headers: { "Cache-Control": "no-cache" } };
    }
  }
});

endpoint(
  "uploadLogo",
  { methods: ["PUT"], route: "manage/logo", role: "admin", failMessage: "Could not save the logo" },
  async (request, context, user) => {
    const { files } = await readBodyWithFiles(request);
    const file = files[0];
    if (!file) throw new HttpError(400, "Choose an image file");
    if (!LOGO_TYPES.includes(file.type)) throw new HttpError(400, "The logo must be a PNG, JPG, WebP or GIF image");
    if (file.buffer.length > MAX_LOGO_BYTES) throw new HttpError(400, "The logo must be 2 MB or smaller");
    await uploadFile(LOGO_PATH, file.buffer, file.type);
    await withTransaction((tx) => logChange(tx, { area: "settings", section: "logo", actorId: user.Id, summary: `Uploaded a new logo (${file.name})` }));
    return { status: 204 };
  }
);

endpoint(
  "resetLogo",
  { methods: ["DELETE"], route: "manage/logo", role: "admin", failMessage: "Could not reset the logo" },
  async (request, context, user) => {
    await deleteFile(LOGO_PATH);
    await withTransaction((tx) => logChange(tx, { area: "settings", section: "logo", actorId: user.Id, summary: "Went back to the built-in VSB seal" }));
    return { status: 204 };
  }
);
