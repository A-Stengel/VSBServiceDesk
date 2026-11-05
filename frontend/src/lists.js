import { roleLabel } from "./pages/People.jsx";

// What each list can show, shared by the list pages and Settings > Default
// tabs. A tab's settings are { base, filters, sort }:
//
//   bases    [{ key, label, ... }]  what the tab loads (for example my open
//            tickets or the whole queue). Lists with one source have none.
//   filters  [{ key, label, options: [{ value, label }], test(row, value) }]
//   columns  { key: (row) => sort value }
//   search   (row) => the text the search box looks in
//   legacy   { old tab key: settings } for links and views saved before tabs
//            became personal (for example /tickets?tab=unassigned)
//
// ctx is { me, roles, lookups, technicians }.

const PEOPLE_KINDS = ["onboarding", "offboarding"];

export function ticketList({ me, roles, lookups, technicians = [] }) {
  const tech = !!roles.technician;
  const bases = [
    { key: "mineOpen", label: "My open tickets", scope: "mine", state: "open" },
    { key: "mineClosed", label: "My closed tickets", scope: "mine", state: "closed" },
    ...(tech
      ? [
          { key: "queueOpen", label: "Whole queue, open", scope: "queue", state: "open" },
          { key: "queueClosed", label: "Whole queue, closed", scope: "queue", state: "closed" },
          { key: "queueAll", label: "Whole queue, open and closed", scope: "queue", state: "all" }
        ]
      : [])
  ];
  const filters = [
    { key: "status", label: "Status", options: lookups.statuses.map((s) => ({ value: String(s.Id), label: s.Name })), test: (t, v) => t.StatusId === Number(v) },
    { key: "priority", label: "Priority", options: lookups.priorities.map((p) => ({ value: String(p.Id), label: p.Name })), test: (t, v) => t.PriorityId === Number(v) },
    ...(tech
      ? [{
          key: "assigned",
          label: "Assigned to",
          options: [
            { value: "me", label: "Me" },
            { value: "none", label: "Unassigned" },
            ...technicians.filter((t) => t.Id !== me?.Id).map((t) => ({ value: String(t.Id), label: t.DisplayName }))
          ],
          test: (t, v) => (v === "none" ? !t.TechnicianId : v === "me" ? t.TechnicianId === me?.Id : t.TechnicianId === Number(v))
        }]
      : []),
    { key: "type", label: "Type", options: lookups.ticketTypes.map((t) => ({ value: String(t.Id), label: t.Name })), test: (t, v) => t.TicketTypeId === Number(v) },
    { key: "waiting", label: "Waiting on requester", options: [{ value: "yes", label: "Only waiting on requester" }], test: (t) => !!t.IsWaitingOnRequester },
    ...(tech
      ? [{ key: "kind", label: "Onboarding and offboarding", options: [{ value: "people", label: "Only onboarding and offboarding" }], test: (t) => PEOPLE_KINDS.includes(t.ChecklistSource) }]
      : [])
  ];
  return {
    key: "tickets",
    bases,
    filters,
    columns: {
      number: (t) => t.Id,
      subject: (t) => t.Subject,
      type: (t) => t.TicketTypeName,
      assigned: (t) => t.TechnicianName || "",
      requester: (t) => t.RequesterName,
      status: (t) => t.StatusName,
      priority: (t) => t.PriorityRank,
      created: (t) => t.CreatedAt,
      activity: (t) => t.UpdatedAt,
      department: (t) => t.DepartmentName || ""
    },
    search: (t) => `${t.Number} ${t.Subject} ${t.RequesterName} ${t.RequesterEmail} ${t.ForUserName || ""} ${t.ForPersonName || ""}`,
    legacy: {
      mine: { base: "mineOpen", filters: {} },
      waitingOnMe: { base: "mineOpen", filters: { waiting: "yes" } },
      myClosed: { base: "mineClosed", filters: {} },
      all: { base: "queueOpen", filters: {} },
      unassigned: { base: "queueOpen", filters: { assigned: "none" } },
      assigned: { base: "queueOpen", filters: { assigned: "me" } },
      waiting: { base: "queueOpen", filters: { waiting: "yes" } },
      people: { base: "queueOpen", filters: { kind: "people" } },
      closed: { base: "queueClosed", filters: {} }
    }
  };
}

