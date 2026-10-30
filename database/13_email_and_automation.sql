-- Step 13. Email, automations, staff access and maintenance mode.
--
-- What this script does:
--   Part A. Settings
--           - Adds the switches for Settings > Email: Incoming, Outgoing and
--             Automations. Every switch starts Off, so nothing is read from
--             or sent to the mailbox until you turn it on.
--           - Adds Settings > System > Access: "Staff can use the web app"
--             (On) and "Maintenance mode" (Off).
--           - Adds the error alert list, the site address used in email
--             links, and the source, ticket type and size limit for email.
--           - Adds four email templates (IT team alert, reply alert,
--             booking request and booking change).
--           - Changes the template subjects to "Ticket #[TicketNumber]:
--             [Subject]", only where they still read as script 09 set them.
--           - Removes the old single "Outgoing email" setting (EmailSwitch).
--   Part B. Mail the app has read: InboundEmails gets what it needs for the
--           Held mail list (sender, subject, preview, what happened to it).
--   Part C. Mail the app has sent: dbo.OutboundEmails, so a reply to any
--           email the desk sent finds its ticket.
--   Part D. Replies and notes: whether each reply was emailed, and which
--           ticket a merged reply came from.
--   Part E. Merging: Tickets.MergedIntoId.
--   Part F. dbo.SystemHealth: the last mailbox check, timer run and send,
--           and whether each is failing, for the Email status line and the
--           error alerts.
--
-- Run it once, after script 11 and 12. Safe to run again: every part checks
-- first and only adds what is missing.

------------------------------------------------------------------------------
-- Part A. Settings
------------------------------------------------------------------------------
DECLARE @EmailSourceId INT = (SELECT TOP (1) Id FROM dbo.Sources WHERE Name = N'Email');
DECLARE @SupportTypeId INT = (SELECT TOP (1) Id FROM dbo.TicketTypes WHERE Name = N'Support');

INSERT INTO dbo.Settings ([Key], [Value])
SELECT v.[Key], v.[Value]
FROM (VALUES
    -- Incoming
    (N'InCreateTickets', N'Off'),
    (N'InAddReplies', N'Off'),
    (N'InCreateSenders', N'Off'),
    (N'InSaveAttachments', N'Off'),
    (N'InProcessAfter', N''),
    (N'EmailSourceId', CAST(@EmailSourceId AS NVARCHAR(20))),
    (N'EmailTicketTypeId', CAST(@SupportTypeId AS NVARCHAR(20))),
    (N'MaxEmailMB', N'25'),
    -- Outgoing
    (N'OutReceived', N'Off'),
    (N'OutNewTicketAlert', N'Off'),
    (N'OutReply', N'Off'),
    (N'OutHrReply', N'Off'),
    (N'OutRequesterReplyAlert', N'Off'),
    (N'OutWarning', N'Off'),
    (N'OutClosed', N'Off'),
    (N'OutSurvey', N'Off'),
    (N'OutBookingAlert', N'Off'),
    (N'OutBookingDecision', N'Off'),
    (N'OutBookingChange', N'Off'),
    -- Automations
    (N'AutoClose', N'Off'),
    (N'CalendarWrite', N'Off'),
    -- Access
    (N'StaffWebAccess', N'On'),
    (N'MaintenanceMode', N'Off'),
    -- Notifications and links
    (N'ErrorAlertEmails', N''),
    (N'SiteUrl', N'https://zealous-island-0ed34b90f.3.azurestaticapps.net'),
    -- New templates
    (N'TemplateNewTicketAlertSubject', N'New ticket #[TicketNumber]: [Subject]'),
    (N'TemplateNewTicketAlertBody', N'[Requester] opened a new ticket.' + CHAR(10) + CHAR(10) + N'[Description]'),
    (N'TemplateReplyAlertSubject', N'[Requester] replied on Ticket #[TicketNumber]: [Subject]'),
    (N'TemplateReplyAlertBody', N'[Requester] replied on ticket [TicketNumber].' + CHAR(10) + CHAR(10) + N'[Description]'),
    (N'TemplateBookingRequestSubject', N'Room request: [Room] on [When]'),
    (N'TemplateBookingRequestBody', N'[Requester] asked for [Room] for "[Subject]" on [When]. Open the ticket to confirm or decline it.'),
    (N'TemplateBookingChangeSubject', N'Changed: Ticket #[TicketNumber]: [Subject]'),
    (N'TemplateBookingChangeBody', N'[Requester]''s request "[Subject]" on [When] changed:' + CHAR(10) + CHAR(10) + N'[Changes]')
) v ([Key], [Value])
WHERE NOT EXISTS (SELECT 1 FROM dbo.Settings s WHERE s.[Key] = v.[Key]);

-- Template subjects in the new form, where nobody has changed them yet
UPDATE s SET [Value] = v.NewValue
FROM dbo.Settings s
JOIN (VALUES
    (N'TemplateReceivedSubject', N'We got your request [TicketNumber]', N'Ticket #[TicketNumber]: [Subject]'),
    (N'TemplateWarningSubject', N'Still need your answer on [TicketNumber]', N'Ticket #[TicketNumber]: [Subject] (waiting on you)'),
    (N'TemplateClosedSubject', N'Ticket [TicketNumber] is closed', N'Ticket #[TicketNumber]: [Subject] (closed)'),
    (N'TemplateSurveySubject', N'How did we do on [TicketNumber]?', N'Ticket #[TicketNumber]: how did we do?'),
    (N'TemplateBookingConfirmedSubject', N'Your room is confirmed: [Room]', N'Ticket #[TicketNumber]: [Room] is confirmed'),
    (N'TemplateBookingDeclinedSubject', N'Your room request was declined: [Room]', N'Ticket #[TicketNumber]: [Room] was declined')
) v ([Key], OldValue, NewValue) ON v.[Key] = s.[Key] AND s.[Value] = v.OldValue;

