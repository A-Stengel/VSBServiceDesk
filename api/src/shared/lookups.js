// The tables an admin can edit on the Settings page, and their columns.
// Only tables listed here can be read or changed through the admin lookup
// endpoints, and only the listed columns, so table and column names are never
// taken from the request.
//
// Column types: string, int, bit, decimal, date, ref (an Id in another
// lookup), choice (one of a fixed list).

const common = [
  { name: "Name", label: "Name", type: "string", max: 100, required: true },
  { name: "SortOrder", label: "Sort order", type: "int" },
  { name: "IsActive", label: "Active", type: "bit", default: true }
];

const LOOKUPS = {
  statuses: {
    table: "dbo.Statuses",
    label: "Statuses",
    columns: [
      ...common,
      { name: "IsClosed", label: "Counts as closed", type: "bit" },
      { name: "IsWaitingOnRequester", label: "Waiting on requester", type: "bit" },
      { name: "Color", label: "Row color", type: "string", max: 20 }
    ]
  },
  priorities: {
    table: "dbo.Priorities",
    label: "Priorities",
    columns: [...common, { name: "Rank", label: "Rank (1 = most urgent)", type: "int" }]
  },
  categories: {
    table: "dbo.Categories",
    label: "Categories",
    columns: [
      { name: "TicketTypeId", label: "Ticket type", type: "ref", ref: "ticketTypes", required: true },
      ...common,
      { name: "ChecklistSource", label: "Checklist", type: "choice", choices: ["onboarding", "change", "offboarding"] }
    ]
  },
  subcategories: {
    table: "dbo.Subcategories",
    label: "Subcategories",
    columns: [
      { name: "CategoryId", label: "Category", type: "ref", ref: "categories", required: true },
      ...common,
      { name: "AsksForInk", label: "Asks which printer and ink", type: "bit" }
    ]
  },
  sources: { table: "dbo.Sources", label: "Sources", columns: common },
  ticketTypes: {
    table: "dbo.TicketTypes",
    label: "Ticket types",
    columns: [
      ...common,
      { name: "UsesDates", label: "Uses dates", type: "bit" },
      { name: "UsesInventory", label: "Uses inventory", type: "bit" },
      { name: "UsesLicenses", label: "Uses licenses", type: "bit" },
      { name: "UsesChecklist", label: "Uses checklist", type: "bit" }
    ]
  },
  departments: {
    table: "dbo.Departments",
    label: "Departments",
    columns: [...common, { name: "Code", label: "Code", type: "string", max: 20 }]
  },
  holidays: {
    table: "dbo.Holidays",
    label: "Holidays",
    order: "HolidayDate",
    columns: [
      { name: "HolidayDate", label: "Date", type: "date", required: true },
      { name: "Name", label: "Name", type: "string", max: 100, required: true },
      { name: "IsActive", label: "Active", type: "bit", default: true }
    ]
  },
  userTypes: { table: "dbo.UserTypes", label: "User types", columns: common },
  roles: {
    table: "dbo.Roles",
    label: "Roles",
    columns: [
      ...common,
      { name: "IsTechnician", label: "Technician", type: "bit" },
      { name: "IsAdmin", label: "Admin", type: "bit" },
      { name: "IsEventManager", label: "Event manager", type: "bit" }
    ]
  },
  bookingStatuses: {
    table: "dbo.BookingStatuses",
    label: "Room statuses",
    eventManagers: true,
    columns: [
      ...common,
      { name: "IsActiveBooking", label: "Room is in use", type: "bit", default: true },
      { name: "Color", label: "Row color", type: "string", max: 20 }
    ]
  },
  // Event Managers edit rooms and room statuses as well as admins
  rooms: { table: "dbo.Rooms", label: "Rooms", eventManagers: true, columns: common },
  // The equipment part of a rental. Stage is fixed, so only the name and
  // color can change.
  equipmentStatuses: {
    table: "dbo.EquipmentStatuses",
    label: "Equipment statuses",
    noAdd: true,
    columns: [
      common[0],
      { name: "Stage", label: "Stage", type: "string", readOnly: true },
      common[1],
      { name: "Color", label: "Color", type: "string", max: 20 }
    ]
  },
  billingPeriods: {
    table: "dbo.BillingPeriods",
    label: "Billing periods",
    columns: [...common, { name: "MonthsPerPeriod", label: "Months per period", type: "int", required: true }]
  },
  inventoryItems: {
    table: "dbo.InventoryItems",
    label: "Inventory items",
    columns: [
      { ...common[0], max: 150 },
      { name: "UnitCost", label: "Unit cost ($)", type: "decimal" },
      { name: "QuantityOwned", label: "Quantity owned", type: "int" },
      common[1],
      common[2]
    ]
  },
  software: {
    table: "dbo.Software",
    label: "Software",
    columns: [
      { ...common[0], max: 150 },
      { name: "CostPerSeat", label: "Cost per seat ($)", type: "decimal" },
      { name: "BillingPeriodId", label: "Billed", type: "ref", ref: "billingPeriods", required: true },
      { name: "SeatsPurchased", label: "Seats purchased", type: "int" },
      { name: "ApplicationId", label: "Software it's for", type: "ref", ref: "applications" },
      { name: "ImisAccess", label: "iMIS access", type: "choice", choices: ["read", "edit"] },
      common[1],
      common[2]
    ]
  },
  // The friendly software names on the Onboarding form. Licenses (above)
  // say which one they belong to.
  applications: {
    table: "dbo.Applications",
    label: "Software",
    columns: [
      common[0],
      { name: "Description", label: "Description (shown on the form)", type: "string", max: 200 },
      { name: "IsImis", label: "iMIS (technicians set module levels, roles and groups)", type: "bit" },
      common[1],
      common[2]
    ]
  },
  imisModules: { table: "dbo.ImisModules", label: "iMIS modules", columns: common },
  imisRoles: { table: "dbo.ImisRoles", label: "iMIS roles", columns: common },
  imisGroups: { table: "dbo.ImisGroups", label: "iMIS security groups", columns: common },
  // Each department's job titles, for onboarding defaults
  jobTitles: {
    table: "dbo.JobTitles",
    label: "Job titles",
    columns: [
      { name: "DepartmentId", label: "Department", type: "ref", ref: "departments", required: true },
      { ...common[0], max: 150 },
      common[1],
      common[2]
    ]
  }
};

// The optional fields a ticket type's form can show (dbo.TicketTypeFields.FieldKey).
const FIELD_KEYS = ["category", "subcategory", "startDate", "endDate", "items", "forUser", "software", "newHire", "removals"];

function orderBy(def) {
  return def.order || (def.columns.some((c) => c.name === "SortOrder") ? "SortOrder, Name" : "Name");
}

function columnList(def) {
  return ["Id", ...def.columns.map((c) => c.name)].map((c) => `[${c}]`).join(", ");
}

module.exports = { LOOKUPS, FIELD_KEYS, orderBy, columnList };
