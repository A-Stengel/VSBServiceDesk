-- Step 12. Light and dark mode.
--
-- What this script does:
--   Adds dbo.Users.AppearanceMode: the mode each person picks from the menu
--   under their name ('light', 'dark' or 'auto' for Match device). Empty means
--   Match device. Saving it here makes their choice follow them to any
--   computer they sign in on.
--
-- The colors for each mode need no database change: Settings > Appearance
-- saves them as two rows in dbo.Settings (AppearanceLight and
-- AppearanceDark), which the app adds the first time an admin saves.
--
-- Step 11 is saved for the rental and event booking change. This script
-- doesn't depend on it, so it can run before or after it.
--
-- Safe to run again: it only adds the column when it isn't there yet.

IF COL_LENGTH('dbo.Users', 'AppearanceMode') IS NULL
    ALTER TABLE dbo.Users ADD AppearanceMode NVARCHAR(10) NULL
        CONSTRAINT CK_Users_AppearanceMode CHECK (AppearanceMode IN ('light', 'dark', 'auto'));
GO

SELECT COL_LENGTH('dbo.Users', 'AppearanceMode') AS AppearanceModeColumnBytes; -- 20 means it's there
GO
