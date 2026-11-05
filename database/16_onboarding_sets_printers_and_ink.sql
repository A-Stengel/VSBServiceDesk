-- Step 16. Onboarding defaults by job title, software, iMIS access, printers
-- and ink.
--
-- What this script does:
--   Part A. Software. dbo.Applications holds the friendly software names
--           people pick on the Onboarding form (for example Adobe Acrobat).
--           Each license in Inventory (dbo.Software) can belong to one of
--           them (Software.ApplicationId). Every license you have today gets
--           its own software entry with the same name, so nothing changes
--           until you group them in Settings > Software and on the Inventory
--           page. A license under iMIS also says whether it is read only or
--           edit access (Software.ImisAccess).
--   Part B. iMIS lists. dbo.ImisModules, dbo.ImisRoles and dbo.ImisGroups are
--           the module levels, roles and security groups technicians can
--           give. They start with the lists from iMIS today.
--   Part C. Job titles and their defaults. dbo.JobTitles lists each
--           department's titles. dbo.OnboardingDefaults holds what each title
--           gets (equipment, software and its exact license, shared mailboxes,
--           shared calendars, phone queues, printers and iMIS access), and
--           which equipment and software are required. Rows with no job title
--           are the general defaults. Today's onboarding defaults (the
--           "Onboarding default" ticks) become the general defaults.
--   Part D. Printers and ink. dbo.Printers, dbo.InkCartridges (a type and
--           color with a count) and dbo.InkCartridgePrinters (which printers
--           each cartridge works with).
--   Part E. Low ink tickets. Subcategories.AsksForInk makes the form ask
--           which printer and which colors. Support gets a "Low ink"
--           subcategory under its printer category (or a new Printers
--           category). Tickets.PrinterId and dbo.TicketInk record what was
--           asked for and when a technician took a cartridge from stock.
--   Part F. Onboarding tickets and what people hold. Tickets get the new
--           hire's first and last name and job title. Checklist lines can
--           now be software (with the exact license), a shared mailbox,
--           calendar or phone queue, a printer, or iMIS access.
--           dbo.PersonAccess records what each person has been given, so the
--           person page and off boarding list it.
--
-- Run this BEFORE publishing the API from this change. The ticket pages read
-- the new columns, so they show an error until they exist.
--
-- Safe to run again: each part only adds what isn't there yet.

------------------------------------------------------------------------------
-- Part A. Software
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Applications', 'U') IS NULL
    CREATE TABLE dbo.Applications (
        Id          INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Applications PRIMARY KEY,
        Name        NVARCHAR(100) NOT NULL CONSTRAINT UQ_Applications_Name UNIQUE,
        Description NVARCHAR(200) NULL,
        IsImis      BIT NOT NULL CONSTRAINT DF_Applications_IsImis DEFAULT (0),
        SortOrder   INT NOT NULL CONSTRAINT DF_Applications_SortOrder DEFAULT (0),
        IsActive    BIT NOT NULL CONSTRAINT DF_Applications_IsActive DEFAULT (1)
    );
GO

IF COL_LENGTH('dbo.Software', 'ApplicationId') IS NULL
    ALTER TABLE dbo.Software ADD ApplicationId INT NULL
        CONSTRAINT FK_Software_Applications REFERENCES dbo.Applications (Id);
GO
IF COL_LENGTH('dbo.Software', 'ImisAccess') IS NULL
    ALTER TABLE dbo.Software ADD ImisAccess NVARCHAR(10) NULL
        CONSTRAINT CK_Software_ImisAccess CHECK (ImisAccess IN ('read', 'edit'));
GO

-- Each license that isn't under a software entry yet gets one with its name
INSERT INTO dbo.Applications (Name, SortOrder)
SELECT LEFT(s.Name, 100), s.SortOrder
FROM dbo.Software s
WHERE s.IsDeleted = 0 AND s.ApplicationId IS NULL
  AND NOT EXISTS (SELECT 1 FROM dbo.Applications a WHERE a.Name = LEFT(s.Name, 100));
GO
UPDATE s SET ApplicationId = a.Id
FROM dbo.Software s
JOIN dbo.Applications a ON a.Name = LEFT(s.Name, 100)
WHERE s.IsDeleted = 0 AND s.ApplicationId IS NULL;
GO

------------------------------------------------------------------------------
-- Part B. iMIS lists
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.ImisModules', 'U') IS NULL
    CREATE TABLE dbo.ImisModules (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ImisModules PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_ImisModules_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_ImisModules_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_ImisModules_IsActive DEFAULT (1)
    );
