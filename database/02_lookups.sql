-- Step 2. Lookup tables (the dimensions of the star schema) and their
-- starting values. Every pick-list in the app comes from one of these tables
-- and is edited on the Settings page.
--
-- Idempotent: tables are only created if missing, and starting values are only
-- added if a row with that name doesn't exist yet. Re-running never overwrites
-- your edits.

------------------------------------------------------------------------------
-- Statuses
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Statuses', 'U') IS NULL
    CREATE TABLE dbo.Statuses (
        Id                   INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Statuses PRIMARY KEY,
        Name                 NVARCHAR(100) NOT NULL CONSTRAINT UQ_Statuses_Name UNIQUE,
        SortOrder            INT NOT NULL CONSTRAINT DF_Statuses_SortOrder DEFAULT (0),
        IsActive             BIT NOT NULL CONSTRAINT DF_Statuses_IsActive DEFAULT (1),
        IsClosed             BIT NOT NULL CONSTRAINT DF_Statuses_IsClosed DEFAULT (0),
        IsWaitingOnRequester BIT NOT NULL CONSTRAINT DF_Statuses_IsWaiting DEFAULT (0),
        Color                NVARCHAR(20) NULL
    );
GO
INSERT INTO dbo.Statuses (Name, SortOrder, IsClosed, IsWaitingOnRequester, Color)
SELECT v.Name, v.SortOrder, v.IsClosed, v.IsWaiting, v.Color
FROM (VALUES
    (N'New',                    10, 0, 0, N'#dbeafe'),
    (N'Assigned',               20, 0, 0, N'#ffffff'),
    (N'In Progress',            30, 0, 0, N'#ede9fe'),
    (N'Awaiting User Response', 40, 0, 1, N'#c7d2fe'),
    (N'External Action Needed', 50, 0, 0, N'#f5d0fe'),
    (N'Closed',                 90, 1, 0, N'#e5e7eb')
) v (Name, SortOrder, IsClosed, IsWaiting, Color)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Statuses s WHERE s.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Priorities
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Priorities', 'U') IS NULL
    CREATE TABLE dbo.Priorities (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Priorities PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_Priorities_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_Priorities_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_Priorities_IsActive DEFAULT (1),
        [Rank]    INT NOT NULL CONSTRAINT DF_Priorities_Rank DEFAULT (0)
    );
GO
INSERT INTO dbo.Priorities (Name, SortOrder, [Rank])
SELECT v.Name, v.SortOrder, v.[Rank]
FROM (VALUES (N'Low', 10, 4), (N'Normal', 20, 3), (N'High', 30, 2), (N'Urgent', 40, 1)) v (Name, SortOrder, [Rank])
WHERE NOT EXISTS (SELECT 1 FROM dbo.Priorities p WHERE p.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Categories and Subcategories
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Categories', 'U') IS NULL
    CREATE TABLE dbo.Categories (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Categories PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_Categories_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_Categories_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_Categories_IsActive DEFAULT (1)
    );
GO
INSERT INTO dbo.Categories (Name, SortOrder)
SELECT v.Name, v.SortOrder
FROM (VALUES (N'Phone', 10), (N'Software/Application', 20), (N'iMIS', 30),
             (N'Printers/Copiers', 40), (N'Hardware', 50), (N'Other', 90)) v (Name, SortOrder)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Categories c WHERE c.Name = v.Name);
GO

IF OBJECT_ID('dbo.Subcategories', 'U') IS NULL
    CREATE TABLE dbo.Subcategories (
        Id         INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Subcategories PRIMARY KEY,
        CategoryId INT NOT NULL CONSTRAINT FK_Subcategories_Categories REFERENCES dbo.Categories (Id),
        Name       NVARCHAR(100) NOT NULL,
        SortOrder  INT NOT NULL CONSTRAINT DF_Subcategories_SortOrder DEFAULT (0),
        IsActive   BIT NOT NULL CONSTRAINT DF_Subcategories_IsActive DEFAULT (1),
        CONSTRAINT UQ_Subcategories_Name UNIQUE (CategoryId, Name)
    );
GO

------------------------------------------------------------------------------
-- Sources
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Sources', 'U') IS NULL
    CREATE TABLE dbo.Sources (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Sources PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_Sources_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_Sources_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_Sources_IsActive DEFAULT (1)
    );
GO
INSERT INTO dbo.Sources (Name, SortOrder)
SELECT v.Name, v.SortOrder
FROM (VALUES (N'Web', 10), (N'Email', 20), (N'Phone', 30), (N'Walk-up', 40), (N'Import', 90)) v (Name, SortOrder)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Sources s WHERE s.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Ticket types
-- ChecklistSource: 'onboarding' builds the checklist from the onboarding
-- defaults, 'offboarding' from what the person currently holds.
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.TicketTypes', 'U') IS NULL
    CREATE TABLE dbo.TicketTypes (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketTypes PRIMARY KEY,
        Name            NVARCHAR(100) NOT NULL CONSTRAINT UQ_TicketTypes_Name UNIQUE,
        SortOrder       INT NOT NULL CONSTRAINT DF_TicketTypes_SortOrder DEFAULT (0),
        IsActive        BIT NOT NULL CONSTRAINT DF_TicketTypes_IsActive DEFAULT (1),
        UsesDates       BIT NOT NULL CONSTRAINT DF_TicketTypes_UsesDates DEFAULT (0),
        UsesInventory   BIT NOT NULL CONSTRAINT DF_TicketTypes_UsesInventory DEFAULT (0),
        UsesLicenses    BIT NOT NULL CONSTRAINT DF_TicketTypes_UsesLicenses DEFAULT (0),
        UsesChecklist   BIT NOT NULL CONSTRAINT DF_TicketTypes_UsesChecklist DEFAULT (0),
        ChecklistSource NVARCHAR(20) NULL
            CONSTRAINT CK_TicketTypes_ChecklistSource CHECK (ChecklistSource IN ('onboarding', 'offboarding'))
    );
