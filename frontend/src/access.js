// Access a person can be given besides equipment and licenses: typed
// entries (shared mailboxes, calendars, phone lines), printers, and iMIS.

export const ACCESS_TEXT = { mailbox: "Shared mailbox", calendar: "Shared calendar", phone: "Phone queue or line" };

// The levels iMIS uses for each module. 7 isn't used in iMIS.
export const IMIS_LEVELS = [
  [0, "No Access"], [1, "Basic Display Only"], [2, "Reports"], [3, "Limited Entry/Edit"],
  [4, "Full Entry/Edit"], [5, "Table Maintenance"], [6, "Report Changes"], [8, "System Setup"]
];
