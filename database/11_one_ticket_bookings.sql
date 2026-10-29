-- Step 11. One ticket for rentals and event bookings, rich text, low-stock
-- warnings per item, and the Organization settings (design version 5).
--
-- What this script does:
--   Part A. Adds the new columns and the dbo.TicketRooms table:
--           - Tickets.StartAt and EndAt: the date and time of a rental or
--             event, in the desk's own time zone.
--           - TicketRooms: the room part of an Equipment Rental / Event
--             Booking ticket, at most one per ticket. HR (Event Managers)
--             works this part; technicians work the equipment.
--           - TicketConversations.VisibleToEventManagers: marks an HR note.
--           - Attachments.IsInline: an image pasted into the text.
--           - InventoryItems.LowStockAt: each item's own low-stock number.
--           - Settings.Value can hold longer text, for rich text guidelines.
--   Part B. Moves every row of dbo.EventBookings onto a ticket. A booking
--           that already had a linked Equipment Rental ticket joins that
--           ticket; a room-only booking gets a new ticket. Its history moves
--           to dbo.TicketEvents.
--   Part C. Turns the plain text already saved (ticket descriptions, replies,
--           notes and the booking guidelines) into the rich text format,
--           keeping its line breaks.
--   Part D. Settings: copies the low-stock setting onto every equipment item
--           and removes it, and adds the Organization settings (app name,
--           organization name, time zone, staff email domains and the
--           testing email address).
--   Part E. Renames the Equipment Rental ticket type to
--           "Equipment Rental / Event Booking" and drops the old
--           dbo.EventBookings and dbo.BookingEvents tables.
--
-- Run it after steps 09, 10 and 12, and publish the API straight after it:
-- the API from before this step still reads dbo.EventBookings.
--
-- Parts B to E run as one transaction: if anything fails, nothing changes.
-- Safe to run again: each part only does what isn't done yet.

SET NOCOUNT ON;
SET XACT_ABORT ON;
GO

------------------------------------------------------------------------------
-- Part A. New columns and dbo.TicketRooms
------------------------------------------------------------------------------
IF COL_LENGTH('dbo.Tickets', 'StartAt') IS NULL
    ALTER TABLE dbo.Tickets ADD StartAt DATETIME2(0) NULL, EndAt DATETIME2(0) NULL;
GO
IF COL_LENGTH('dbo.TicketConversations', 'VisibleToEventManagers') IS NULL
    ALTER TABLE dbo.TicketConversations ADD VisibleToEventManagers BIT NOT NULL
        CONSTRAINT DF_TicketConversations_VisibleToEventManagers DEFAULT (0);
GO
IF COL_LENGTH('dbo.Attachments', 'IsInline') IS NULL
    ALTER TABLE dbo.Attachments ADD IsInline BIT NOT NULL CONSTRAINT DF_Attachments_IsInline DEFAULT (0);
GO
IF COL_LENGTH('dbo.InventoryItems', 'LowStockAt') IS NULL
    ALTER TABLE dbo.InventoryItems ADD LowStockAt INT NULL
        CONSTRAINT CK_InventoryItems_LowStockAt CHECK (LowStockAt >= 0);
GO
IF OBJECT_ID('dbo.TicketRooms') IS NULL
    CREATE TABLE dbo.TicketRooms (
        TicketId        INT NOT NULL CONSTRAINT PK_TicketRooms PRIMARY KEY
                            CONSTRAINT FK_TicketRooms_Tickets REFERENCES dbo.Tickets (Id),
        RoomId          INT NOT NULL CONSTRAINT FK_TicketRooms_Rooms REFERENCES dbo.Rooms (Id),
        AttendeeCount   INT NOT NULL CONSTRAINT CK_TicketRooms_Attendees CHECK (AttendeeCount >= 0),
        Refreshments    BIT NOT NULL CONSTRAINT DF_TicketRooms_Refreshments DEFAULT (0),
        Foia            BIT NOT NULL CONSTRAINT DF_TicketRooms_Foia DEFAULT (0),
        LunchCatered    BIT NOT NULL CONSTRAINT DF_TicketRooms_LunchCatered DEFAULT (0),
        BookingStatusId INT NOT NULL CONSTRAINT FK_TicketRooms_BookingStatuses REFERENCES dbo.BookingStatuses (Id),
        CalendarEventId NVARCHAR(400) NULL,
        ConfirmedById   INT NULL CONSTRAINT FK_TicketRooms_ConfirmedBy REFERENCES dbo.Users (Id),
        ConfirmedAt     DATETIME2(0) NULL
    );
GO
-- Rich text guidelines can be longer than the 4,000 characters a setting held
IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Settings') AND name = 'Value' AND max_length <> -1)
    ALTER TABLE dbo.Settings ALTER COLUMN [Value] NVARCHAR(MAX) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_TicketRooms_RoomId' AND object_id = OBJECT_ID('dbo.TicketRooms'))
    CREATE INDEX IX_TicketRooms_RoomId ON dbo.TicketRooms (RoomId) INCLUDE (BookingStatusId);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Tickets_StartAt' AND object_id = OBJECT_ID('dbo.Tickets'))
    CREATE INDEX IX_Tickets_StartAt ON dbo.Tickets (StartAt) INCLUDE (EndAt);
