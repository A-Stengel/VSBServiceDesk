-- Step 7. Make yourself the first Admin. After this, promote everyone else to
-- Technician or Admin from the People page in the app.
--
-- Change the email if you sign in with a different account.

DECLARE @Email NVARCHAR(320) = N'astengel@vsb.org';
DECLARE @AdminRoleId INT = (SELECT Id FROM dbo.Roles WHERE Name = N'Admin');
DECLARE @StaffTypeId INT = (SELECT Id FROM dbo.UserTypes WHERE Name = N'Staff');

IF EXISTS (SELECT 1 FROM dbo.Users WHERE Email = @Email)
    UPDATE dbo.Users SET RoleId = @AdminRoleId, IsActive = 1 WHERE Email = @Email;
ELSE
    INSERT INTO dbo.Users (FirstName, LastName, Email, DisplayName, UserTypeId, RoleId)
    VALUES (N'Aidan', N'Stengel', @Email, N'Aidan Stengel', @StaffTypeId, @AdminRoleId);

SELECT u.Id, u.Email, r.Name AS RoleName
FROM dbo.Users u
JOIN dbo.Roles r ON r.Id = u.RoleId
WHERE u.Email = @Email;