export function eventList({ roles, lookups }) {
  const equipment = !roles.eventManagerOnly;
  const stageName = (stage) => lookups.equipmentStatuses?.find((s) => s.Stage === stage)?.Name || stage;
  const pending = String(lookups.defaults.bookingPendingStatusId ?? "");
  const confirmed = String(lookups.defaults.bookingConfirmedStatusId ?? "");
  return {
    key: "events",
    bases: [
      { key: "upcoming", label: "Upcoming", when: "upcoming" },
      { key: "past", label: "Past", when: "past" },
      { key: "all", label: "Upcoming and past", when: "all" }
    ],
    filters: [
      { key: "room", label: "Room", options: lookups.rooms.map((r) => ({ value: r.Name, label: r.Name })), test: (r, v) => r.RoomName === v },
      { key: "roomStatus", label: "Room status", options: lookups.bookingStatuses.map((s) => ({ value: String(s.Id), label: s.Name })), test: (r, v) => r.BookingStatusId === Number(v) },
      ...(equipment
        ? [{
            key: "equipment",
            label: "Equipment status",
            options: [{ value: "none", label: "No equipment" }, ...["requested", "out", "returned"].map((stage) => ({ value: stage, label: stageName(stage) }))],
            test: (r, v) => r.EquipmentStage === v
          }]
        : [])
    ],
    columns: {
      title: (r) => r.Title,
      when: (r) => r.StartAt,
      room: (r) => r.RoomName || "",
      roomStatus: (r) => r.RoomStatusName || "",
      equipment: (r) => r.EquipmentStage,
      requester: (r) => r.RequesterName,
      activity: (r) => r.UpdatedAt
    },
    search: (r) => `${r.Title} ${r.RoomName || ""} ${r.RequesterName} ${r.Items || ""} ${r.TicketNumber || ""}`,
    legacy: {
      upcoming: { base: "upcoming", filters: {} },
      pending: { base: "upcoming", filters: { roomStatus: pending } },
      confirmed: { base: "upcoming", filters: { roomStatus: confirmed } },
      out: { base: "all", filters: { equipment: "out" } },
      past: { base: "past", filters: {} }
    }
  };
}

export function peopleList({ lookups }) {
  return {
    key: "people",
    bases: [],
    filters: [
      {
        key: "role",
        label: "Role",
        options: [...lookups.roles.map((r) => ({ value: r.Name, label: r.Name })), { value: "Email only", label: "Email only" }],
        test: (p, v) => roleLabel(p, lookups) === v
      },
      { key: "department", label: "Department", options: lookups.departments.map((d) => ({ value: String(d.Id), label: d.Name })), test: (p, v) => p.DepartmentId === Number(v) },
      { key: "type", label: "Account type", options: lookups.userTypes.map((t) => ({ value: String(t.Id), label: t.Name })), test: (p, v) => p.UserTypeId === Number(v) },
      { key: "status", label: "Status", options: [{ value: "on", label: "Active" }, { value: "off", label: "Off" }], test: (p, v) => (v === "on" ? p.IsActive : !p.IsActive) }
    ],
    columns: {
      name: (p) => p.DisplayName,
      email: (p) => p.Email,
      role: (p) => roleLabel(p, lookups),
      department: (p) => p.DepartmentName || "",
      type: (p) => p.UserTypeName,
      status: (p) => (p.IsActive ? 0 : 1)
    },
    search: (p) => `${p.DisplayName} ${p.Email} ${p.DepartmentName || ""}`,
    legacy: {
      active: { filters: { status: "on" } },
      all: { filters: {} },
      off: { filters: { status: "off" } }
    }
  };
}

// The role flags a group's default tabs are built for, in Settings.
export function rolesForAudience(audience) {
  const technician = audience === "technician";
  const eventManagerOnly = audience === "eventManager";
  return { technician, eventManagerOnly, worker: technician || eventManagerOnly, admin: false };
}

// A tab's settings in today's shape. Views saved before tabs became personal
// kept a built-in tab key ({ tab, search, filters, sort }); those become a
// base plus filters.
export function normalizeSettings(def, settings) {
  const s = settings || {};
  const legacy = s.tab && def.legacy[s.tab];
  const base = s.base || legacy?.base || def.bases[0]?.key || null;
  const filters = { ...(legacy?.filters || {}), ...(s.filters || {}) };
  for (const key of Object.keys(filters)) if (filters[key] === "" || filters[key] == null) delete filters[key];
  return { base: def.bases.some((b) => b.key === base) ? base : def.bases[0]?.key || null, filters, sort: s.sort || null };
}

// A short description of what a tab shows, for the tab editors.
export function describeSettings(def, settings) {
  const s = normalizeSettings(def, settings);
  const parts = [];
  const base = def.bases.find((b) => b.key === s.base);
  if (base) parts.push(base.label);
  for (const [key, value] of Object.entries(s.filters)) {
    const f = def.filters.find((x) => x.key === key);
    if (!f) continue;
    const option = f.options.find((o) => o.value === value);
    parts.push(f.options.length === 1 ? option?.label || f.label : `${f.label}: ${option?.label || value}`);
  }
  if (!parts.length) parts.push("Everything");
  return parts.join(" · ");
}
