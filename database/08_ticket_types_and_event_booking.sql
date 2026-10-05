-- Step 8. New ticket types and event booking (design version 4).
--
-- What this script does:
--   Part A. Adds the Event Manager role (HR: room bookings only).
--   Part B. Makes categories belong to a ticket type, and moves the
--           onboarding / offboarding checklist setting from ticket types to
--           categories.
--   Part C. Reduces ticket types to Support, Access & Equipment and Equipment
--           Rental. Access Request is renamed Access & Equipment, with the
--           categories Onboarding, Access & Equipment Change and Off Boarding.
--           Event Booking, Equipment Provisioning, Onboarding and Offboarding
--           are retired (IsActive = 0), and existing test tickets of the old
--           access types are moved across.
--   Part D. Lets form fields be set per category, and sets up the Access &
--           Equipment fields.
--   Part E. Adds the event booking tables: BookingStatuses, Rooms,
--           EventBookings and BookingEvents.
--   Part F. Adds the new settings.
--
-- Run it after steps 1 to 7. Every change only runs when it hasn't been made
-- yet, so the script is safe to run again.

------------------------------------------------------------------------------
-- Part A. Event Manager role
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Roles', 'IsEventManager') IS NULL
    ALTER TABLE dbo.Roles ADD IsEventManager BIT NOT NULL
        CONSTRAINT DF_Roles_IsEventManager DEFAULT (0) WITH VALUES;
GO
INSERT INTO dbo.Roles (Name, SortOrder, IsTechnician, IsAdmin, IsEventManager)
SELECT N'Event Manager', 15, 0, 0, 1
WHERE NOT EXISTS (SELECT 1 FROM dbo.Roles WHERE Name = N'Event Manager');
GO

------------------------------------------------------------------------------
-- Part B. Categories belong to a ticket type
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Categories', 'TicketTypeId') IS NULL
    ALTER TABLE dbo.Categories ADD TicketTypeId INT NULL
        CONSTRAINT FK_Categories_TicketTypes REFERENCES dbo.TicketTypes (Id);
GO
-- 'onboarding' ticks the onboarding defaults, 'change' uses what the form
-- picked to add or remove, 'offboarding' lists everything the person holds.
IF COL_LENGTH('dbo.Categories', 'ChecklistSource') IS NULL
    ALTER TABLE dbo.Categories ADD ChecklistSource NVARCHAR(20) NULL
        CONSTRAINT CK_Categories_ChecklistSource CHECK (ChecklistSource IN ('onboarding', 'change', 'offboarding'));
GO
-- The same category name can now be used under two ticket types
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_Categories_Name' AND parent_object_id = OBJECT_ID('dbo.Categories'))
    ALTER TABLE dbo.Categories DROP CONSTRAINT UQ_Categories_Name;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_Categories_TypeName' AND object_id = OBJECT_ID('dbo.Categories'))
    CREATE UNIQUE INDEX UQ_Categories_TypeName ON dbo.Categories (TicketTypeId, Name);
GO

-- Checklist lines say which way they go, instead of the ticket type deciding
IF COL_LENGTH('dbo.ChecklistItems', 'IsRemoval') IS NULL
    ALTER TABLE dbo.ChecklistItems ADD IsRemoval BIT NOT NULL
        CONSTRAINT DF_ChecklistItems_IsRemoval DEFAULT (0) WITH VALUES;
GO
-- Lines on existing offboarding tickets are removals. TicketTypes.ChecklistSource
-- is dropped at the end of Part C, so this only runs while it still exists.
IF COL_LENGTH('dbo.TicketTypes', 'ChecklistSource') IS NOT NULL
    EXEC sp_executesql N'
        UPDATE ci SET IsRemoval = 1
        FROM dbo.ChecklistItems ci
        JOIN dbo.Tickets t ON t.Id = ci.TicketId
        JOIN dbo.TicketTypes tt ON tt.Id = t.TicketTypeId
        WHERE tt.ChecklistSource = ''offboarding'' AND ci.IsRemoval = 0;';
GO

------------------------------------------------------------------------------
-- Part C. The three ticket types
------------------------------------------------------------------------------
IF EXISTS (SELECT 1 FROM dbo.TicketTypes WHERE Name = N'Access Request')
   AND NOT EXISTS (SELECT 1 FROM dbo.TicketTypes WHERE Name = N'Access & Equipment')
    UPDATE dbo.TicketTypes SET Name = N'Access & Equipment' WHERE Name = N'Access Request';