GO
IF OBJECT_ID('dbo.ImisRoles', 'U') IS NULL
    CREATE TABLE dbo.ImisRoles (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ImisRoles PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_ImisRoles_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_ImisRoles_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_ImisRoles_IsActive DEFAULT (1)
    );
GO
IF OBJECT_ID('dbo.ImisGroups', 'U') IS NULL
    CREATE TABLE dbo.ImisGroups (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ImisGroups PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_ImisGroups_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_ImisGroups_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_ImisGroups_IsActive DEFAULT (1)
    );
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ImisModules)
    INSERT INTO dbo.ImisModules (Name, SortOrder) VALUES
        (N'System', 10), (N'Customers', 20), (N'Dues', 30), (N'Events', 40),
        (N'Fundraising', 50), (N'Orders', 60), (N'Finance', 70), (N'Certification', 80);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.ImisRoles)
    INSERT INTO dbo.ImisRoles (Name, SortOrder) VALUES
        (N'ATSADMIN', 10), (N'CompanyAdministrator', 20), (N'Ethics', 30), (N'Finance', 40),
        (N'OnBehalfOf', 50), (N'RemoteService', 60), (N'SysAdmin', 70);
GO
IF NOT EXISTS (SELECT 1 FROM dbo.ImisGroups)
    INSERT INTO dbo.ImisGroups (Name, SortOrder) VALUES
        (N'CampaignAdmin', 10), (N'CampaignMgr', 20), (N'CampaignUser', 30),
        (N'Certification Admin', 40), (N'Certification Manager', 50), (N'Certification User', 60),
        (N'EventUser', 70), (N'FRUser', 80),
        (N'OpportunityAdmin', 90), (N'OpportunityCreator', 100), (N'OpportunityMgr', 110),
        (N'OpportunityOwners', 120), (N'OpportunityUser', 130), (N'OrderUser', 140),
        (N'RFMAdmin', 150), (N'RFMMgr', 160), (N'RFMUser', 170),
        (N'SegAdmin', 180), (N'SegMgr', 190), (N'SegUser', 200);
GO

------------------------------------------------------------------------------
-- Part C. Job titles and their onboarding defaults
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.JobTitles', 'U') IS NULL
    CREATE TABLE dbo.JobTitles (
        Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_JobTitles PRIMARY KEY,
        DepartmentId INT NOT NULL CONSTRAINT FK_JobTitles_Departments REFERENCES dbo.Departments (Id),
        Name         NVARCHAR(150) NOT NULL,
        SortOrder    INT NOT NULL CONSTRAINT DF_JobTitles_SortOrder DEFAULT (0),
        IsActive     BIT NOT NULL CONSTRAINT DF_JobTitles_IsActive DEFAULT (1),
        CONSTRAINT UQ_JobTitles_Name UNIQUE (DepartmentId, Name)
    );
GO

