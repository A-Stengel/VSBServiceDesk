-- Step 1. Prepare your existing tables.
--
-- Part A renames the key columns of dbo.Users and dbo.Departments to the
-- Id / Name convention every table in the app uses:
--   Users.UserId               -> Users.Id
--   Departments.DepartmentId   -> Departments.Id
--   Departments.DepartmentName -> Departments.Name
-- Foreign keys (for example from dbo.UserDepartments) keep working after a
-- rename. The old getUsers and getDepartments functions in the repo use the
-- old names; the MVP replaces them.
--
-- Part B removes what the FIRST zip (servicedesk-app.zip) created, if you ran
-- it: dbo.Tickets, dbo.TicketComments and a text Users.Role column.
--
-- Each statement only runs when needed, so this script is safe to re-run.

------------------------------------------------------------------------------
-- Part A. Rename key columns
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Users', 'UserId') IS NOT NULL AND COL_LENGTH('dbo.Users', 'Id') IS NULL
    EXEC sp_rename 'dbo.Users.UserId', 'Id', 'COLUMN';
GO
IF COL_LENGTH('dbo.Departments', 'DepartmentId') IS NOT NULL AND COL_LENGTH('dbo.Departments', 'Id') IS NULL
    EXEC sp_rename 'dbo.Departments.DepartmentId', 'Id', 'COLUMN';
GO
IF COL_LENGTH('dbo.Departments', 'DepartmentName') IS NOT NULL AND COL_LENGTH('dbo.Departments', 'Name') IS NULL
    EXEC sp_rename 'dbo.Departments.DepartmentName', 'Name', 'COLUMN';
GO

------------------------------------------------------------------------------
-- Part B. Remove the first MVP's objects
------------------------------------------------------------------------------

IF OBJECT_ID('dbo.TicketComments', 'U') IS NOT NULL
    DROP TABLE dbo.TicketComments;
GO

-- Only drop dbo.Tickets if it is the old shape (no TicketTypeId column)
IF OBJECT_ID('dbo.Tickets', 'U') IS NOT NULL AND COL_LENGTH('dbo.Tickets', 'TicketTypeId') IS NULL
    DROP TABLE dbo.Tickets;
GO

IF OBJECT_ID('dbo.CK_Users_Role', 'C') IS NOT NULL
    ALTER TABLE dbo.Users DROP CONSTRAINT CK_Users_Role;
GO
IF OBJECT_ID('dbo.DF_Users_Role', 'D') IS NOT NULL
    ALTER TABLE dbo.Users DROP CONSTRAINT DF_Users_Role;
GO
IF COL_LENGTH('dbo.Users', 'Role') IS NOT NULL
    ALTER TABLE dbo.Users DROP COLUMN Role;
GO

PRINT 'Step 1 complete: existing tables prepared.';
