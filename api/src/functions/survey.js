const { app } = require("@azure/functions");
const { getConnection, sql } = require("../shared/db");
const { getSettings } = require("../shared/settings");
const { formatNumber } = require("../shared/tickets");

// The satisfaction survey page. It works without signing in, because outside
// people get the survey too: staticwebapp.config.json lets anyone reach
// /api/survey/*, and the link's token (a random GUID, new on every close)
// is the only way in. One answer per link.

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findSurvey(token) {
  if (!TOKEN.test(token || "")) return null;
  const pool = await getConnection();
  const result = await pool.request().input("Token", sql.UniqueIdentifier, token).query(`
    SELECT s.TicketId, s.Rating, s.Comment, s.AnsweredAt, s.SentAt, t.Subject
    FROM dbo.Surveys s
    JOIN dbo.Tickets t ON t.Id = s.TicketId
    WHERE s.Token = @Token
  `);
  return result.recordset[0] || null;
}

const json = (status, body) => ({ status, jsonBody: body, headers: { "Cache-Control": "no-store" } });

app.http("survey", {
  methods: ["GET", "POST"],
  route: "survey/{token}",
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const survey = await findSurvey(request.params.token);
      if (!survey) return json(404, { error: "This survey link isn't valid any more." });
      const settings = await getSettings();
      const about = {
        ticketNumber: formatNumber(survey.TicketId),
        subject: survey.Subject,
        appName: settings.AppName || "Service Desk",
        organizationName: settings.OrganizationName || ""
      };
      // An answer from an earlier close doesn't count for this link
      const answered = !!survey.AnsweredAt && survey.AnsweredAt >= (survey.SentAt || survey.AnsweredAt);
      if (request.method === "GET") return json(200, { ...about, answered, rating: answered ? survey.Rating : null });

      if (answered) return json(409, { error: "Thanks, we already have your answer for this ticket." });
      let body;
      try {
        body = (await request.json()) ?? {};
      } catch {
        return json(400, { error: "Send a rating from 1 to 5" });
      }
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json(400, { error: "Pick a rating from 1 to 5" });
      const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";
      const pool = await getConnection();
      await pool.request()
        .input("Token", sql.UniqueIdentifier, request.params.token)
        .input("Rating", sql.TinyInt, rating)
        .input("Comment", sql.NVarChar(2000), comment || null)
        .query("UPDATE dbo.Surveys SET Rating = @Rating, Comment = @Comment, AnsweredAt = SYSUTCDATETIME() WHERE Token = @Token");
      return json(200, { ...about, answered: true, rating });
    } catch (error) {
      context.error(error);
      return json(500, { error: "Something went wrong. Please try again later." });
    }
  }
});
