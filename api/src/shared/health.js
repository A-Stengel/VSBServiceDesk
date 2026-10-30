const { getConnection, sql } = require("./db");

// The background jobs' last run and whether each is failing, in
// dbo.SystemHealth: mailbox (reading mail), sending, timers and calendar.
// When a job starts failing, the people in "Error alert recipients" get one
// email; when it works again, one more. Never one per failure.

const JOB_NAMES = {
  mailbox: "Reading the mailbox",
  sending: "Sending email",
  timers: "The business day timers",
  calendar: "Writing to the events calendar"
};

async function readHealth(db, name) {
  const result = await db.request().input("Name", sql.NVarChar(50), name).query("SELECT * FROM dbo.SystemHealth WHERE Name = @Name");
  return result.recordset[0] || null;
}

async function upsert(db, name, sets, inputs = {}) {
  const request = db.request().input("Name", sql.NVarChar(50), name);
  for (const [key, [type, value]] of Object.entries(inputs)) request.input(key, type, value);
  await request.query(`
    IF NOT EXISTS (SELECT 1 FROM dbo.SystemHealth WHERE Name = @Name) INSERT INTO dbo.SystemHealth (Name) VALUES (@Name);
    UPDATE dbo.SystemHealth SET ${sets} WHERE Name = @Name;
  `);
}

// Saves the job's bookmark (see the table's Marker column).
async function setMarker(name, marker) {
  const pool = await getConnection();
  await upsert(pool, name, "Marker = @Marker", { Marker: [sql.NVarChar(100), marker] });
}

async function getMarker(name) {
  const pool = await getConnection();
  return (await readHealth(pool, name))?.Marker || null;
}

// Records that the job ran. Pass the error when it failed.
async function recordRun(name, error = null, context = console) {
  try {
    const pool = await getConnection();
    const before = await readHealth(pool, name);
    if (!error) {
      await upsert(pool, name, "LastRunAt = SYSUTCDATETIME(), LastSuccessAt = SYSUTCDATETIME(), IsFailing = 0");
      if (before?.IsFailing) await alert(name, null, context);
      return;
    }
    const message = String(error.message || error).slice(0, 1000);
    await upsert(pool, name, "LastRunAt = SYSUTCDATETIME(), LastErrorAt = SYSUTCDATETIME(), LastError = @Error, IsFailing = 1", {
      Error: [sql.NVarChar(1000), message]
    });
    if (!before?.IsFailing) {
      await alert(name, message, context);
      await upsert(pool, name, "AlertedAt = SYSUTCDATETIME()");
    }
  } catch (failed) {
    // Health is a side job: it must never break the work it watches.
    context.error?.(failed);
  }
}

async function alert(name, message, context) {
  // Loaded here, because the mailer records its own runs in this module.
  const { sendErrorAlert } = require("./mailer");
  try {
    await sendErrorAlert(JOB_NAMES[name] || name, message);
  } catch (failed) {
    context.error?.(failed);
  }
}

async function listHealth(db) {
  const result = await db.request().query("SELECT Name, LastRunAt, LastSuccessAt, LastErrorAt, LastError, IsFailing FROM dbo.SystemHealth ORDER BY Name");
  return result.recordset.filter((row) => JOB_NAMES[row.Name]).map((row) => ({ ...row, Label: JOB_NAMES[row.Name] }));
}

module.exports = { recordRun, setMarker, getMarker, listHealth, JOB_NAMES };
