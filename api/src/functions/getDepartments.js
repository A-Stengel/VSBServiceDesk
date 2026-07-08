const { app } = require("@azure/functions");
const { getConnection } = require("../shared/db");

app.http("getDepartments", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "departments",
  handler: async (request, context) => {
    try {
      const pool = await getConnection();
      const result = await pool.request().query(`
        SELECT DepartmentId, DepartmentName, IsActive
        FROM dbo.Departments
        ORDER BY DepartmentName
      `);

      return {
        status: 200,
        jsonBody: result.recordset
      };
    } catch (error) {
      context.error(error);
      return {
        status: 500,
        jsonBody: { message: "Error loading departments." }
      };
    }
  }
});