GO
INSERT INTO dbo.TicketTypes (Name, SortOrder, UsesDates, UsesInventory, UsesLicenses, UsesChecklist, ChecklistSource)
SELECT v.Name, v.SortOrder, v.UsesDates, v.UsesInventory, v.UsesLicenses, v.UsesChecklist, v.ChecklistSource
FROM (VALUES
    (N'Support',                10, 0, 0, 0, 0, NULL),
    (N'Equipment Rental',       20, 1, 1, 0, 0, NULL),
    (N'Event Booking',          30, 1, 1, 0, 0, NULL),
    (N'Equipment Provisioning', 40, 0, 1, 0, 0, NULL),
    (N'Access Request',         50, 0, 0, 1, 1, NULL),
    (N'Onboarding',             60, 1, 1, 1, 1, N'onboarding'),
    (N'Offboarding',            70, 1, 1, 1, 1, N'offboarding')
) v (Name, SortOrder, UsesDates, UsesInventory, UsesLicenses, UsesChecklist, ChecklistSource)
WHERE NOT EXISTS (SELECT 1 FROM dbo.TicketTypes t WHERE t.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Departments (your existing table): add Code, SortOrder, IsActive
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Departments', 'Code') IS NULL
    ALTER TABLE dbo.Departments ADD Code NVARCHAR(20) NULL;
GO
IF COL_LENGTH('dbo.Departments', 'SortOrder') IS NULL
    ALTER TABLE dbo.Departments ADD SortOrder INT NOT NULL CONSTRAINT DF_Departments_SortOrder DEFAULT (0) WITH VALUES;
GO
IF COL_LENGTH('dbo.Departments', 'IsActive') IS NULL
    ALTER TABLE dbo.Departments ADD IsActive BIT NOT NULL CONSTRAINT DF_Departments_IsActive DEFAULT (1) WITH VALUES;
GO

------------------------------------------------------------------------------
-- Holidays (skipped when counting business days)
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Holidays', 'U') IS NULL
    CREATE TABLE dbo.Holidays (
        Id          INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Holidays PRIMARY KEY,
        HolidayDate DATE NOT NULL CONSTRAINT UQ_Holidays_Date UNIQUE,
        Name        NVARCHAR(100) NOT NULL,
        IsActive    BIT NOT NULL CONSTRAINT DF_Holidays_IsActive DEFAULT (1)
    );
GO

------------------------------------------------------------------------------
-- User types
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.UserTypes', 'U') IS NULL
    CREATE TABLE dbo.UserTypes (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_UserTypes PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_UserTypes_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_UserTypes_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_UserTypes_IsActive DEFAULT (1)
    );
GO
INSERT INTO dbo.UserTypes (Name, SortOrder)
SELECT v.Name, v.SortOrder
FROM (VALUES (N'Staff', 10), (N'External', 20), (N'Shared Mailbox', 30)) v (Name, SortOrder)
WHERE NOT EXISTS (SELECT 1 FROM dbo.UserTypes u WHERE u.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Roles. The app decides what someone can do from the two flags, so roles
-- can be renamed freely.
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Roles', 'U') IS NULL
    CREATE TABLE dbo.Roles (
        Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Roles PRIMARY KEY,
        Name         NVARCHAR(100) NOT NULL CONSTRAINT UQ_Roles_Name UNIQUE,
        SortOrder    INT NOT NULL CONSTRAINT DF_Roles_SortOrder DEFAULT (0),
        IsActive     BIT NOT NULL CONSTRAINT DF_Roles_IsActive DEFAULT (1),
        IsTechnician BIT NOT NULL CONSTRAINT DF_Roles_IsTechnician DEFAULT (0),
        IsAdmin      BIT NOT NULL CONSTRAINT DF_Roles_IsAdmin DEFAULT (0)
    );
GO
INSERT INTO dbo.Roles (Name, SortOrder, IsTechnician, IsAdmin)
SELECT v.Name, v.SortOrder, v.IsTechnician, v.IsAdmin
FROM (VALUES (N'Requester', 10, 0, 0), (N'Technician', 20, 1, 0), (N'Admin', 30, 1, 1)) v (Name, SortOrder, IsTechnician, IsAdmin)
WHERE NOT EXISTS (SELECT 1 FROM dbo.Roles r WHERE r.Name = v.Name);
GO

------------------------------------------------------------------------------
-- Billing periods (for software licenses)
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BillingPeriods', 'U') IS NULL
    CREATE TABLE dbo.BillingPeriods (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_BillingPeriods PRIMARY KEY,
        Name            NVARCHAR(100) NOT NULL CONSTRAINT UQ_BillingPeriods_Name UNIQUE,
        SortOrder       INT NOT NULL CONSTRAINT DF_BillingPeriods_SortOrder DEFAULT (0),
        IsActive        BIT NOT NULL CONSTRAINT DF_BillingPeriods_IsActive DEFAULT (1),
        MonthsPerPeriod INT NOT NULL CONSTRAINT DF_BillingPeriods_Months DEFAULT (1)
    );
GO
INSERT INTO dbo.BillingPeriods (Name, SortOrder, MonthsPerPeriod)
SELECT v.Name, v.SortOrder, v.Months
FROM (VALUES (N'Monthly', 10, 1), (N'Yearly', 20, 12)) v (Name, SortOrder, Months)
WHERE NOT EXISTS (SELECT 1 FROM dbo.BillingPeriods b WHERE b.Name = v.Name);
GO

PRINT 'Step 2 complete: lookup tables ready.';
