-- Step 5. The ticket fact tables, the form-field configuration and app
-- settings.
--
-- The two core tables:
--   dbo.Tickets              one row per ticket (the ticket data)
--   dbo.TicketConversations  one row per response or technician note, linked
--                            to its ticket by TicketId
--
-- New ticket numbers start at 10000 (shown as 0010000) so they never clash
-- with the old Power App's numbers during the parallel run. Imported tickets
-- keep their old numbers.

------------------------------------------------------------------------------
-- Tickets
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Tickets', 'U') IS NULL
    CREATE TABLE dbo.Tickets (
        Id              INT IDENTITY(10000, 1) NOT NULL CONSTRAINT PK_Tickets PRIMARY KEY,
        TicketTypeId    INT NOT NULL CONSTRAINT FK_Tickets_TicketTypes REFERENCES dbo.TicketTypes (Id),
        StatusId        INT NOT NULL CONSTRAINT FK_Tickets_Statuses REFERENCES dbo.Statuses (Id),
        PriorityId      INT NOT NULL CONSTRAINT FK_Tickets_Priorities REFERENCES dbo.Priorities (Id),
        CategoryId      INT NULL CONSTRAINT FK_Tickets_Categories REFERENCES dbo.Categories (Id),
        SubcategoryId   INT NULL CONSTRAINT FK_Tickets_Subcategories REFERENCES dbo.Subcategories (Id),
        SourceId        INT NOT NULL CONSTRAINT FK_Tickets_Sources REFERENCES dbo.Sources (Id),
        RequesterId     INT NOT NULL CONSTRAINT FK_Tickets_Requester REFERENCES dbo.Users (Id),
        ForUserId       INT NULL CONSTRAINT FK_Tickets_ForUser REFERENCES dbo.Users (Id),
        ForPersonName   NVARCHAR(200) NULL,  -- a new hire who isn't in Users yet
        ForDepartmentId INT NULL CONSTRAINT FK_Tickets_ForDepartment REFERENCES dbo.Departments (Id),
        TechnicianId    INT NULL CONSTRAINT FK_Tickets_Technician REFERENCES dbo.Users (Id),
        DepartmentId    INT NULL CONSTRAINT FK_Tickets_Departments REFERENCES dbo.Departments (Id),
        Subject         NVARCHAR(255) NOT NULL,
        Description     NVARCHAR(MAX) NOT NULL,
        StartDate       DATE NULL,
        EndDate         DATE NULL,
        CreatedAt       DATETIME2(0) NOT NULL CONSTRAINT DF_Tickets_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt       DATETIME2(0) NOT NULL CONSTRAINT DF_Tickets_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        WaitingSince    DATETIME2(0) NULL,
        WarningSentAt   DATETIME2(0) NULL,
        ClosedAt        DATETIME2(0) NULL,
        LegacyId        NVARCHAR(50) NULL
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_StatusId')
    CREATE INDEX IX_Tickets_StatusId ON dbo.Tickets (StatusId) INCLUDE (TechnicianId, PriorityId, UpdatedAt);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_RequesterId')
    CREATE INDEX IX_Tickets_RequesterId ON dbo.Tickets (RequesterId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_ForUserId')
    CREATE INDEX IX_Tickets_ForUserId ON dbo.Tickets (ForUserId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_TechnicianId')
    CREATE INDEX IX_Tickets_TechnicianId ON dbo.Tickets (TechnicianId);
GO

------------------------------------------------------------------------------
-- Ticket conversations: one row per response or technician note
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.TicketConversations', 'U') IS NULL
    CREATE TABLE dbo.TicketConversations (
        Id               INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketConversations PRIMARY KEY,
        TicketId         INT NOT NULL CONSTRAINT FK_TicketConversations_Tickets REFERENCES dbo.Tickets (Id),
        AuthorId         INT NOT NULL CONSTRAINT FK_TicketConversations_Users REFERENCES dbo.Users (Id),
        Body             NVARCHAR(MAX) NOT NULL,
        IsTechnicianNote BIT NOT NULL CONSTRAINT DF_TicketConversations_IsNote DEFAULT (0),
        Direction        NVARCHAR(3) NULL  -- 'in' from the requester, 'out' to the requester, NULL for notes
            CONSTRAINT CK_TicketConversations_Direction CHECK (Direction IN ('in', 'out')),
        EmailMessageId   NVARCHAR(400) NULL,
        CreatedAt        DATETIME2(0) NOT NULL CONSTRAINT DF_TicketConversations_CreatedAt DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketConversations_TicketId')
    CREATE INDEX IX_TicketConversations_TicketId ON dbo.TicketConversations (TicketId, CreatedAt);
GO

------------------------------------------------------------------------------
-- Supporting fact tables
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.TicketCc', 'U') IS NULL
    CREATE TABLE dbo.TicketCc (
        TicketId INT NOT NULL CONSTRAINT FK_TicketCc_Tickets REFERENCES dbo.Tickets (Id),
        Email    NVARCHAR(320) NOT NULL,
        CONSTRAINT PK_TicketCc PRIMARY KEY (TicketId, Email)
    );
GO

IF OBJECT_ID('dbo.Attachments', 'U') IS NULL
    CREATE TABLE dbo.Attachments (
        Id             INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Attachments PRIMARY KEY,
        TicketId       INT NOT NULL CONSTRAINT FK_Attachments_Tickets REFERENCES dbo.Tickets (Id),
        ConversationId INT NULL CONSTRAINT FK_Attachments_Conversations REFERENCES dbo.TicketConversations (Id),
        FileName       NVARCHAR(255) NOT NULL,
        ContentType    NVARCHAR(150) NOT NULL,
        SizeBytes      BIGINT NOT NULL,
        BlobPath       NVARCHAR(500) NOT NULL,
        UploadedById   INT NOT NULL CONSTRAINT FK_Attachments_Users REFERENCES dbo.Users (Id),
        CreatedAt      DATETIME2(0) NOT NULL CONSTRAINT DF_Attachments_CreatedAt DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Attachments_TicketId')
    CREATE INDEX IX_Attachments_TicketId ON dbo.Attachments (TicketId);
GO

IF OBJECT_ID('dbo.TicketItems', 'U') IS NULL
    CREATE TABLE dbo.TicketItems (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketItems PRIMARY KEY,
        TicketId        INT NOT NULL CONSTRAINT FK_TicketItems_Tickets REFERENCES dbo.Tickets (Id),
        InventoryItemId INT NOT NULL CONSTRAINT FK_TicketItems_InventoryItems REFERENCES dbo.InventoryItems (Id),
        Quantity        INT NOT NULL CONSTRAINT CK_TicketItems_Quantity CHECK (Quantity > 0),
        UnitCostAtTime  DECIMAL(10, 2) NOT NULL,
        OutAt           DATETIME2(0) NULL,
        ReturnedAt      DATETIME2(0) NULL
    );
GO

IF OBJECT_ID('dbo.LicenseAssignments', 'U') IS NULL
    CREATE TABLE dbo.LicenseAssignments (
        Id                INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_LicenseAssignments PRIMARY KEY,
        UserId            INT NOT NULL CONSTRAINT FK_LicenseAssignments_Users REFERENCES dbo.Users (Id),
        SoftwareId        INT NOT NULL CONSTRAINT FK_LicenseAssignments_Software REFERENCES dbo.Software (Id),
        CostPerSeatAtTime DECIMAL(10, 2) NOT NULL,
        AssignedAt        DATETIME2(0) NOT NULL CONSTRAINT DF_LicenseAssignments_AssignedAt DEFAULT (SYSUTCDATETIME()),
        AssignedTicketId  INT NULL CONSTRAINT FK_LicenseAssignments_AssignedTicket REFERENCES dbo.Tickets (Id),
        RemovedAt         DATETIME2(0) NULL,
        RemovedTicketId   INT NULL CONSTRAINT FK_LicenseAssignments_RemovedTicket REFERENCES dbo.Tickets (Id)
    );
GO

IF OBJECT_ID('dbo.ChecklistItems', 'U') IS NULL
    CREATE TABLE dbo.ChecklistItems (
        Id                  INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ChecklistItems PRIMARY KEY,
        TicketId            INT NOT NULL CONSTRAINT FK_ChecklistItems_Tickets REFERENCES dbo.Tickets (Id),
        Label               NVARCHAR(255) NOT NULL,
        InventoryItemId     INT NULL CONSTRAINT FK_ChecklistItems_InventoryItems REFERENCES dbo.InventoryItems (Id),
        SoftwareId          INT NULL CONSTRAINT FK_ChecklistItems_Software REFERENCES dbo.Software (Id),
        LicenseAssignmentId INT NULL CONSTRAINT FK_ChecklistItems_LicenseAssignments REFERENCES dbo.LicenseAssignments (Id),
        TicketItemId        INT NULL CONSTRAINT FK_ChecklistItems_TicketItems REFERENCES dbo.TicketItems (Id),
        SortOrder           INT NOT NULL CONSTRAINT DF_ChecklistItems_SortOrder DEFAULT (0),
        IsDone              BIT NOT NULL CONSTRAINT DF_ChecklistItems_IsDone DEFAULT (0),
        DoneById            INT NULL CONSTRAINT FK_ChecklistItems_DoneBy REFERENCES dbo.Users (Id),
        DoneAt              DATETIME2(0) NULL
    );
GO

IF OBJECT_ID('dbo.Surveys', 'U') IS NULL
    CREATE TABLE dbo.Surveys (
        TicketId   INT NOT NULL CONSTRAINT PK_Surveys PRIMARY KEY
            CONSTRAINT FK_Surveys_Tickets REFERENCES dbo.Tickets (Id),
        Token      UNIQUEIDENTIFIER NOT NULL CONSTRAINT DF_Surveys_Token DEFAULT (NEWID()),
        Rating     TINYINT NULL CONSTRAINT CK_Surveys_Rating CHECK (Rating BETWEEN 1 AND 5),
        Comment    NVARCHAR(2000) NULL,
        SentAt     DATETIME2(0) NULL,
        AnsweredAt DATETIME2(0) NULL
    );
GO

IF OBJECT_ID('dbo.TicketEvents', 'U') IS NULL
    CREATE TABLE dbo.TicketEvents (
        Id       BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketEvents PRIMARY KEY,
        TicketId INT NOT NULL CONSTRAINT FK_TicketEvents_Tickets REFERENCES dbo.Tickets (Id),
        ActorId  INT NULL CONSTRAINT FK_TicketEvents_Users REFERENCES dbo.Users (Id),
        Field    NVARCHAR(50) NOT NULL,
        OldValue NVARCHAR(400) NULL,
        NewValue NVARCHAR(400) NULL,
        [At]     DATETIME2(0) NOT NULL CONSTRAINT DF_TicketEvents_At DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketEvents_TicketId')
    CREATE INDEX IX_TicketEvents_TicketId ON dbo.TicketEvents (TicketId, [At]);
GO

IF OBJECT_ID('dbo.InboundEmails', 'U') IS NULL
    CREATE TABLE dbo.InboundEmails (
        Id             INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_InboundEmails PRIMARY KEY,
        EmailMessageId NVARCHAR(400) NOT NULL CONSTRAINT UQ_InboundEmails_MessageId UNIQUE,
        ReceivedAt     DATETIME2(0) NOT NULL,
        TicketId       INT NULL CONSTRAINT FK_InboundEmails_Tickets REFERENCES dbo.Tickets (Id)
    );
GO

------------------------------------------------------------------------------
-- Which form fields each ticket type shows (a row = the field is shown).
-- FieldKey is one of: category, subcategory, startDate, endDate, items,
-- forUser, software, newHire. Subject, Description, Priority, CC and
-- Attachments are on every form.
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.TicketTypeFields', 'U') IS NULL
    CREATE TABLE dbo.TicketTypeFields (
        Id           INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_TicketTypeFields PRIMARY KEY,
        TicketTypeId INT NOT NULL CONSTRAINT FK_TicketTypeFields_TicketTypes REFERENCES dbo.TicketTypes (Id),
        FieldKey     NVARCHAR(50) NOT NULL,
        Label        NVARCHAR(100) NOT NULL,
        IsRequired   BIT NOT NULL CONSTRAINT DF_TicketTypeFields_IsRequired DEFAULT (0),
        SortOrder    INT NOT NULL CONSTRAINT DF_TicketTypeFields_SortOrder DEFAULT (0),
        CONSTRAINT UQ_TicketTypeFields UNIQUE (TicketTypeId, FieldKey)
    );
GO
INSERT INTO dbo.TicketTypeFields (TicketTypeId, FieldKey, Label, IsRequired, SortOrder)
SELECT t.Id, v.FieldKey, v.Label, v.IsRequired, v.SortOrder
FROM (VALUES
    (N'Support',                N'category',    N'Category',                     1, 10),
    (N'Support',                N'subcategory', N'Subcategory',                  0, 20),
    (N'Equipment Rental',       N'startDate',   N'Start date',                   1, 10),
    (N'Equipment Rental',       N'endDate',     N'End date',                     1, 20),
    (N'Equipment Rental',       N'items',       N'Items needed',                 1, 30),
    (N'Event Booking',          N'startDate',   N'Start date',                   1, 10),
    (N'Event Booking',          N'endDate',     N'End date',                     1, 20),
    (N'Event Booking',          N'items',       N'Items needed',                 1, 30),
    (N'Equipment Provisioning', N'forUser',     N'Who is it for?',               1, 10),
    (N'Equipment Provisioning', N'items',       N'Items needed',                 1, 20),
    (N'Access Request',         N'forUser',     N'Who is it for?',               1, 10),
    (N'Access Request',         N'software',    N'Software needed',              1, 20),
    (N'Onboarding',             N'newHire',     N'New hire',                     1, 10),
    (N'Onboarding',             N'startDate',   N'Start date',                   1, 20),
    (N'Offboarding',            N'forUser',     N'Who is leaving?',              1, 10),
    (N'Offboarding',            N'endDate',     N'Last day',                     1, 20)
) v (TypeName, FieldKey, Label, IsRequired, SortOrder)
JOIN dbo.TicketTypes t ON t.Name = v.TypeName
WHERE NOT EXISTS (SELECT 1 FROM dbo.TicketTypeFields f WHERE f.TicketTypeId = t.Id AND f.FieldKey = v.FieldKey);
GO

------------------------------------------------------------------------------
-- App settings (edited on the Settings page)
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.Settings', 'U') IS NULL
    CREATE TABLE dbo.Settings (
        [Key]   NVARCHAR(100) NOT NULL CONSTRAINT PK_Settings PRIMARY KEY,
        [Value] NVARCHAR(1000) NULL
    );
GO
INSERT INTO dbo.Settings ([Key], [Value])
SELECT v.[Key], v.[Value]
FROM (
    SELECT N'NewStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Statuses WHERE Name = N'New')
    UNION ALL SELECT N'AssignedStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Statuses WHERE Name = N'Assigned')
    UNION ALL SELECT N'AwaitingStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Statuses WHERE Name = N'Awaiting User Response')
    UNION ALL SELECT N'RequesterReplyStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Statuses WHERE Name = N'Assigned')
    UNION ALL SELECT N'ClosedStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Statuses WHERE Name = N'Closed')
    UNION ALL SELECT N'DefaultPriorityId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Priorities WHERE Name = N'Normal')
    UNION ALL SELECT N'WebSourceId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Sources WHERE Name = N'Web')
    UNION ALL SELECT N'DefaultRoleId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.Roles WHERE Name = N'Requester')
    UNION ALL SELECT N'StaffUserTypeId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.UserTypes WHERE Name = N'Staff')
    UNION ALL SELECT N'ExternalUserTypeId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.UserTypes WHERE Name = N'External')
    UNION ALL SELECT N'SharedMailboxUserTypeId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.UserTypes WHERE Name = N'Shared Mailbox')
    UNION ALL SELECT N'EmailSwitch', N'Off'
    UNION ALL SELECT N'WarningBusinessDays', N'3'
    UNION ALL SELECT N'CloseBusinessDays', N'4'
    UNION ALL SELECT N'MailboxAddress', N'servicedesk@vsb.org'
    UNION ALL SELECT N'ITTeamEmails', N''
    UNION ALL SELECT N'MailboxCheckMinutes', N'2'
) v ([Key], [Value])
WHERE NOT EXISTS (SELECT 1 FROM dbo.Settings s WHERE s.[Key] = v.[Key]);
GO

PRINT 'Step 5 complete: ticket tables, form fields and settings ready.';
