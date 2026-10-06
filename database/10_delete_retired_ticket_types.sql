-- Step 10. Deletes the four ticket types that step 8 turned off: Event
-- Booking, Equipment Provisioning, Onboarding and Offboarding.
--
-- The app is still in development, so these only hold test data. Removing
-- them clears them out of Settings > Ticket types for good.
--
-- What this script deletes:
--   - the four turned-off ticket types (only while they are still turned off)
--   - their categories, subcategories and form field rows
--   - their test tickets, with each ticket's replies and notes, attachments
--     list, CCs, equipment lines, checklist, survey and history
--
-- What it keeps, unlinking it from those tickets instead:
--   - license seats handed out or taken back on one of those tickets
--   - event bookings and inbound emails that point at one of those tickets
--   - any other ticket filed under one of their categories (the category is
--     cleared)
--
-- Support, Access & Equipment (with its Onboarding, Access & Equipment Change
-- and Off Boarding kinds) and Equipment Rental are not touched.
--
-- It runs as one transaction: if anything fails, nothing changes. Set
-- @PreviewOnly to 1 to see the counts without deleting anything. Running it
-- again once the types are gone does nothing.

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @PreviewOnly BIT = 0;

DROP TABLE IF EXISTS #OldTypes;
DROP TABLE IF EXISTS #OldCategories;
DROP TABLE IF EXISTS #OldTickets;

BEGIN TRY
    BEGIN TRANSACTION;

    CREATE TABLE #OldTypes (Id INT PRIMARY KEY);
    INSERT INTO #OldTypes (Id)
    SELECT Id FROM dbo.TicketTypes
    WHERE Name IN (N'Event Booking', N'Equipment Provisioning', N'Onboarding', N'Offboarding') AND IsActive = 0;

    IF EXISTS (SELECT 1 FROM dbo.Settings s JOIN #OldTypes o ON CAST(o.Id AS NVARCHAR(20)) = s.[Value]
               WHERE s.[Key] = N'BookingTicketTypeId')
        THROW 50001, 'Settings > Other settings still points "Ticket type for a booking''s equipment" at one of these types. Change it to Equipment Rental first.', 1;

    CREATE TABLE #OldCategories (Id INT PRIMARY KEY);
    INSERT INTO #OldCategories (Id)
    SELECT c.Id FROM dbo.Categories c JOIN #OldTypes o ON o.Id = c.TicketTypeId;

    CREATE TABLE #OldTickets (Id INT PRIMARY KEY);
    INSERT INTO #OldTickets (Id)
    SELECT t.Id FROM dbo.Tickets t JOIN #OldTypes o ON o.Id = t.TicketTypeId;

    SELECT
        (SELECT COUNT(*) FROM #OldTypes) AS TicketTypes,
        (SELECT COUNT(*) FROM #OldCategories) AS Categories,
        (SELECT COUNT(*) FROM dbo.Subcategories WHERE CategoryId IN (SELECT Id FROM #OldCategories)) AS Subcategories,
        (SELECT COUNT(*) FROM #OldTickets) AS Tickets,
        (SELECT COUNT(*) FROM dbo.TicketConversations WHERE TicketId IN (SELECT Id FROM #OldTickets)) AS RepliesAndNotes,
        (SELECT COUNT(*) FROM dbo.Attachments WHERE TicketId IN (SELECT Id FROM #OldTickets)) AS Attachments,
        (SELECT COUNT(*) FROM dbo.Tickets WHERE TicketTypeId NOT IN (SELECT Id FROM #OldTypes)
            AND CategoryId IN (SELECT Id FROM #OldCategories)) AS OtherTicketsLosingCategory;

    -- Other tickets filed under one of these categories keep the ticket and
    -- lose the category.
    UPDATE dbo.Tickets
    SET CategoryId = NULL, SubcategoryId = NULL
    WHERE Id NOT IN (SELECT Id FROM #OldTickets)
      AND (CategoryId IN (SELECT Id FROM #OldCategories)
           OR SubcategoryId IN (SELECT Id FROM dbo.Subcategories WHERE CategoryId IN (SELECT Id FROM #OldCategories)));

    -- Rows that only point at one of the tickets are kept and unlinked.
    UPDATE dbo.LicenseAssignments SET AssignedTicketId = NULL WHERE AssignedTicketId IN (SELECT Id FROM #OldTickets);
    UPDATE dbo.LicenseAssignments SET RemovedTicketId = NULL WHERE RemovedTicketId IN (SELECT Id FROM #OldTickets);
    UPDATE dbo.InboundEmails SET TicketId = NULL WHERE TicketId IN (SELECT Id FROM #OldTickets);
    UPDATE dbo.EventBookings SET TicketId = NULL WHERE TicketId IN (SELECT Id FROM #OldTickets);

    -- The tickets and everything that belongs to them
    DELETE FROM dbo.ChecklistItems
    WHERE TicketId IN (SELECT Id FROM #OldTickets)
       OR TicketItemId IN (SELECT Id FROM dbo.TicketItems WHERE TicketId IN (SELECT Id FROM #OldTickets));
    DELETE FROM dbo.Attachments WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.TicketConversations WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.TicketCc WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.TicketItems WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.Surveys WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.TicketEvents WHERE TicketId IN (SELECT Id FROM #OldTickets);
    DELETE FROM dbo.Tickets WHERE Id IN (SELECT Id FROM #OldTickets);

    -- The types and their lists
    DELETE FROM dbo.TicketTypeFields
    WHERE TicketTypeId IN (SELECT Id FROM #OldTypes) OR CategoryId IN (SELECT Id FROM #OldCategories);
    DELETE FROM dbo.Subcategories WHERE CategoryId IN (SELECT Id FROM #OldCategories);
    DELETE FROM dbo.Categories WHERE Id IN (SELECT Id FROM #OldCategories);
    DELETE FROM dbo.TicketTypes WHERE Id IN (SELECT Id FROM #OldTypes);

    IF @PreviewOnly = 1
    BEGIN
        ROLLBACK TRANSACTION;
        PRINT 'Preview only: nothing was deleted. Set @PreviewOnly to 0 and run it again to delete.';
    END
    ELSE
    BEGIN
        COMMIT TRANSACTION;
        PRINT 'Done. The four retired ticket types and their test tickets are deleted.';
    END
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;

DROP TABLE IF EXISTS #OldTypes;
DROP TABLE IF EXISTS #OldCategories;
DROP TABLE IF EXISTS #OldTickets;
