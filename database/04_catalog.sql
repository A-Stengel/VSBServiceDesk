-- Step 4. Catalog tables: inventory item types (with counts) and software
-- (with per-seat license costs). Both are managed on the Settings page.
-- Costs are in US dollars and are for tracking only.

IF OBJECT_ID('dbo.InventoryItems', 'U') IS NULL
    CREATE TABLE dbo.InventoryItems (
        Id                     INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_InventoryItems PRIMARY KEY,
        Name                   NVARCHAR(150) NOT NULL CONSTRAINT UQ_InventoryItems_Name UNIQUE,
        UnitCost               DECIMAL(10, 2) NOT NULL CONSTRAINT DF_InventoryItems_UnitCost DEFAULT (0),
        QuantityOwned          INT NOT NULL CONSTRAINT DF_InventoryItems_Quantity DEFAULT (0),
        IsDefaultForOnboarding BIT NOT NULL CONSTRAINT DF_InventoryItems_Onboarding DEFAULT (0),
        SortOrder              INT NOT NULL CONSTRAINT DF_InventoryItems_SortOrder DEFAULT (0),
        IsActive               BIT NOT NULL CONSTRAINT DF_InventoryItems_IsActive DEFAULT (1)
    );
GO

IF OBJECT_ID('dbo.Software', 'U') IS NULL
    CREATE TABLE dbo.Software (
        Id                     INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_Software PRIMARY KEY,
        Name                   NVARCHAR(150) NOT NULL CONSTRAINT UQ_Software_Name UNIQUE,
        CostPerSeat            DECIMAL(10, 2) NOT NULL CONSTRAINT DF_Software_Cost DEFAULT (0),
        BillingPeriodId        INT NOT NULL CONSTRAINT FK_Software_BillingPeriods REFERENCES dbo.BillingPeriods (Id),
        SeatsPurchased         INT NOT NULL CONSTRAINT DF_Software_Seats DEFAULT (0),
        IsDefaultForOnboarding BIT NOT NULL CONSTRAINT DF_Software_Onboarding DEFAULT (0),
        SortOrder              INT NOT NULL CONSTRAINT DF_Software_SortOrder DEFAULT (0),
        IsActive               BIT NOT NULL CONSTRAINT DF_Software_IsActive DEFAULT (1)
    );
GO

PRINT 'Step 4 complete: inventory and software catalogs ready.';
