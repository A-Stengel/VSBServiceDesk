const sql = require("mssql");

const config = {
  connectionString: process.env.SQL_CONNECTION_STRING,
  options: {
    encrypt: true
  }
};

let pool;

async function getConnection() {
  if (pool) return pool;
  pool = await sql.connect(config);
  return pool;
}

module.exports = { sql, getConnection };