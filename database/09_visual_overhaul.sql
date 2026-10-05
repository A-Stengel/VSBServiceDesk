-- Step 9. The visual overhaul: home page, saved views, the Inventory page,
-- the person page and the new Settings sections.
--
-- What this script does:
--   Part A. dbo.SavedViews: the custom filter views people save on every list
--           (tickets, rentals and events, people). An admin can share a
--           ticket view with the whole team.
--   Part B. dbo.ChangeLog: one history for Settings (per section), Inventory
--           and each person's page.
--   Part C. dbo.EquipmentStatuses: the names shown for the equipment part of
--           a rental (Requested, Checked out, Returned). Admins rename them in
--           Settings.
--   Part D. Inventory: items and software can be deleted once none are out
--           (IsDeleted), and equipment can be handed straight to a person
--           from their page without a ticket (TicketItems.HolderId).
--   Part E. New settings: HR notification emails, the low-stock warning and
--           the six email templates.
--
-- Run it after steps 1 to 8. Every change only runs when it hasn't been made
-- yet, so the script is safe to run again.

------------------------------------------------------------------------------
-- Part A. Saved views
-- ListKey is the list the view belongs to: 'tickets', 'events' or 'people'.
-- Settings is the view as JSON (tab, search, filters and sort), written by the
-- app. IsShared views (admins only, tickets only) show for every technician.
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.SavedViews', 'U') IS NULL
    CREATE TABLE dbo.SavedViews (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_SavedViews PRIMARY KEY,
        OwnerId   INT NOT NULL CONSTRAINT FK_SavedViews_Users REFERENCES dbo.Users (Id),
        ListKey   NVARCHAR(20) NOT NULL
            CONSTRAINT CK_SavedViews_ListKey CHECK (ListKey IN ('tickets', 'events', 'people')),
        Name      NVARCHAR(100) NOT NULL,
        Settings  NVARCHAR(2000) NOT NULL,
        IsShared  BIT NOT NULL CONSTRAINT DF_SavedViews_IsShared DEFAULT (0),
        CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_SavedViews_CreatedAt DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_SavedViews_Owner' AND object_id = OBJECT_ID('dbo.SavedViews'))
    CREATE INDEX IX_SavedViews_Owner ON dbo.SavedViews (OwnerId, ListKey);
GO

------------------------------------------------------------------------------
-- Part B. Change history
-- Area says which history a row belongs to:
--   'settings'  a Settings section (Section is the section, like 'statuses')
--   'inventory' the Inventory page (Section is 'equipment' or 'licenses',
--               EntityId the item or software)
--   'person'    a person's page (EntityId is their dbo.Users Id)
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.ChangeLog', 'U') IS NULL
    CREATE TABLE dbo.ChangeLog (
        Id       BIGINT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_ChangeLog PRIMARY KEY,
        Area     NVARCHAR(20) NOT NULL
            CONSTRAINT CK_ChangeLog_Area CHECK (Area IN ('settings', 'inventory', 'person')),
        Section  NVARCHAR(50) NULL,
        EntityId INT NULL,
        ActorId  INT NULL CONSTRAINT FK_ChangeLog_Users REFERENCES dbo.Users (Id),
        Summary  NVARCHAR(400) NOT NULL,
        [At]     DATETIME2(0) NOT NULL CONSTRAINT DF_ChangeLog_At DEFAULT (SYSUTCDATETIME())
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ChangeLog_Area' AND object_id = OBJECT_ID('dbo.ChangeLog'))
    CREATE INDEX IX_ChangeLog_Area ON dbo.ChangeLog (Area, Section, EntityId, [At]);
GO

------------------------------------------------------------------------------
-- Part C. Equipment statuses
-- Stage is fixed (the app works it out from the items); only the Name and
-- Color are edited in Settings.
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.EquipmentStatuses', 'U') IS NULL
    CREATE TABLE dbo.EquipmentStatuses (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_EquipmentStatuses PRIMARY KEY,
        Name      NVARCHAR(100) NOT NULL CONSTRAINT UQ_EquipmentStatuses_Name UNIQUE,
        Stage     NVARCHAR(20) NOT NULL CONSTRAINT UQ_EquipmentStatuses_Stage UNIQUE
            CONSTRAINT CK_EquipmentStatuses_Stage CHECK (Stage IN ('requested', 'out', 'returned')),
        SortOrder INT NOT NULL CONSTRAINT DF_EquipmentStatuses_SortOrder DEFAULT (0),
        IsActive  BIT NOT NULL CONSTRAINT DF_EquipmentStatuses_IsActive DEFAULT (1),
        Color     NVARCHAR(20) NULL
    );
GO
INSERT INTO dbo.EquipmentStatuses (Name, Stage, SortOrder, Color)
SELECT v.Name, v.Stage, v.SortOrder, v.Color
FROM (VALUES
    (N'Requested',   N'requested', 10, N'#fef3c7'),
    (N'Checked out', N'out',       20, N'#dbeafe'),
    (N'Returned',    N'returned',  30, N'#dcfce7')
) v (Name, Stage, SortOrder, Color)
WHERE NOT EXISTS (SELECT 1 FROM dbo.EquipmentStatuses s WHERE s.Stage = v.Stage);
GO

------------------------------------------------------------------------------
-- Part D. Inventory
------------------------------------------------------------------------------
-- Deleted items and software disappear from Inventory and every form. Old
-- tickets still point at them, so the rows stay.
IF COL_LENGTH('dbo.InventoryItems', 'IsDeleted') IS NULL
    ALTER TABLE dbo.InventoryItems ADD IsDeleted BIT NOT NULL
        CONSTRAINT DF_InventoryItems_IsDeleted DEFAULT (0) WITH VALUES;
GO
IF COL_LENGTH('dbo.Software', 'IsDeleted') IS NULL
    ALTER TABLE dbo.Software ADD IsDeleted BIT NOT NULL
        CONSTRAINT DF_Software_IsDeleted DEFAULT (0) WITH VALUES;
GO

-- Equipment handed straight to a person from their page has no ticket:
-- HolderId is the person and TicketId is empty.
IF COL_LENGTH('dbo.TicketItems', 'HolderId') IS NULL
    ALTER TABLE dbo.TicketItems ADD HolderId INT NULL
        CONSTRAINT FK_TicketItems_Holder REFERENCES dbo.Users (Id);
GO
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.TicketItems') AND name = 'TicketId' AND is_nullable = 0)
    ALTER TABLE dbo.TicketItems ALTER COLUMN TicketId INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_TicketItems_TicketOrHolder')
    ALTER TABLE dbo.TicketItems ADD CONSTRAINT CK_TicketItems_TicketOrHolder
        CHECK (TicketId IS NOT NULL OR HolderId IS NOT NULL);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketItems_HolderId' AND object_id = OBJECT_ID('dbo.TicketItems'))
    CREATE INDEX IX_TicketItems_HolderId ON dbo.TicketItems (HolderId);
GO

------------------------------------------------------------------------------
-- Part E. Settings
-- Email templates use these placeholders: [Requester], [TicketNumber],
-- [Subject], [Link], [DaysLeft], [Room], [When]. Nothing is emailed yet; the
-- email step of the build will use them.
------------------------------------------------------------------------------
INSERT INTO dbo.Settings ([Key], [Value])
SELECT v.[Key], v.[Value]
FROM (VALUES
    (N'HREmails', N''),
    (N'LowStockThreshold', N'2'),
    (N'TemplateReceivedSubject', N'We got your request [TicketNumber]'),
    (N'TemplateReceivedBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'Thanks for contacting IT. Your request "[Subject]" is ticket [TicketNumber]. Reply to this email to add details.' + CHAR(10) + CHAR(10) + N'[Link]'),
    (N'TemplateWarningSubject', N'Still need your answer on [TicketNumber]'),
    (N'TemplateWarningBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'We are waiting on your reply to ticket [TicketNumber]. It will close in [DaysLeft] business day if we do not hear back.' + CHAR(10) + CHAR(10) + N'[Link]'),
    (N'TemplateClosedSubject', N'Ticket [TicketNumber] is closed'),
    (N'TemplateClosedBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'Ticket [TicketNumber] is now closed. Reply to this email if you still need help.'),
    (N'TemplateSurveySubject', N'How did we do on [TicketNumber]?'),
    (N'TemplateSurveyBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'Please rate your experience from 1 to 5. It takes ten seconds.' + CHAR(10) + CHAR(10) + N'[Link]'),
    (N'TemplateBookingConfirmedSubject', N'Your room is confirmed: [Room]'),
    (N'TemplateBookingConfirmedBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'HR confirmed [Room] for [When].'),
    (N'TemplateBookingDeclinedSubject', N'Your room request was declined: [Room]'),
    (N'TemplateBookingDeclinedBody', N'Hi [Requester],' + CHAR(10) + CHAR(10) + N'HR could not confirm [Room] for [When]. Reply to this email to discuss other options.')
) v ([Key], [Value])
WHERE NOT EXISTS (SELECT 1 FROM dbo.Settings s WHERE s.[Key] = v.[Key]);
GO

PRINT 'Step 9 complete: saved views, change history, equipment statuses, inventory and settings ready.';
