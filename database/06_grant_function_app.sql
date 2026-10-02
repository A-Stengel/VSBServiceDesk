-- Step 6. Let the Function App read and write the database with its managed
-- identity (no password).
--
-- Run this AFTER creating the Function App and turning on its system-assigned
-- identity (README, "Create the Function App"). You must be signed in to the
-- database as the server's Microsoft Entra admin for CREATE USER ... FROM
-- EXTERNAL PROVIDER to work.
--
-- Replace func-vsb-servicedesk with your Function App's exact name.

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'func-vsb-servicedesk')
    CREATE USER [func-vsb-servicedesk] FROM EXTERNAL PROVIDER;
GO
ALTER ROLE db_datareader ADD MEMBER [func-vsb-servicedesk];
ALTER ROLE db_datawriter ADD MEMBER [func-vsb-servicedesk];
GO

PRINT 'Step 6 complete: the Function App can use the database.';