-- One row per thing a title gets. Kind says what RefId points at:
--   item        dbo.InventoryItems      (IsRequired: can't be removed on the form)
--   app         dbo.Applications        (SoftwareId: the exact license; IsRequired)
--   printer     dbo.Printers
--   imisModule  dbo.ImisModules         (Level: 0 to 8)
--   imisRole    dbo.ImisRoles
--   imisGroup   dbo.ImisGroups
--   mailbox, calendar, phone            (Text: what was typed)
-- JobTitleId empty = the general defaults.
IF OBJECT_ID('dbo.OnboardingDefaults', 'U') IS NULL
    CREATE TABLE dbo.OnboardingDefaults (
        Id         INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_OnboardingDefaults PRIMARY KEY,
        JobTitleId INT NULL CONSTRAINT FK_OnboardingDefaults_JobTitles REFERENCES dbo.JobTitles (Id),
        Kind       NVARCHAR(20) NOT NULL CONSTRAINT CK_OnboardingDefaults_Kind
            CHECK (Kind IN ('item', 'app', 'printer', 'imisModule', 'imisRole', 'imisGroup', 'mailbox', 'calendar', 'phone')),
        RefId      INT NULL,
        SoftwareId INT NULL CONSTRAINT FK_OnboardingDefaults_Software REFERENCES dbo.Software (Id),
        [Level]    TINYINT NULL,
        [Text]     NVARCHAR(200) NULL,
        IsRequired BIT NOT NULL CONSTRAINT DF_OnboardingDefaults_IsRequired DEFAULT (0),
        SortOrder  INT NOT NULL CONSTRAINT DF_OnboardingDefaults_SortOrder DEFAULT (0)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_OnboardingDefaults_JobTitleId')
    CREATE INDEX IX_OnboardingDefaults_JobTitleId ON dbo.OnboardingDefaults (JobTitleId);
GO

-- Today's onboarding defaults become the general defaults (first run only)
IF NOT EXISTS (SELECT 1 FROM dbo.OnboardingDefaults)
BEGIN
    INSERT INTO dbo.OnboardingDefaults (JobTitleId, Kind, RefId, SortOrder)
    SELECT NULL, N'item', i.Id, i.SortOrder
    FROM dbo.InventoryItems i
    WHERE i.IsDefaultForOnboarding = 1 AND i.IsDeleted = 0;

    INSERT INTO dbo.OnboardingDefaults (JobTitleId, Kind, RefId, SoftwareId, SortOrder)
    SELECT NULL, N'app', s.ApplicationId, s.Id, s.SortOrder
    FROM dbo.Software s
    WHERE s.IsDefaultForOnboarding = 1 AND s.IsDeleted = 0 AND s.ApplicationId IS NOT NULL;
END
GO

------------------------------------------------------------------------------
-- Part D. Printers and ink
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Printers', 'U') IS NULL
    CREATE TABLE dbo.Printers (
        Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Printers PRIMARY KEY,
        Name         NVARCHAR(100) NOT NULL CONSTRAINT UQ_Printers_Name UNIQUE,
        Model        NVARCHAR(150) NULL,
        Location     NVARCHAR(200) NULL,
        DepartmentId INT NULL CONSTRAINT FK_Printers_Departments REFERENCES dbo.Departments (Id),
        IsActive     BIT NOT NULL CONSTRAINT DF_Printers_IsActive DEFAULT (1),
        IsDeleted    BIT NOT NULL CONSTRAINT DF_Printers_IsDeleted DEFAULT (0)
    );
GO

IF OBJECT_ID('dbo.InkCartridges', 'U') IS NULL
    CREATE TABLE dbo.InkCartridges (
        Id             INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_InkCartridges PRIMARY KEY,
        Name           NVARCHAR(100) NOT NULL,
        Color          NVARCHAR(50) NOT NULL,
        QuantityOnHand INT NOT NULL CONSTRAINT DF_InkCartridges_Quantity DEFAULT (0)
            CONSTRAINT CK_InkCartridges_Quantity CHECK (QuantityOnHand >= 0),
        LowStockAt     INT NULL,
        UnitCost       DECIMAL(10, 2) NOT NULL CONSTRAINT DF_InkCartridges_UnitCost DEFAULT (0),
        IsActive       BIT NOT NULL CONSTRAINT DF_InkCartridges_IsActive DEFAULT (1),
        IsDeleted      BIT NOT NULL CONSTRAINT DF_InkCartridges_IsDeleted DEFAULT (0),
        CONSTRAINT UQ_InkCartridges_NameColor UNIQUE (Name, Color)
    );
GO

IF OBJECT_ID('dbo.InkCartridgePrinters', 'U') IS NULL
    CREATE TABLE dbo.InkCartridgePrinters (
        InkCartridgeId INT NOT NULL CONSTRAINT FK_InkCartridgePrinters_Cartridges REFERENCES dbo.InkCartridges (Id),
        PrinterId      INT NOT NULL CONSTRAINT FK_InkCartridgePrinters_Printers REFERENCES dbo.Printers (Id),
        CONSTRAINT PK_InkCartridgePrinters PRIMARY KEY (InkCartridgeId, PrinterId)
    );
GO

------------------------------------------------------------------------------
-- Part E. Low ink tickets
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Subcategories', 'AsksForInk') IS NULL
    ALTER TABLE dbo.Subcategories ADD AsksForInk BIT NOT NULL
        CONSTRAINT DF_Subcategories_AsksForInk DEFAULT (0);
GO

-- A "Low ink" subcategory under Support's printer category (first run only)
IF NOT EXISTS (SELECT 1 FROM dbo.Subcategories WHERE AsksForInk = 1)
BEGIN
    DECLARE @Support INT = (SELECT Id FROM dbo.TicketTypes WHERE Name = N'Support');
    IF @Support IS NOT NULL
    BEGIN
        DECLARE @Printers INT = (SELECT TOP (1) Id FROM dbo.Categories WHERE TicketTypeId = @Support AND Name LIKE N'Printer%' ORDER BY Id);
        IF @Printers IS NULL
        BEGIN
            INSERT INTO dbo.Categories (TicketTypeId, Name, SortOrder) VALUES (@Support, N'Printers', 40);
            SET @Printers = SCOPE_IDENTITY();
        END
        IF EXISTS (SELECT 1 FROM dbo.Subcategories WHERE CategoryId = @Printers AND Name = N'Low ink')
            UPDATE dbo.Subcategories SET AsksForInk = 1 WHERE CategoryId = @Printers AND Name = N'Low ink';
        ELSE
            INSERT INTO dbo.Subcategories (CategoryId, Name, SortOrder, AsksForInk) VALUES (@Printers, N'Low ink', 10, 1);
    END
END
GO

IF COL_LENGTH('dbo.Tickets', 'PrinterId') IS NULL
    ALTER TABLE dbo.Tickets ADD PrinterId INT NULL
        CONSTRAINT FK_Tickets_Printers REFERENCES dbo.Printers (Id);
GO

IF OBJECT_ID('dbo.TicketInk', 'U') IS NULL
    CREATE TABLE dbo.TicketInk (
        Id             INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketInk PRIMARY KEY,
        TicketId       INT NOT NULL CONSTRAINT FK_TicketInk_Tickets REFERENCES dbo.Tickets (Id),
        InkCartridgeId INT NOT NULL CONSTRAINT FK_TicketInk_Cartridges REFERENCES dbo.InkCartridges (Id),
        TakenAt        DATETIME2(0) NULL,
        TakenById      INT NULL CONSTRAINT FK_TicketInk_TakenBy REFERENCES dbo.Users (Id)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketInk_TicketId')
    CREATE INDEX IX_TicketInk_TicketId ON dbo.TicketInk (TicketId);
GO

------------------------------------------------------------------------------
-- Part F. Onboarding tickets and what people hold
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Tickets', 'NewHireFirstName') IS NULL
    ALTER TABLE dbo.Tickets ADD NewHireFirstName NVARCHAR(100) NULL, NewHireLastName NVARCHAR(100) NULL;
GO
IF COL_LENGTH('dbo.Tickets', 'JobTitleId') IS NULL
    ALTER TABLE dbo.Tickets ADD JobTitleId INT NULL
        CONSTRAINT FK_Tickets_JobTitles REFERENCES dbo.JobTitles (Id);
GO

-- What a person has been given besides equipment and license seats
IF OBJECT_ID('dbo.PersonAccess', 'U') IS NULL
    CREATE TABLE dbo.PersonAccess (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_PersonAccess PRIMARY KEY,
        UserId          INT NOT NULL CONSTRAINT FK_PersonAccess_Users REFERENCES dbo.Users (Id),
        Kind            NVARCHAR(20) NOT NULL CONSTRAINT CK_PersonAccess_Kind
            CHECK (Kind IN ('printer', 'imisModule', 'imisRole', 'imisGroup', 'mailbox', 'calendar', 'phone')),
        RefId           INT NULL,
        [Text]          NVARCHAR(200) NULL,
        [Level]         TINYINT NULL,
        GrantedAt       DATETIME2(0) NOT NULL CONSTRAINT DF_PersonAccess_GrantedAt DEFAULT (SYSUTCDATETIME()),
        GrantedTicketId INT NULL CONSTRAINT FK_PersonAccess_GrantedTicket REFERENCES dbo.Tickets (Id),
        RemovedAt       DATETIME2(0) NULL,
        RemovedTicketId INT NULL CONSTRAINT FK_PersonAccess_RemovedTicket REFERENCES dbo.Tickets (Id)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_PersonAccess_UserId')
    CREATE INDEX IX_PersonAccess_UserId ON dbo.PersonAccess (UserId);
GO

IF COL_LENGTH('dbo.ChecklistItems', 'ApplicationId') IS NULL
    ALTER TABLE dbo.ChecklistItems ADD
        ApplicationId  INT NULL CONSTRAINT FK_ChecklistItems_Applications REFERENCES dbo.Applications (Id),
        AccessKind     NVARCHAR(20) NULL,
        AccessRefId    INT NULL,
        AccessText     NVARCHAR(200) NULL,
        AccessLevel    TINYINT NULL,
        PersonAccessId INT NULL CONSTRAINT FK_ChecklistItems_PersonAccess REFERENCES dbo.PersonAccess (Id);
GO

-- Check: every number should be above 0.
SELECT
    (SELECT COUNT(*) FROM dbo.ImisModules) AS ImisModules,
    (SELECT COUNT(*) FROM dbo.Subcategories WHERE AsksForInk = 1) AS LowInkSubcategories,
    COL_LENGTH('dbo.Software', 'ApplicationId') AS SoftwareApplicationBytes,
    COL_LENGTH('dbo.Tickets', 'JobTitleId') AS TicketJobTitleBytes,
    COL_LENGTH('dbo.ChecklistItems', 'PersonAccessId') AS ChecklistAccessBytes;
GO