GO

------------------------------------------------------------------------------
-- Parts B to E, in one transaction
------------------------------------------------------------------------------
DROP TABLE IF EXISTS #Moves;
CREATE TABLE #Moves (BookingId INT PRIMARY KEY, TicketId INT NOT NULL, IsNew BIT NOT NULL);

BEGIN TRY
    BEGIN TRANSACTION;

    DECLARE @RentalTypeId INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'BookingTicketTypeId');
    DECLARE @NewStatusId INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'NewStatusId');
    DECLARE @ClosedStatusId INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'ClosedStatusId');
    DECLARE @PriorityId INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'DefaultPriorityId');
    DECLARE @WebSourceId INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'WebSourceId');
    DECLARE @Now DATETIME2(0) = SYSUTCDATETIME();

    ---------------------------------------------------------------------------
    -- Part B. Event bookings become tickets
    ---------------------------------------------------------------------------
    IF OBJECT_ID('dbo.EventBookings') IS NOT NULL
    BEGIN
        IF @RentalTypeId IS NULL OR @NewStatusId IS NULL OR @ClosedStatusId IS NULL OR @PriorityId IS NULL OR @WebSourceId IS NULL
            THROW 50001, 'Settings is missing the ticket type for bookings, the New or Closed status, the default priority or the web source. Set them in Settings first.', 1;

        -- Bookings that already have a linked equipment ticket
        INSERT INTO #Moves (BookingId, TicketId, IsNew)
        SELECT b.Id, b.TicketId, 0 FROM dbo.EventBookings b WHERE b.TicketId IS NOT NULL;

        -- A new ticket for each room-only booking. Bookings that are over,
        -- declined or cancelled get a closed ticket.
        MERGE dbo.Tickets AS t
        USING (
            SELECT b.Id AS BookingId, b.RequesterId, u.DepartmentId, b.Title, COALESCE(b.Comments, N'') AS Comments,
                   b.StartAt, b.EndAt, b.CreatedAt, b.UpdatedAt,
                   CAST(CASE WHEN bs.IsActiveBooking = 1 AND b.EndAt >= @Now THEN 1 ELSE 0 END AS BIT) AS IsOpen
            FROM dbo.EventBookings b
            JOIN dbo.BookingStatuses bs ON bs.Id = b.BookingStatusId
            JOIN dbo.Users u ON u.Id = b.RequesterId
            WHERE b.TicketId IS NULL
        ) AS s ON 1 = 0
        WHEN NOT MATCHED THEN
            INSERT (TicketTypeId, StatusId, PriorityId, SourceId, RequesterId, DepartmentId, Subject, Description,
                    StartDate, EndDate, StartAt, EndAt, CreatedAt, UpdatedAt, ClosedAt)
            VALUES (@RentalTypeId, CASE WHEN s.IsOpen = 1 THEN @NewStatusId ELSE @ClosedStatusId END, @PriorityId,
                    @WebSourceId, s.RequesterId, s.DepartmentId, s.Title, s.Comments,
                    CAST(s.StartAt AS DATE), CAST(s.EndAt AS DATE), s.StartAt, s.EndAt, s.CreatedAt, s.UpdatedAt,
                    CASE WHEN s.IsOpen = 1 THEN NULL ELSE s.UpdatedAt END)
        OUTPUT s.BookingId, INSERTED.Id, 1 INTO #Moves (BookingId, TicketId, IsNew);

        -- Linked tickets take the booking's title, comments and times
        UPDATE t
        SET Subject = b.Title,
            Description = COALESCE(b.Comments, N''),
            StartDate = CAST(b.StartAt AS DATE),
            EndDate = CAST(b.EndAt AS DATE),
            StartAt = b.StartAt,
            EndAt = b.EndAt
        FROM dbo.Tickets t
        JOIN #Moves m ON m.TicketId = t.Id AND m.IsNew = 0
        JOIN dbo.EventBookings b ON b.Id = m.BookingId;

        -- The room part
        INSERT INTO dbo.TicketRooms
            (TicketId, RoomId, AttendeeCount, Refreshments, Foia, LunchCatered, BookingStatusId, CalendarEventId, ConfirmedById, ConfirmedAt)
        SELECT m.TicketId, b.RoomId, b.AttendeeCount, b.Refreshments, b.Foia, b.LunchCatered, b.BookingStatusId,
               b.CalendarEventId, b.ConfirmedById, b.ConfirmedAt
        FROM #Moves m
        JOIN dbo.EventBookings b ON b.Id = m.BookingId
        WHERE NOT EXISTS (SELECT 1 FROM dbo.TicketRooms r WHERE r.TicketId = m.TicketId);

        -- The booking's history, with the names the ticket history uses
        INSERT INTO dbo.TicketEvents (TicketId, ActorId, Field, OldValue, NewValue, [At])
        SELECT m.TicketId, e.ActorId,
               CASE e.Field WHEN N'Booked' THEN N'Room requested' WHEN N'Status' THEN N'Room status'
                            WHEN N'Location' THEN N'Room' WHEN N'Title' THEN N'Subject' ELSE e.Field END,
               e.OldValue, e.NewValue, e.[At]
        FROM dbo.BookingEvents e
        JOIN #Moves m ON m.BookingId = e.BookingId
        WHERE e.Field <> N'Equipment' OR m.IsNew = 1;
    END

    ---------------------------------------------------------------------------
    -- Part C. Plain text becomes rich text. Rich text always starts with a
    -- block tag, so text that already does is left alone.
    ---------------------------------------------------------------------------
    UPDATE dbo.Tickets
    SET Description = N'<p>' + REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            Description, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'), NCHAR(13) + NCHAR(10), NCHAR(10)),
            NCHAR(13), NCHAR(10)), NCHAR(10) + NCHAR(10), N'</p><p>'), NCHAR(10), N'<br>') + N'</p>'
    WHERE Description <> N''
      AND Description NOT LIKE N'<p>%' AND Description NOT LIKE N'<ul>%' AND Description NOT LIKE N'<ol>%';

    UPDATE dbo.TicketConversations
    SET Body = N'<p>' + REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            Body, N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'), NCHAR(13) + NCHAR(10), NCHAR(10)),
            NCHAR(13), NCHAR(10)), NCHAR(10) + NCHAR(10), N'</p><p>'), NCHAR(10), N'<br>') + N'</p>'
    WHERE Body <> N''
      AND Body NOT LIKE N'<p>%' AND Body NOT LIKE N'<ul>%' AND Body NOT LIKE N'<ol>%';

    UPDATE dbo.Settings
    SET [Value] = N'<p>' + REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            [Value], N'&', N'&amp;'), N'<', N'&lt;'), N'>', N'&gt;'), NCHAR(13) + NCHAR(10), NCHAR(10)),
            NCHAR(13), NCHAR(10)), NCHAR(10) + NCHAR(10), N'</p><p>'), NCHAR(10), N'<br>') + N'</p>'
    WHERE [Key] = N'EventGuidelines' AND [Value] <> N''
      AND [Value] NOT LIKE N'<p>%' AND [Value] NOT LIKE N'<ul>%' AND [Value] NOT LIKE N'<ol>%';

    ---------------------------------------------------------------------------
    -- Part D. Settings
    ---------------------------------------------------------------------------
    -- Each equipment item starts with today's single low-stock number
    DECLARE @LowStock INT = (SELECT TRY_CAST([Value] AS INT) FROM dbo.Settings WHERE [Key] = N'LowStockThreshold');
    IF EXISTS (SELECT 1 FROM dbo.Settings WHERE [Key] = N'LowStockThreshold')
    BEGIN
        UPDATE dbo.InventoryItems SET LowStockAt = @LowStock WHERE LowStockAt IS NULL;
        DELETE FROM dbo.Settings WHERE [Key] = N'LowStockThreshold';
    END

    -- Organization. These were written into the app before; now they're in
    -- Settings > System > Organization.
    INSERT INTO dbo.Settings ([Key], [Value])
    SELECT v.[Key], v.[Value]
    FROM (VALUES
        (N'AppName', N'VSB Service Desk'),
        (N'OrganizationName', N'Virginia State Bar'),
        (N'TimeZone', N'America/New_York'),
        (N'StaffEmailDomains', N'vsb.org'),
        (N'TestingMailboxAddress', N'')
    ) v ([Key], [Value])
    WHERE NOT EXISTS (SELECT 1 FROM dbo.Settings s WHERE s.[Key] = v.[Key]);

    ---------------------------------------------------------------------------
    -- Part E. The ticket type's new name, and the old tables go
    ---------------------------------------------------------------------------
    UPDATE dbo.TicketTypes SET Name = N'Equipment Rental / Event Booking'
    WHERE Id = @RentalTypeId AND Name = N'Equipment Rental';

    IF OBJECT_ID('dbo.BookingEvents') IS NOT NULL DROP TABLE dbo.BookingEvents;
    IF OBJECT_ID('dbo.EventBookings') IS NOT NULL DROP TABLE dbo.EventBookings;

    COMMIT;
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK;
    THROW;
END CATCH;

SELECT
    (SELECT COUNT(*) FROM #Moves) AS BookingsMoved,
    (SELECT COUNT(*) FROM #Moves WHERE IsNew = 1) AS NewTickets,
    (SELECT COUNT(*) FROM dbo.TicketRooms) AS TicketsWithARoom;

PRINT 'Step 11 complete: rentals and event bookings are one ticket.';
GO
