const { app } = require("@azure/functions");
const { getConnection } = require("../shared/db");

app.http("getUsers", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "users",
  handler: async (request, context) => {
    try {
      const pool = await getConnection();

      const result = await pool.request().query(`
        SELECT
            u.UserId,
            u.FirstName,
            u.LastName,
            u.Email,
            d.DepartmentId,
            d.DepartmentName,
            ud.IsManager,
            ud.IsPrimaryDept
        FROM dbo.Users u
        INNER JOIN dbo.UserDepartments ud
            ON u.UserId = ud.UserId
        INNER JOIN dbo.Departments d
            ON ud.DepartmentId = d.DepartmentId
        ORDER BY u.LastName, u.FirstName, d.DepartmentName
      `);

      const rows = result.recordset;
      const usersMap = new Map();

      for (const row of rows) {
        if (!usersMap.has(row.UserId)) {
          usersMap.set(row.UserId, {
            userId: row.UserId,
            firstName: row.FirstName,
            lastName: row.LastName,
            email: row.Email,
            departments: []
          });
        }

        usersMap.get(row.UserId).departments.push({
          departmentId: row.DepartmentId,
          departmentName: row.DepartmentName,
          isManager: row.IsManager,
          isPrimaryDept: row.IsPrimaryDept
        });
      }

      return {
        status: 200,
        jsonBody: Array.from(usersMap.values())
      };
    } catch (error) {
      context.error(error);
      return {
        status: 500,
        jsonBody: { message: "Error loading users." }
      };
    }
  }
});