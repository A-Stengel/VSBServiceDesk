const { sql } = require("./db");
const { HttpError } = require("./errors");

const personName = (alias) => `COALESCE(NULLIF(${alias}.DisplayName, ''), CONCAT(${alias}.FirstName, ' ', ${alias}.LastName))`;

// One ticket with the names of everything it points at.
const TICKET_SELECT = `
  SELECT t.Id, t.TicketTypeId, tt.Name AS TicketTypeName,
         tt.UsesDates, tt.UsesInventory, tt.UsesLicenses, tt.UsesChecklist, tt.ChecklistSource,
         t.StatusId, s.Name AS StatusName, s.Color AS StatusColor, s.IsClosed, s.IsWaitingOnRequester,
         t.PriorityId, p.Name AS PriorityName, p.[Rank] AS PriorityRank,
         t.CategoryId, c.Name AS CategoryName,
         t.SubcategoryId, sc.Name AS SubcategoryName,
         t.SourceId, so.Name AS SourceName,
         t.RequesterId, ${personName("r")} AS RequesterName, r.Email AS RequesterEmail,
         t.ForUserId, ${personName("fu")} AS ForUserName,
         t.ForPersonName, t.ForDepartmentId, fd.Name AS ForDepartmentName,
         t.TechnicianId, ${personName("te")} AS TechnicianName,
         t.DepartmentId, d.Name AS DepartmentName,
         t.Subject, t.Description, t.StartDate, t.EndDate,
         t.CreatedAt, t.UpdatedAt, t.WaitingSince, t.ClosedAt, t.LegacyId
  FROM dbo.Tickets t
  JOIN dbo.TicketTypes tt ON tt.Id = t.TicketTypeId
  JOIN dbo.Statuses s ON s.Id = t.StatusId
  JOIN dbo.Priorities p ON p.Id = t.PriorityId
  JOIN dbo.Sources so ON so.Id = t.SourceId
  JOIN dbo.Users r ON r.Id = t.RequesterId
  LEFT JOIN dbo.Categories c ON c.Id = t.CategoryId
  LEFT JOIN dbo.Subcategories sc ON sc.Id = t.SubcategoryId
  LEFT JOIN dbo.Users fu ON fu.Id = t.ForUserId
  LEFT JOIN dbo.Departments fd ON fd.Id = t.ForDepartmentId
  LEFT JOIN dbo.Users te ON te.Id = t.TechnicianId
  LEFT JOIN dbo.Departments d ON d.Id = t.DepartmentId
`;

// Ticket numbers are shown padded to 7 digits, like 0010000.
const formatNumber = (id) => String(id).padStart(7, "0");

function withNumber(ticket) {
  return { ...ticket, Number: formatNumber(ticket.Id) };
}

// Technicians see every ticket; everyone else sees tickets they asked for or
// that are for them.
function canSee(user, ticket) {
  return user.IsTechnician || ticket.RequesterId === user.Id || ticket.ForUserId === user.Id;
}

async function loadTicket(db, id) {
  const result = await db.request().input("Id", sql.Int, id).query(`${TICKET_SELECT} WHERE t.Id = @Id`);
  return result.recordset[0];
}

async function loadVisibleTicket(db, id, user) {
  const ticket = await loadTicket(db, id);
  if (!ticket || !canSee(user, ticket)) throw new HttpError(404, "Ticket not found");
  return ticket;
}

async function getStatus(db, statusId) {
  const result = await db
    .request()
    .input("Id", sql.Int, statusId)
    .query("SELECT Id, Name, IsClosed, IsWaitingOnRequester, IsActive FROM dbo.Statuses WHERE Id = @Id");
  if (!result.recordset[0]) throw new HttpError(400, "That status doesn't exist");
  return result.recordset[0];
}

// SQL fragments that keep the timing columns in step with a status change:
// a waiting status starts the 3/4 business day clock, anything else stops it;
// a closed status stamps ClosedAt, reopening clears it.
function statusTimingSql(status) {
  return [
    status.IsWaitingOnRequester ? "WaitingSince = SYSUTCDATETIME(), WarningSentAt = NULL" : "WaitingSince = NULL, WarningSentAt = NULL",
    status.IsClosed ? "ClosedAt = COALESCE(ClosedAt, SYSUTCDATETIME())" : "ClosedAt = NULL"
  ].join(", ");
}

async function setStatus(db, ticket, statusId, actorId) {
  if (statusId === ticket.StatusId) return;
  const status = await getStatus(db, statusId);
  await db
    .request()
    .input("Id", sql.Int, ticket.Id)
    .input("StatusId", sql.Int, statusId)
    .query(`UPDATE dbo.Tickets SET StatusId = @StatusId, UpdatedAt = SYSUTCDATETIME(), ${statusTimingSql(status)} WHERE Id = @Id`);
  await recordEvents(db, ticket.Id, actorId, [{ field: "Status", oldValue: ticket.StatusName, newValue: status.Name }]);
}

// Writes field-change history rows to dbo.TicketEvents.
async function recordEvents(db, ticketId, actorId, changes) {
  for (const change of changes) {
    await db
      .request()
      .input("TicketId", sql.Int, ticketId)
      .input("ActorId", sql.Int, actorId)
      .input("Field", sql.NVarChar(50), change.field)
      .input("OldValue", sql.NVarChar(400), change.oldValue == null ? null : String(change.oldValue).slice(0, 400))
      .input("NewValue", sql.NVarChar(400), change.newValue == null ? null : String(change.newValue).slice(0, 400))
      .query(`
        INSERT INTO dbo.TicketEvents (TicketId, ActorId, Field, OldValue, NewValue)
        VALUES (@TicketId, @ActorId, @Field, @OldValue, @NewValue)
      `);
  }
}

module.exports = {
  TICKET_SELECT,
  personName,
  formatNumber,
  withNumber,
  canSee,
  loadTicket,
  loadVisibleTicket,
  getStatus,
  statusTimingSql,
  setStatus,
  recordEvents
};
