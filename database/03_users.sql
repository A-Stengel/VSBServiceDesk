-- Step 3. Reshape your existing dbo.Users table and add department managers.
--
-- dbo.Users becomes the app's own user list: staff, outside people who email
-- in, and shared mailboxes. Each person has ONE department (Users.DepartmentId).
-- Managers can be linked to several departments (dbo.DepartmentManagers).
--
-- Idempotent: every change only runs if it hasn't been made yet.

------------------------------------------------------------------------------
-- New columns on dbo.Users
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Users', 'DisplayName') IS NULL
    ALTER TABLE dbo.Users ADD DisplayName NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.Users', 'UserTypeId') IS NULL
    ALTER TABLE dbo.Users ADD UserTypeId INT NULL
        CONSTRAINT FK_Users_UserTypes REFERENCES dbo.UserTypes (Id);
GO
IF COL_LENGTH('dbo.Users', 'RoleId') IS NULL
    ALTER TABLE dbo.Users ADD RoleId INT NULL
        CONSTRAINT FK_Users_Roles REFERENCES dbo.Roles (Id);
GO
IF COL_LENGTH('dbo.Users', 'DepartmentId') IS NULL
    ALTER TABLE dbo.Users ADD DepartmentId INT NULL
        CONSTRAINT FK_Users_Departments REFERENCES dbo.Departments (Id);
GO
IF COL_LENGTH('dbo.Users', 'IsActive') IS NULL
    ALTER TABLE dbo.Users ADD IsActive BIT NOT NULL
        CONSTRAINT DF_Users_IsActive DEFAULT (1) WITH VALUES;
GO
IF COL_LENGTH('dbo.Users', 'CreatedAt') IS NULL
    ALTER TABLE dbo.Users ADD CreatedAt DATETIME2(0) NOT NULL
        CONSTRAINT DF_Users_CreatedAt DEFAULT (SYSUTCDATETIME()) WITH VALUES;
GO

-- Existing rows become Staff with the Requester role
UPDATE dbo.Users
SET UserTypeId = (SELECT Id FROM dbo.UserTypes WHERE Name = N'Staff')
WHERE UserTypeId IS NULL;
UPDATE dbo.Users
SET RoleId = (SELECT Id FROM dbo.Roles WHERE Name = N'Requester')
WHERE RoleId IS NULL;
GO

-- Emails are stored lower case so look-ups match regardless of how people type them
UPDATE dbo.Users SET Email = LOWER(LTRIM(RTRIM(Email)))
WHERE Email COLLATE Latin1_General_BIN <> LOWER(LTRIM(RTRIM(Email)));
GO

------------------------------------------------------------------------------
-- One account per email address
------------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_Users_Email' AND object_id = OBJECT_ID('dbo.Users'))
BEGIN
    IF EXISTS (SELECT Email FROM dbo.Users GROUP BY Email HAVING COUNT(*) > 1)
        PRINT 'WARNING: dbo.Users has duplicate emails. Remove the duplicates, then run this script again.';
    ELSE IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name = 'Email' AND max_length = -1)
        PRINT 'WARNING: Users.Email is NVARCHAR(MAX), which cannot be indexed. Change it to NVARCHAR(320), then run this script again.';
    ELSE
        CREATE UNIQUE INDEX UQ_Users_Email ON dbo.Users (Email);
END
GO

------------------------------------------------------------------------------
-- Department managers (a manager can manage several departments)
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.DepartmentManagers', 'U') IS NULL
    CREATE TABLE dbo.DepartmentManagers (
        UserId       INT NOT NULL CONSTRAINT FK_DepartmentManagers_Users REFERENCES dbo.Users (Id),
        DepartmentId INT NOT NULL CONSTRAINT FK_DepartmentManagers_Departments REFERENCES dbo.Departments (Id),
        CONSTRAINT PK_DepartmentManagers PRIMARY KEY (UserId, DepartmentId)
    );
GO

------------------------------------------------------------------------------
-- Old dbo.UserDepartments: copy each person's department onto
-- Users.DepartmentId (their primary department when IsPrimaryDept is set),
-- and copy rows marked IsManager into dbo.DepartmentManagers.
-- The old table is left in place; drop it yourself once you've checked the
-- result:
--   DROP TABLE dbo.UserDepartments;
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.UserDepartments', 'UserId') IS NOT NULL
   AND COL_LENGTH('dbo.UserDepartments', 'DepartmentId') IS NOT NULL
BEGIN
    DECLARE @order NVARCHAR(100) =
        CASE WHEN COL_LENGTH('dbo.UserDepartments', 'IsPrimaryDept') IS NOT NULL
             THEN N'x.IsPrimaryDept DESC, x.DepartmentId' ELSE N'x.DepartmentId' END;
    DECLARE @copy NVARCHAR(MAX) = N'
        UPDATE u
        SET DepartmentId = ud.DepartmentId
        FROM dbo.Users u
        CROSS APPLY (SELECT TOP (1) x.DepartmentId FROM dbo.UserDepartments x
                     WHERE x.UserId = u.Id ORDER BY ' + @order + N') ud
        WHERE u.DepartmentId IS NULL;';
    EXEC sp_executesql @copy;

    IF COL_LENGTH('dbo.UserDepartments', 'IsManager') IS NOT NULL
        EXEC sp_executesql N'
            INSERT INTO dbo.DepartmentManagers (UserId, DepartmentId)
            SELECT DISTINCT x.UserId, x.DepartmentId
            FROM dbo.UserDepartments x
            WHERE x.IsManager = 1
              AND NOT EXISTS (SELECT 1 FROM dbo.DepartmentManagers m
                              WHERE m.UserId = x.UserId AND m.DepartmentId = x.DepartmentId);';
END
GO

PRINT 'Step 3 complete: users and departments ready.';
