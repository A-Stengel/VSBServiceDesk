const { sql } = require("./db");
const { HttpError } = require("./errors");
const { getHoldings } = require("./holdings");
const { logChange } = require("./changelog");
const { assertTicketStock } = require("./inventory");

const personName = (alias) => `COALESCE(NULLIF(${alias}.DisplayName, ''), CONCAT(${alias}.FirstName, ' ', ${alias}.LastName))`;

// One ticket with the names of everything it points at.
const TICKET_SELECT = `
  SELECT t.Id, t.TicketTypeId, tt.Name AS TicketTypeName,
         tt.UsesDates, tt.UsesInventory, tt.UsesLicenses, tt.UsesChecklist, c.ChecklistSource,
         t.StatusId, s.Name AS StatusName, s.Color AS StatusColor, s.IsClosed, s.IsWaitingOnRequester,
         t.PriorityId, p.Name AS PriorityName, p.[Rank] AS PriorityRank,
         t.CategoryId, c.Name AS CategoryName,
         t.SubcategoryId, sc.Name AS SubcategoryName,
         t.SourceId, so.Name AS SourceName,
         t.RequesterId, ${personName("r")} AS RequesterName, r.Email AS RequesterEmail,
         t.ForUserId, CASE WHEN fu.Id IS NOT NULL THEN ${personName("fu")} END AS ForUserName,
         t.ForPersonName, t.ForDepartmentId, fd.Name AS ForDepartmentName,
         t.TechnicianId, CASE WHEN te.Id IS NOT NULL THEN ${personName("te")} END AS TechnicianName,
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

// Closing an Off Boarding ticket turns the person's account off (they can't
// sign in any more); closing an Onboarding ticket turns it back on. Both go in
// the person's history.
async function accountOnClose(tx, ticket, status, actorId, warnings = []) {
  if (!status.IsClosed || ticket.IsClosed || !ticket.ForUserId) return;
  const source = ticket.ChecklistSource;
  if (source !== "offboarding" && source !== "onboarding") return;
  const turnOn = source === "onboarding";
  if (!turnOn && ticket.ForUserId === actorId) {
    warnings.push("You can't turn off your own account, so it was left on.");
    return;
  }
  const person = (await tx.request().input("Id", sql.Int, ticket.ForUserId).query("SELECT IsActive FROM dbo.Users WHERE Id = @Id")).recordset[0];
  if (!person || !!person.IsActive === turnOn) return;
  if (!turnOn) {
    const held = await getHoldings(tx, ticket.ForUserId);
    const count = held.items.length + held.seats.length;
    if (count) warnings.push(`${ticket.ForUserName} still holds ${count} item${count === 1 ? "" : "s"} or seat${count === 1 ? "" : "s"}. Check their page.`);
  }
  await tx.request().input("Id", sql.Int, ticket.ForUserId).input("On", sql.Bit, turnOn)
    .query("UPDATE dbo.Users SET IsActive = @On WHERE Id = @Id");
  await logChange(tx, {
    area: "person",
    entityId: ticket.ForUserId,
    actorId,
    summary: `Account turned ${turnOn ? "on" : "off"}: ${turnOn ? "Onboarding" : "Off Boarding"} ${formatNumber(ticket.Id)} closed`
  });
}

// Returns any warnings from turning an account on or off.
async function setStatus(db, ticket, statusId, actorId) {
  const warnings = [];
  if (statusId === ticket.StatusId) return warnings;
  const status = await getStatus(db, statusId);
  await db
    .request()
    .input("Id", sql.Int, ticket.Id)
    .input("StatusId", sql.Int, statusId)
    .query(`UPDATE dbo.Tickets SET StatusId = @StatusId, UpdatedAt = SYSUTCDATETIME(), ${statusTimingSql(status)} WHERE Id = @Id`);
  await recordEvents(db, ticket.Id, actorId, [{ field: "Status", oldValue: ticket.StatusName, newValue: status.Name }]);
  // Reopening counts its equipment again, so there must be enough of it.
  if (ticket.IsClosed && !status.IsClosed) await assertTicketStock(db, ticket.Id);
  await accountOnClose(db, ticket, status, actorId, warnings);
  return warnings;
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
  recordEvents,
  accountOnClose
};
