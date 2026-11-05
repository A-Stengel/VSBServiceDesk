-- Step 14. Person profile fields.
--
-- What this script does:
--   Adds two columns to dbo.Users so technicians can fill them in from the
--   Edit profile button on a person's page:
--     JobTitle  the person's job title
--     Phone     their phone number, stored as typed
--   Both are optional and start empty for everyone.
--
-- Run this BEFORE publishing the API from this change. The person page and
-- the People list read these columns, so they show an error until the
-- columns exist.
--
-- Safe to run again: each column is only added when it isn't there yet.

IF COL_LENGTH('dbo.Users', 'JobTitle') IS NULL
    ALTER TABLE dbo.Users ADD JobTitle NVARCHAR(150) NULL;
GO

IF COL_LENGTH('dbo.Users', 'Phone') IS NULL
    ALTER TABLE dbo.Users ADD Phone NVARCHAR(50) NULL;
GO

-- Both rows should show a number (the column size in bytes) when it worked.
SELECT COL_LENGTH('dbo.Users', 'JobTitle') AS JobTitleColumnBytes,
       COL_LENGTH('dbo.Users', 'Phone') AS PhoneColumnBytes;
GO
