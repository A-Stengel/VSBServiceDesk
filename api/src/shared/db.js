// One connection pool per Function App instance, signed in with Microsoft Entra ID.
// In Azure that's the Function App's managed identity; on your machine it's
// whoever is signed in to the Azure CLI or VS Code (DefaultAzureCredential).
const sql = require("mssql");

const config = {
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  authentication: {
    type: "azure-active-directory-default",
    options: process.env.AZURE_CLIENT_ID ? { clientId: process.env.AZURE_CLIENT_ID } : {}
  },
  // Long enough for the database to wake up or fail over; the Static Web App
  // gives the API about 45 seconds per request.
  connectionTimeout: 30000,
  options: {
    encrypt: true,
    trustServerCertificate: false
  },
  pool: { max: 10 }
};

let poolPromise;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A database that is waking up or failing over can refuse the first
// connection straight away ("not currently available"), so a quick refusal
// is tried once more after a short wait. A slow timeout isn't, to stay
// inside the Static Web App's time limit.
async function connect() {
  const started = Date.now();
  try {
    return await new sql.ConnectionPool(config).connect();
  } catch (error) {
    if (Date.now() - started > 10000) throw error;
    await wait(3000);
    return new sql.ConnectionPool(config).connect();
  }
}

function getConnection() {
  if (!poolPromise) {
    poolPromise = connect().catch((err) => {
      poolPromise = undefined; // allow a retry on the next request
      throw err;
    });
  }
  return poolPromise;
}

// Runs fn(transaction) inside a transaction, committing on success.
async function withTransaction(fn) {
  const pool = await getConnection();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const result = await fn(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    await transaction.rollback().catch(() => {}); // may already be rolled back by SQL
    throw error;
  }
}

module.exports = { sql, getConnection, withTransaction };
