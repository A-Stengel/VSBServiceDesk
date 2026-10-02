const { endpoint } = require("../shared/endpoint");
const { getConnection } = require("../shared/db");
const { personName } = require("../shared/tickets");

// License spend: seats in use per software and what they cost, as a monthly
// and a yearly figure. Costs are for tracking only.
endpoint("licenseSummary", { methods: ["GET"], route: "licenses", role: "technician" }, async () => {
  const pool = await getConnection();
  const software = await pool.request().query(`
    SELECT s.Id, s.Name, s.CostPerSeat, b.Name AS BillingPeriodName, b.MonthsPerPeriod, s.SeatsPurchased,
           COUNT(la.Id) AS SeatsUsed,
           CAST(COALESCE(SUM(la.CostPerSeatAtTime / NULLIF(b.MonthsPerPeriod, 0)), 0) AS DECIMAL(12, 2)) AS MonthlyCost
    FROM dbo.Software s
    JOIN dbo.BillingPeriods b ON b.Id = s.BillingPeriodId
    LEFT JOIN dbo.LicenseAssignments la ON la.SoftwareId = s.Id AND la.RemovedAt IS NULL
    WHERE s.IsActive = 1
    GROUP BY s.Id, s.Name, s.CostPerSeat, b.Name, b.MonthsPerPeriod, s.SeatsPurchased, s.SortOrder
    ORDER BY s.SortOrder, s.Name
  `);
  const seats = await pool.request().query(`
    SELECT la.Id, la.SoftwareId, la.UserId, ${personName("u")} AS UserName, u.Email,
           la.CostPerSeatAtTime, la.AssignedAt, la.AssignedTicketId
    FROM dbo.LicenseAssignments la
    JOIN dbo.Users u ON u.Id = la.UserId
    WHERE la.RemovedAt IS NULL
    ORDER BY UserName
  `);
  const monthly = software.recordset.reduce((sum, s) => sum + Number(s.MonthlyCost), 0);
  return {
    jsonBody: {
      software: software.recordset,
      seats: seats.recordset,
      totals: { monthly: Math.round(monthly * 100) / 100, yearly: Math.round(monthly * 1200) / 100 }
    }
  };
});
