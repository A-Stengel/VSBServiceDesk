const { app } = require("@azure/functions");
const { getCurrentUser } = require("./auth");
const { HttpError } = require("./errors");

// Registers an HTTP function that looks up the signed-in user, checks their
// role ("technician" or "admin" when given), turns HttpError into a clean JSON
// response, and logs anything else as a generic 500 so SQL errors never reach
// the browser.
function endpoint(name, { methods, route, role, failMessage }, handler) {
  app.http(name, {
    methods,
    route,
    authLevel: "anonymous", // the Static Web App handles sign-in in front of this
    handler: async (request, context) => {
      try {
        const user = await getCurrentUser(request);
        if (role === "technician" && !user.IsTechnician) throw new HttpError(403, "Only technicians can do that");
        if (role === "admin" && !user.IsAdmin) throw new HttpError(403, "Only admins can do that");
        return await handler(request, context, user);
      } catch (error) {
        if (error instanceof HttpError) {
          return { status: error.status, jsonBody: { error: error.message } };
        }
        context.error(error);
        return { status: 500, jsonBody: { error: failMessage || "Something went wrong" } };
      }
    }
  });
}

async function readJson(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;

// Reads either a JSON body, or a multipart form with a "data" JSON field and
// "files" file fields. Returns { data, files: [{ name, type, buffer }] }.
async function readBodyWithFiles(request) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.startsWith("multipart/form-data")) {
    return { data: await readJson(request), files: [] };
  }
  let form;
  try {
    form = await request.formData();
  } catch {
    throw new HttpError(400, "Could not read the uploaded form");
  }
  let data = {};
  try {
    data = JSON.parse(form.get("data") || "{}");
  } catch {
    throw new HttpError(400, "The form data must be valid JSON");
  }
  const uploads = form.getAll("files").filter((f) => f && typeof f === "object" && f.size > 0);
  if (uploads.length > MAX_FILES) throw new HttpError(400, `Attach at most ${MAX_FILES} files at a time`);
  const files = [];
  for (const file of uploads) {
    if (file.size > MAX_FILE_BYTES) throw new HttpError(400, `${file.name} is larger than 10 MB`);
    files.push({
      name: (file.name || "file").slice(-200),
      type: file.type || "application/octet-stream",
      buffer: Buffer.from(await file.arrayBuffer())
    });
  }
  return { data, files };
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `${field} must be a valid id`);
  return id;
}

function requiredId(value, field) {
  const id = optionalId(value, field);
  if (id === null) throw new HttpError(400, `${field} is required`);
  return id;
}

function optionalText(value, field, maxLength) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, `${field} must be text`);
  const text = value.trim();
  if (maxLength && text.length > maxLength) throw new HttpError(400, `${field} must be ${maxLength} characters or fewer`);
  return text || null;
}

function requiredText(value, field, maxLength) {
  const text = optionalText(value, field, maxLength);
  if (!text) throw new HttpError(400, `${field} is required`);
  return text;
}

// Accepts YYYY-MM-DD and returns it, or null when empty.
function optionalDate(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be a date`);
  }
  return value;
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function emailList(value, field) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  const emails = [...new Set(list.map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
  if (emails.length > 20) throw new HttpError(400, `${field} can have at most 20 addresses`);
  const bad = emails.find((e) => !EMAIL_PATTERN.test(e) || e.length > 320);
  if (bad) throw new HttpError(400, `${bad} is not a valid email address`);
  return emails;
}

const isUniqueViolation = (error) => error.number === 2627 || error.number === 2601;
const isForeignKeyViolation = (error) => error.number === 547;

module.exports = {
  endpoint,
  readJson,
  readBodyWithFiles,
  optionalId,
  requiredId,
  optionalText,
  requiredText,
  optionalDate,
  emailList,
  EMAIL_PATTERN,
  isUniqueViolation,
  isForeignKeyViolation
};