-- The old single switch goes. Whatever it said, every new switch starts Off.
DELETE FROM dbo.Settings WHERE [Key] = N'EmailSwitch';
GO

------------------------------------------------------------------------------
-- Part B. Mail the app has read
-- Outcome: ticket (new ticket), reply (added to a ticket), held (waiting in
-- Held mail), dismissed, accepted, skipped (automatic mail or a switch off).
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.InboundEmails', 'Outcome') IS NULL
    ALTER TABLE dbo.InboundEmails ADD
        Outcome        NVARCHAR(20)  NULL,
        Detail         NVARCHAR(400) NULL,
        Mailbox        NVARCHAR(320) NULL,
        GraphMessageId NVARCHAR(400) NULL,
        FromEmail      NVARCHAR(320) NULL,
        FromName       NVARCHAR(200) NULL,
        Subject        NVARCHAR(400) NULL,
        Preview        NVARCHAR(500) NULL,
        DecidedById    INT NULL CONSTRAINT FK_InboundEmails_DecidedBy REFERENCES dbo.Users (Id),
        DecidedAt      DATETIME2(0) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_InboundEmails_Outcome' AND object_id = OBJECT_ID('dbo.InboundEmails'))
    CREATE INDEX IX_InboundEmails_Outcome ON dbo.InboundEmails (Outcome, ReceivedAt);
GO

------------------------------------------------------------------------------
-- Part C. Mail the app has sent
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.OutboundEmails') IS NULL
    CREATE TABLE dbo.OutboundEmails (
        Id                INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_OutboundEmails PRIMARY KEY,
        TicketId          INT NULL CONSTRAINT FK_OutboundEmails_Ticket REFERENCES dbo.Tickets (Id),
        Kind              NVARCHAR(40)  NOT NULL,
        ToList            NVARCHAR(2000) NOT NULL,
        Subject           NVARCHAR(400) NOT NULL,
        InternetMessageId NVARCHAR(400) NULL,
        SentAt            DATETIME2(0) NOT NULL CONSTRAINT DF_OutboundEmails_SentAt DEFAULT (SYSUTCDATETIME()),
        Error             NVARCHAR(1000) NULL
    );
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_OutboundEmails_MessageId' AND object_id = OBJECT_ID('dbo.OutboundEmails'))
    CREATE INDEX IX_OutboundEmails_MessageId ON dbo.OutboundEmails (InternetMessageId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_OutboundEmails_SentAt' AND object_id = OBJECT_ID('dbo.OutboundEmails'))
    CREATE INDEX IX_OutboundEmails_SentAt ON dbo.OutboundEmails (SentAt);
GO

------------------------------------------------------------------------------
-- Part D. Replies and notes
-- EmailedAt: when the reply went out by email. EmailNote: why it didn't
-- ("Not emailed: technician replies are switched off").
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.TicketConversations', 'EmailedAt') IS NULL
    ALTER TABLE dbo.TicketConversations ADD
        EmailedAt          DATETIME2(0) NULL,
        EmailNote          NVARCHAR(200) NULL,
        MergedFromTicketId INT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketConversations_EmailMessageId' AND object_id = OBJECT_ID('dbo.TicketConversations'))
    CREATE INDEX IX_TicketConversations_EmailMessageId ON dbo.TicketConversations (EmailMessageId);
GO

------------------------------------------------------------------------------
-- Part E. Merging
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Tickets', 'MergedIntoId') IS NULL
    ALTER TABLE dbo.Tickets ADD MergedIntoId INT NULL
        CONSTRAINT FK_Tickets_MergedInto REFERENCES dbo.Tickets (Id);
GO

------------------------------------------------------------------------------
-- Part F. System health
-- One row per job: mailbox, sending, timers, calendar. Marker is the job's
-- own bookmark (the newest mail read, or the day the timers last ran).
------------------------------------------------------------------------------
IF OBJECT_ID('dbo.SystemHealth') IS NULL
    CREATE TABLE dbo.SystemHealth (
        Name          NVARCHAR(50) NOT NULL CONSTRAINT PK_SystemHealth PRIMARY KEY,
        LastRunAt     DATETIME2(0) NULL,
        LastSuccessAt DATETIME2(0) NULL,
        LastErrorAt   DATETIME2(0) NULL,
        LastError     NVARCHAR(1000) NULL,
        IsFailing     BIT NOT NULL CONSTRAINT DF_SystemHealth_IsFailing DEFAULT (0),
        AlertedAt     DATETIME2(0) NULL,
        Marker        NVARCHAR(100) NULL
    );
GO

-- The Function App writes to the new table (script 06 granted it the
-- database roles it needs; nothing more to grant).

SELECT
    (SELECT COUNT(*) FROM dbo.Settings WHERE [Key] LIKE N'In%' OR [Key] LIKE N'Out%' OR [Key] LIKE N'Auto%') AS EmailSwitches, -- 17
    (SELECT COUNT(*) FROM dbo.Settings WHERE [Key] = N'EmailSwitch') AS OldSwitchLeft, -- 0
    OBJECT_ID('dbo.OutboundEmails') AS OutboundEmailsTable,
    OBJECT_ID('dbo.SystemHealth') AS SystemHealthTable;
GO

PRINT 'Step 13 complete: email switches (all Off), staff access, maintenance mode, merge and health tables ready.';
