const { sql } = require("./db");

// Clears someone's tabs so they get the default tabs again the next time they
// open each list (see functions/views.js). Used by Reset to defaults, and when
// someone's role changes to or from Technician or Event Manager. Leave list
// out to clear every list.
async function resetTabs(db, userId, list) {
  const req = db.request().input("Me", sql.Int, userId);
  const only = list ? " AND ListKey = @List" : "";
  if (list) req.input("List", sql.NVarChar(20), list);
  await req.query(`DELETE FROM dbo.SavedViews WHERE OwnerId = @Me${only}; DELETE FROM dbo.TabSetup WHERE UserId = @Me${only};`);
}

module.exports = { resetTabs };
