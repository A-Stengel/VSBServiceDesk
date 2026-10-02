-- Step 0 (read only). Lists the columns of your existing tables so you can
-- confirm they match what the scripts expect. Your current tables use
--   dbo.Users        UserId (INT IDENTITY), FirstName, LastName, Email
--   dbo.Departments  DepartmentId (INT IDENTITY), DepartmentName, IsActive
-- and step 1 renames those key columns to Id and Name, the convention every
-- other table in the app uses.
-- Nothing is changed by this script.
SELECT  t.name AS TableName,
        c.column_id AS Position,
        c.name AS ColumnName,
        ty.name AS DataType,
        c.max_length AS MaxLength,
        c.is_nullable AS IsNullable,
        c.is_identity AS IsIdentity
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE SCHEMA_NAME(t.schema_id) = 'dbo'
ORDER BY t.name, c.column_id;