GO
INSERT INTO dbo.TicketTypes (Name, SortOrder)
SELECT N'Access & Equipment', 20
WHERE NOT EXISTS (SELECT 1 FROM dbo.TicketTypes WHERE Name = N'Access & Equipment');
INSERT INTO dbo.TicketTypes (Name, SortOrder, UsesDates, UsesInventory)
SELECT N'Equipment Rental', 30, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM dbo.TicketTypes WHERE Name = N'Equipment Rental');
GO
UPDATE dbo.TicketTypes
SET SortOrder = 20, IsActive = 1, UsesDates = 1, UsesInventory = 1, UsesLicenses = 1, UsesChecklist = 1
WHERE Name = N'Access & Equipment';
UPDATE dbo.TicketTypes SET SortOrder = 10 WHERE Name = N'Support';
UPDATE dbo.TicketTypes SET SortOrder = 30 WHERE Name = N'Equipment Rental';
GO

-- Every category that has no type yet is a Support category
UPDATE dbo.Categories
SET TicketTypeId = (SELECT Id FROM dbo.TicketTypes WHERE Name = N'Support')
WHERE TicketTypeId IS NULL;
GO

-- The Access & Equipment categories
INSERT INTO dbo.Categories (Name, SortOrder, TicketTypeId, ChecklistSource)
SELECT v.Name, v.SortOrder, t.Id, v.ChecklistSource
FROM (VALUES
    (N'Onboarding',                10, N'onboarding'),
    (N'Access & Equipment Change', 20, N'change'),
    (N'Off Boarding',              30, N'offboarding')
) v (Name, SortOrder, ChecklistSource)
CROSS JOIN dbo.TicketTypes t
WHERE t.Name = N'Access & Equipment'
  AND NOT EXISTS (SELECT 1 FROM dbo.Categories c WHERE c.TicketTypeId = t.Id AND c.Name = v.Name);
GO

-- Move existing (test) tickets of the old access types across. A ticket keeps
-- its category if it already has an Access & Equipment one.
DECLARE @Access INT = (SELECT Id FROM dbo.TicketTypes WHERE Name = N'Access & Equipment');
DECLARE @Onboarding INT = (SELECT Id FROM dbo.Categories WHERE TicketTypeId = @Access AND Name = N'Onboarding');
DECLARE @Change INT = (SELECT Id FROM dbo.Categories WHERE TicketTypeId = @Access AND Name = N'Access & Equipment Change');
DECLARE @Leaving INT = (SELECT Id FROM dbo.Categories WHERE TicketTypeId = @Access AND Name = N'Off Boarding');

UPDATE t
SET TicketTypeId = @Access,
    CategoryId = CASE tt.Name WHEN N'Onboarding' THEN @Onboarding WHEN N'Offboarding' THEN @Leaving END,
    SubcategoryId = NULL
FROM dbo.Tickets t
JOIN dbo.TicketTypes tt ON tt.Id = t.TicketTypeId
WHERE tt.Name IN (N'Onboarding', N'Offboarding');

UPDATE t
SET CategoryId = @Change, SubcategoryId = NULL
FROM dbo.Tickets t
LEFT JOIN dbo.Categories c ON c.Id = t.CategoryId
WHERE t.TicketTypeId = @Access AND (c.Id IS NULL OR c.TicketTypeId <> @Access);
GO

-- Retire the old types. Their test tickets (Event Booking, Equipment
-- Provisioning) stay as they are.
UPDATE dbo.TicketTypes
SET IsActive = 0
WHERE Name IN (N'Event Booking', N'Equipment Provisioning', N'Onboarding', N'Offboarding') AND IsActive = 1;
GO

-- The checklist setting now lives on categories
IF COL_LENGTH('dbo.TicketTypes', 'ChecklistSource') IS NOT NULL
BEGIN
    IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_TicketTypes_ChecklistSource')
        ALTER TABLE dbo.TicketTypes DROP CONSTRAINT CK_TicketTypes_ChecklistSource;
    ALTER TABLE dbo.TicketTypes DROP COLUMN ChecklistSource;
END
GO

------------------------------------------------------------------------------
-- Part D. Form fields per category
-- A row with an empty CategoryId applies to the whole ticket type; a row with
-- a CategoryId only applies when that category is picked. New FieldKey
-- "removals": equipment or software to take back from the person.
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.TicketTypeFields', 'CategoryId') IS NULL
    ALTER TABLE dbo.TicketTypeFields ADD CategoryId INT NULL
        CONSTRAINT FK_TicketTypeFields_Categories REFERENCES dbo.Categories (Id);
