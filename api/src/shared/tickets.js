const { sql } = require("./db");
const { HttpError } = require("./errors");
const { getHoldings } = require("./holdings");
const { logChange } = require("./changelog");
const { assertTicketStock } = require("./inventory");
const { toWall } = require("./clock");

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
         r.DepartmentId AS RequesterDepartmentId, fu.DepartmentId AS ForUserDepartmentId,
         (SELECT STRING_AGG(xc.Email, ',') FROM dbo.TicketCc xc WHERE xc.TicketId = t.Id) AS CcEmails,
         t.ForPersonName, t.ForDepartmentId, fd.Name AS ForDepartmentName,
         t.TechnicianId, CASE WHEN te.Id IS NOT NULL THEN ${personName("te")} END AS TechnicianName,
         t.DepartmentId, d.Name AS DepartmentName,
         t.Subject, t.Description, t.StartDate, t.EndDate, t.StartAt, t.EndAt,
         t.CreatedAt, t.UpdatedAt, t.WaitingSince, t.ClosedAt, t.LegacyId, t.MergedIntoId,
         CAST(CASE WHEN tr.TicketId IS NOT NULL THEN 1 ELSE 0 END AS BIT) AS HasRoom,
         CAST(CASE WHEN EXISTS (SELECT 1 FROM dbo.TicketItems ti WHERE ti.TicketId = t.Id) THEN 1 ELSE 0 END AS BIT) AS HasEquipment,
         tr.RoomId, rm.Name AS RoomName, tr.AttendeeCount, tr.Refreshments, tr.Foia, tr.LunchCatered,
         tr.BookingStatusId, bs.Name AS RoomStatusName, bs.Color AS RoomStatusColor, bs.IsActiveBooking,
         tr.ConfirmedById, CASE WHEN cb.Id IS NOT NULL THEN ${personName("cb")} END AS ConfirmedByName, tr.ConfirmedAt
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
  LEFT JOIN dbo.TicketRooms tr ON tr.TicketId = t.Id
  LEFT JOIN dbo.Rooms rm ON rm.Id = tr.RoomId
  LEFT JOIN dbo.BookingStatuses bs ON bs.Id = tr.BookingStatusId
  LEFT JOIN dbo.Users cb ON cb.Id = tr.ConfirmedById
`;

// Tickets someone is on: they asked for it, it's for them, or they're CC'd.
// Needs @Me (their user id) and @MyEmail.
const MINE_SQL = `(t.RequesterId = @Me OR t.ForUserId = @Me
  OR EXISTS (SELECT 1 FROM dbo.TicketCc mc WHERE mc.TicketId = t.Id AND mc.Email = @MyEmail))`;

// Tickets of people in the departments a manager manages: the requester, the
// person it's for, or a new hire's department. Ids are numbers from the
// signed-in user, never from the request.
function departmentSql(ids) {
  const list = (ids || []).map(Number).filter(Number.isInteger);
  if (!list.length) return "1 = 0";
  const inList = list.join(",");
  return `(r.DepartmentId IN (${inList}) OR fu.DepartmentId IN (${inList}) OR t.ForDepartmentId IN (${inList}))`;
}

// A ticket with a room and no equipment is HR's alone: technicians' lists
// and counts leave it out (they can still open it).
const FOR_IT_SQL = `(NOT EXISTS (SELECT 1 FROM dbo.TicketRooms xr WHERE xr.TicketId = t.Id)
  OR EXISTS (SELECT 1 FROM dbo.TicketItems xi WHERE xi.TicketId = t.Id))`;

// History lines about the room and the event, the only ones Event Managers
// see.
const ROOM_FIELDS = [
  "Created", "Room requested", "Room status", "Reason", "Subject", "Starts", "Ends", "Room", "Attendee count",
  "Refreshments", "FOIA", "Lunch catered", "Comments", "Cancelled", "Closed automatically", "Calendar"
];

// Ticket numbers are shown padded to 7 digits, like 0010000.
const formatNumber = (id) => String(id).padStart(7, "0");

function withNumber(ticket) {
  return { ...ticket, Number: formatNumber(ticket.Id), StartAt: toWall(ticket.StartAt), EndAt: toWall(ticket.EndAt) };
}

// Is this person on the ticket: the requester, the person it's for, or CC'd.
function isOnTicket(user, ticket) {
  if (ticket.RequesterId === user.Id || ticket.ForUserId === user.Id) return true;
  const email = String(user.Email || "").toLowerCase();
  return !!email && String(ticket.CcEmails || "").toLowerCase().split(",").includes(email);
}

// Is the ticket from someone in a department this person manages.
function isDepartmentTicket(user, ticket) {
  const ids = user.ManagedDepartmentIds || [];
  return [ticket.RequesterDepartmentId, ticket.ForUserDepartmentId, ticket.ForDepartmentId].some((d) => d && ids.includes(d));
}

// What someone may see on a ticket. Technicians see everything. Anyone on
// the ticket (requester, the person it's for, or CC'd) and the managers of
// their department see it without notes, and can reply. Event Managers (HR)
// see tickets with a room, but only the room part: no equipment, no
// technician notes, and no status, priority or technician.
function accessOf(user, ticket) {
  const own = isOnTicket(user, ticket) || isDepartmentTicket(user, ticket);
  const hr = !!user.IsEventManager && !!ticket.HasRoom;
  return {
    see: !!user.IsTechnician || own || hr,
    equipment: !!user.IsTechnician || own,
    technicianNotes: !!user.IsTechnician,
    hrNotes: !!user.IsTechnician || hr,
    roomOnlyView: !user.IsTechnician && hr && !own,
    hr
  };
}

const canSee = (user, ticket) => accessOf(user, ticket).see;

// A ticket as this person may see it.
function forViewer(ticket, user) {
  const shaped = withNumber(ticket);
  const access = accessOf(user, ticket);
  if (!access.equipment) delete shaped.HasEquipment;
  if (access.roomOnlyView) {
    for (const key of ["StatusId", "StatusName", "StatusColor", "PriorityId", "PriorityName", "PriorityRank", "TechnicianId",
      "TechnicianName", "CategoryId", "CategoryName", "SubcategoryId", "SubcategoryName", "WaitingSince", "IsWaitingOnRequester"]) {
      delete shaped[key];
    }
  }
  return shaped;
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

// Writes history lines. Each one is activity on the ticket, so it also moves
// the ticket's UpdatedAt (shown as "Last activity" in the lists).
async function recordEvents(db, ticketId, actorId, changes) {
  if (!changes.length) return;
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
  await db.request().input("Id", sql.Int, ticketId).query("UPDATE dbo.Tickets SET UpdatedAt = SYSUTCDATETIME() WHERE Id = @Id");
}

module.exports = {
  TICKET_SELECT,
  FOR_IT_SQL,
  MINE_SQL,
  departmentSql,
  isOnTicket,
  isDepartmentTicket,
  ROOM_FIELDS,
  accessOf,
  forViewer,
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
