-- Step 15. Personal tabs, the managers' department view, and resolutions.
--
-- What this script does:
--   Part A. Personal tabs. Every tab on the Tickets, Rentals and events, and
--           People lists becomes the person's own saved view.
--             - dbo.SavedViews gets a Position column (the tab order).
--             - dbo.DefaultTabs holds the tabs new accounts start with. There
--               is one set per list and group (requesters, event managers,
--               technicians). Admins change them in Settings > Default tabs.
--               It starts out with the same tabs the lists have today.
--             - dbo.TabSetup records who already has their own copy, so the
--               app copies the defaults to each person once, the first time
--               they open a list (and again when they click Reset to
--               defaults, or their role changes to or from Technician).
--   Part B. Team views go away. Each view an admin shared with the team is
--           copied to every technician as their own tab, then the shared
--           copy is deleted.
--   Part C. Managers. dbo.Users gets ShowDepartmentTickets, which remembers
--           whether the "Show my departments' tickets" switch is on.
--   Part D. Resolutions. dbo.TicketConversations gets IsResolution. Closing
--           a ticket now asks for a written resolution, saved as a
--           technician-only entry in the conversation.
--
-- Run it before publishing the API from this change. It doesn't depend on
-- step 14, so it can run before or after it.
--
-- Safe to run again: each part only runs when it hasn't been done yet.

------------------------------------------------------------------------------
-- Part A. Personal tabs
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.SavedViews', 'Position') IS NULL
    ALTER TABLE dbo.SavedViews ADD Position INT NOT NULL
        CONSTRAINT DF_SavedViews_Position DEFAULT (0);
GO

IF OBJECT_ID('dbo.DefaultTabs', 'U') IS NULL
    CREATE TABLE dbo.DefaultTabs (
        Id        INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_DefaultTabs PRIMARY KEY,
        ListKey   NVARCHAR(20) NOT NULL
            CONSTRAINT CK_DefaultTabs_ListKey CHECK (ListKey IN ('tickets', 'events', 'people')),
        Audience  NVARCHAR(20) NOT NULL
            CONSTRAINT CK_DefaultTabs_Audience CHECK (Audience IN ('requester', 'eventManager', 'technician')),
        Name      NVARCHAR(100) NOT NULL,
        Settings  NVARCHAR(2000) NOT NULL,
        Position  INT NOT NULL CONSTRAINT DF_DefaultTabs_Position DEFAULT (0)
    );
GO

IF OBJECT_ID('dbo.TabSetup', 'U') IS NULL
    CREATE TABLE dbo.TabSetup (
        UserId    INT NOT NULL CONSTRAINT FK_TabSetup_Users REFERENCES dbo.Users (Id),
        ListKey   NVARCHAR(20) NOT NULL,
        CreatedAt DATETIME2(0) NOT NULL CONSTRAINT DF_TabSetup_CreatedAt DEFAULT (SYSUTCDATETIME()),
        CONSTRAINT PK_TabSetup PRIMARY KEY (UserId, ListKey)
    );
GO