GO
IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_TicketTypeFields' AND parent_object_id = OBJECT_ID('dbo.TicketTypeFields'))
    ALTER TABLE dbo.TicketTypeFields DROP CONSTRAINT UQ_TicketTypeFields;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_TicketTypeFields_Key' AND object_id = OBJECT_ID('dbo.TicketTypeFields'))
    CREATE UNIQUE INDEX UQ_TicketTypeFields_Key ON dbo.TicketTypeFields (TicketTypeId, CategoryId, FieldKey);
GO

-- Set up the Access & Equipment form, only the first time (once any
-- category-level row exists, your own edits are left alone).
DECLARE @Access INT = (SELECT Id FROM dbo.TicketTypes WHERE Name = N'Access & Equipment');
IF NOT EXISTS (SELECT 1 FROM dbo.TicketTypeFields WHERE TicketTypeId = @Access AND CategoryId IS NOT NULL)
BEGIN
    -- The old Access Request fields (who it's for, software) move to the categories
    DELETE FROM dbo.TicketTypeFields WHERE TicketTypeId = @Access;

    INSERT INTO dbo.TicketTypeFields (TicketTypeId, CategoryId, FieldKey, Label, IsRequired, SortOrder)
    SELECT @Access, c.Id, v.FieldKey, v.Label, v.IsRequired, v.SortOrder
    FROM (VALUES
        (NULL,                         N'category',  N'What kind of request?',           1, 10),
        (N'Onboarding',                N'newHire',   N'New hire',                        1, 20),
        (N'Onboarding',                N'startDate', N'Start date',                      1, 30),
        (N'Onboarding',                N'items',     N'Equipment',                       0, 40),
        (N'Onboarding',                N'software',  N'Software',                        0, 50),
        (N'Access & Equipment Change', N'forUser',   N'Who is it for?',                  1, 20),
        (N'Access & Equipment Change', N'items',     N'Equipment to add',                0, 30),
        (N'Access & Equipment Change', N'software',  N'Software to add',                 0, 40),
        (N'Access & Equipment Change', N'removals',  N'Equipment or software to remove', 0, 50),
        (N'Off Boarding',              N'forUser',   N'Who is leaving?',                 1, 20),
        (N'Off Boarding',              N'endDate',   N'Last day',                        1, 30)
    ) v (CategoryName, FieldKey, Label, IsRequired, SortOrder)
    LEFT JOIN dbo.Categories c ON c.TicketTypeId = @Access AND c.Name = v.CategoryName;
END
GO

------------------------------------------------------------------------------
-- Part E. Event booking
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.BookingStatuses', 'U') IS NULL
    CREATE TABLE dbo.BookingStatuses (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_BookingStatuses PRIMARY KEY,
        Name            NVARCHAR(100) NOT NULL CONSTRAINT UQ_BookingStatuses_Name UNIQUE,
        SortOrder       INT NOT NULL CONSTRAINT DF_BookingStatuses_SortOrder DEFAULT (0),
        IsActive        BIT NOT NULL CONSTRAINT DF_BookingStatuses_IsActive DEFAULT (1),
        IsActiveBooking BIT NOT NULL CONSTRAINT DF_BookingStatuses_IsActiveBooking DEFAULT (1),
        Color           NVARCHAR(20) NULL
    );
GO
INSERT INTO dbo.BookingStatuses (Name, SortOrder, IsActiveBooking, Color)
SELECT v.Name, v.SortOrder, v.IsActiveBooking, v.Color
FROM (VALUES
    (N'Pending',   10, 1, N'#fef3c7'),
    (N'Confirmed', 20, 1, N'#dcfce7'),
    (N'Declined',  30, 0, N'#fee2e2'),
    (N'Cancelled', 40, 0, N'#e5e7eb')
) v (Name, SortOrder, IsActiveBooking, Color)
WHERE NOT EXISTS (SELECT 1 FROM dbo.BookingStatuses s WHERE s.Name = v.Name);
GO

-- Rooms are managed by Event Managers on the Event bookings page
IF OBJECT_ID('dbo.Rooms', 'U') IS NULL
    CREATE TABLE dbo.Rooms (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Rooms PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_Rooms_Name UNIQUE,
        SortOrder INT NOT NULL CONSTRAINT DF_Rooms_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_Rooms_IsActive DEFAULT (1)
    );
GO

-- One room booking. StartAt and EndAt are VSB local time (Eastern), as
-- people type them. TicketId is the linked Equipment Rental ticket, only when
-- equipment was asked for. CalendarEventId is for the VSB Events calendar,
-- which comes in a later step.
IF OBJECT_ID('dbo.EventBookings', 'U') IS NULL
    CREATE TABLE dbo.EventBookings (
        Id              INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_EventBookings PRIMARY KEY,
        RequesterId     INT NOT NULL CONSTRAINT FK_EventBookings_Requester REFERENCES dbo.Users (Id),
        Title           NVARCHAR(255) NOT NULL,
        StartAt         DATETIME2(0) NOT NULL,
        EndAt           DATETIME2(0) NOT NULL,
        RoomId          INT NOT NULL CONSTRAINT FK_EventBookings_Rooms REFERENCES dbo.Rooms (Id),
        AttendeeCount   INT NOT NULL CONSTRAINT CK_EventBookings_Attendees CHECK (AttendeeCount >= 0),
        Refreshments    BIT NOT NULL CONSTRAINT DF_EventBookings_Refreshments DEFAULT (0),
        Foia            BIT NOT NULL CONSTRAINT DF_EventBookings_Foia DEFAULT (0),
        LunchCatered    BIT NOT NULL CONSTRAINT DF_EventBookings_LunchCatered DEFAULT (0),
        Comments        NVARCHAR(4000) NULL,
        BookingStatusId INT NOT NULL CONSTRAINT FK_EventBookings_BookingStatuses REFERENCES dbo.BookingStatuses (Id),
        TicketId        INT NULL CONSTRAINT FK_EventBookings_Tickets REFERENCES dbo.Tickets (Id),
        CalendarEventId NVARCHAR(400) NULL,
        ConfirmedById   INT NULL CONSTRAINT FK_EventBookings_ConfirmedBy REFERENCES dbo.Users (Id),
        ConfirmedAt     DATETIME2(0) NULL,
        CreatedAt       DATETIME2(0) NOT NULL CONSTRAINT DF_EventBookings_CreatedAt DEFAULT (SYSUTCDATETIME()),
        UpdatedAt       DATETIME2(0) NOT NULL CONSTRAINT DF_EventBookings_UpdatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT CK_EventBookings_Times CHECK (EndAt > StartAt)
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EventBookings_StartAt')
    CREATE INDEX IX_EventBookings_StartAt ON dbo.EventBookings (StartAt) INCLUDE (EndAt, RoomId, BookingStatusId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EventBookings_RequesterId')
    CREATE INDEX IX_EventBookings_RequesterId ON dbo.EventBookings (RequesterId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_EventBookings_TicketId')
    CREATE INDEX IX_EventBookings_TicketId ON dbo.EventBookings (TicketId);
GO

-- One change to a booking, for its history
IF OBJECT_ID('dbo.BookingEvents', 'U') IS NULL
    CREATE TABLE dbo.BookingEvents (
        Id        BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_BookingEvents PRIMARY KEY,
        BookingId INT NOT NULL CONSTRAINT FK_BookingEvents_EventBookings REFERENCES dbo.EventBookings (Id),
        ActorId   INT NULL CONSTRAINT FK_BookingEvents_Users REFERENCES dbo.Users (Id),
        Field     NVARCHAR(50) NOT NULL,
        OldValue  NVARCHAR(400) NULL,
        NewValue  NVARCHAR(400) NULL,
        [At]      DATETIME2(0) NOT NULL CONSTRAINT DF_BookingEvents_At DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_BookingEvents_BookingId')
    CREATE INDEX IX_BookingEvents_BookingId ON dbo.BookingEvents (BookingId, [At]);
GO

------------------------------------------------------------------------------
-- Part F. Settings
------------------------------------------------------------------------------
-- Room for the event booking Guidelines text
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Settings') AND name = 'Value' AND max_length BETWEEN 0 AND 7999)
    ALTER TABLE dbo.Settings ALTER COLUMN [Value] NVARCHAR(4000) NULL;
GO
INSERT INTO dbo.Settings ([Key], [Value])
SELECT v.[Key], v.[Value]
FROM (
    SELECT N'BookingPendingStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.BookingStatuses WHERE Name = N'Pending')
    UNION ALL SELECT N'BookingConfirmedStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.BookingStatuses WHERE Name = N'Confirmed')
    UNION ALL SELECT N'BookingDeclinedStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.BookingStatuses WHERE Name = N'Declined')
    UNION ALL SELECT N'BookingCancelledStatusId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.BookingStatuses WHERE Name = N'Cancelled')
    UNION ALL SELECT N'BookingTicketTypeId', (SELECT CAST(Id AS NVARCHAR(20)) FROM dbo.TicketTypes WHERE Name = N'Equipment Rental')
    UNION ALL SELECT N'EventsCalendarAddress', N'VSBEventsCalender@vsb.org'
    UNION ALL SELECT N'EventGuidelines', N''
) v ([Key], [Value])
WHERE NOT EXISTS (SELECT 1 FROM dbo.Settings s WHERE s.[Key] = v.[Key]);
GO

PRINT 'Step 8 complete: new ticket types and event booking ready.';