-- The starting tabs: the same ones the lists show today.
IF NOT EXISTS (SELECT 1 FROM dbo.DefaultTabs)
BEGIN
    DECLARE @Pending NVARCHAR(20) = (SELECT [Value] FROM dbo.Settings WHERE [Key] = N'BookingPendingStatusId');
    DECLARE @Confirmed NVARCHAR(20) = (SELECT [Value] FROM dbo.Settings WHERE [Key] = N'BookingConfirmedStatusId');

    INSERT INTO dbo.DefaultTabs (ListKey, Audience, Name, Settings, Position) VALUES
        -- Tickets, requesters
        (N'tickets', N'requester',  N'My open',                     N'{"base":"mineOpen","filters":{}}', 1),
        (N'tickets', N'requester',  N'Waiting on me',               N'{"base":"mineOpen","filters":{"waiting":"yes"}}', 2),
        (N'tickets', N'requester',  N'My closed',                   N'{"base":"mineClosed","filters":{}}', 3),
        -- Tickets, technicians
        (N'tickets', N'technician', N'My open',                     N'{"base":"mineOpen","filters":{}}', 1),
        (N'tickets', N'technician', N'All open',                    N'{"base":"queueOpen","filters":{}}', 2),
        (N'tickets', N'technician', N'Unassigned',                  N'{"base":"queueOpen","filters":{"assigned":"none"}}', 3),
        (N'tickets', N'technician', N'Assigned to me',              N'{"base":"queueOpen","filters":{"assigned":"me"}}', 4),
        (N'tickets', N'technician', N'Waiting on requester',        N'{"base":"queueOpen","filters":{"waiting":"yes"}}', 5),
        (N'tickets', N'technician', N'Onboarding and offboarding',  N'{"base":"queueOpen","filters":{"kind":"people"}}', 6),
        (N'tickets', N'technician', N'Closed',                      N'{"base":"queueClosed","filters":{}}', 7),
        -- Rentals and events, requesters
        (N'events',  N'requester',  N'Upcoming',                    N'{"base":"upcoming","filters":{}}', 1),
        (N'events',  N'requester',  N'Past',                        N'{"base":"past","filters":{}}', 2),
        -- Rentals and events, event managers (HR)
        (N'events',  N'eventManager', N'All upcoming',              N'{"base":"upcoming","filters":{}}', 1),
        (N'events',  N'eventManager', N'Room pending',              CONCAT(N'{"base":"upcoming","filters":{"roomStatus":"', @Pending, N'"}}'), 2),
        (N'events',  N'eventManager', N'Room confirmed',            CONCAT(N'{"base":"upcoming","filters":{"roomStatus":"', @Confirmed, N'"}}'), 3),
        (N'events',  N'eventManager', N'Past',                      N'{"base":"past","filters":{}}', 4),
        -- Rentals and events, technicians
        (N'events',  N'technician', N'All upcoming',                N'{"base":"upcoming","filters":{}}', 1),
        (N'events',  N'technician', N'Room pending',                CONCAT(N'{"base":"upcoming","filters":{"roomStatus":"', @Pending, N'"}}'), 2),
        (N'events',  N'technician', N'Room confirmed',              CONCAT(N'{"base":"upcoming","filters":{"roomStatus":"', @Confirmed, N'"}}'), 3),
        (N'events',  N'technician', N'Equipment out',               N'{"base":"all","filters":{"equipment":"out"}}', 4),
        (N'events',  N'technician', N'Past',                        N'{"base":"past","filters":{}}', 5),
        -- People (technicians only)
        (N'people',  N'technician', N'Active',                      N'{"filters":{"status":"on"},"sort":{"key":"name","dir":"asc"}}', 1),
        (N'people',  N'technician', N'Everyone',                    N'{"filters":{},"sort":{"key":"name","dir":"asc"}}', 2),
        (N'people',  N'technician', N'Off boarded',                 N'{"filters":{"status":"off"},"sort":{"key":"name","dir":"asc"}}', 3);
END
GO

------------------------------------------------------------------------------
-- Part B. Team views become each technician's own tab
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.SavedViews', 'IsShared') IS NOT NULL
    EXEC(N'
        INSERT INTO dbo.SavedViews (OwnerId, ListKey, Name, Settings, IsShared, Position)
        SELECT u.Id, v.ListKey, v.Name, v.Settings, 0, 1000 + v.Id
        FROM dbo.SavedViews v
        CROSS JOIN dbo.Users u
        JOIN dbo.Roles r ON r.Id = u.RoleId
        WHERE v.IsShared = 1 AND u.IsActive = 1 AND (r.IsTechnician = 1 OR r.IsAdmin = 1)
          AND NOT EXISTS (SELECT 1 FROM dbo.SavedViews x
                          WHERE x.OwnerId = u.Id AND x.ListKey = v.ListKey AND x.Name = v.Name AND x.IsShared = 0);
        DELETE FROM dbo.SavedViews WHERE IsShared = 1;
    ');
GO

------------------------------------------------------------------------------
-- Part C. The managers' department switch
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Users', 'ShowDepartmentTickets') IS NULL
    ALTER TABLE dbo.Users ADD ShowDepartmentTickets BIT NOT NULL
        CONSTRAINT DF_Users_ShowDepartmentTickets DEFAULT (0);
GO

------------------------------------------------------------------------------
-- Part D. Resolutions
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.TicketConversations', 'IsResolution') IS NULL
    ALTER TABLE dbo.TicketConversations ADD IsResolution BIT NOT NULL
        CONSTRAINT DF_TicketConversations_IsResolution DEFAULT (0);
GO

-- Check: each row should show a number above 0.
SELECT
    (SELECT COUNT(*) FROM dbo.DefaultTabs) AS DefaultTabs,
    COL_LENGTH('dbo.SavedViews', 'Position') AS SavedViewsPositionBytes,
    COL_LENGTH('dbo.Users', 'ShowDepartmentTickets') AS ShowDepartmentTicketsBytes,
    COL_LENGTH('dbo.TicketConversations', 'IsResolution') AS IsResolutionBytes;
GO
