# VSB Service Desk MVP

This is the first working version of the new service desk, built from the
final design in [docs/design.md](docs/design.md). It covers build steps 1 to
3 of the design: the database, the API and the web app.

## What works in this MVP

- Staff sign in with their `@vsb.org` Microsoft account. Anyone else is
  refused. The staff email domains are a setting (Settings, Organization).
  A person's account is created the first time they sign in.
- Submit a request: pick the ticket type first (Support, Access & Equipment
  or Equipment Rental), and the form shows the fields set up for that type.
  Access & Equipment then asks for its category (Onboarding, Access &
  Equipment Change or Off Boarding), and shows that category's fields.
  Subject, Description, Priority, CC and Attachments are on every type.
- A home page: Create new buttons for each ticket type, a few counts, and
  the five latest things that happened. Technicians, admins and Event
  Managers get Go to and Manage requests sections at the top.
- One Equipment Rental / Event Booking form: equipment, a room, or both (the
  room is optional). Each request is one ticket. HR (Event Managers)
  confirms or declines the room on the ticket, and sees only the room part:
  no equipment, no technician notes, no status or technician. IT handles the
  equipment. A request with only a room stays out of IT's lists and closes
  itself after the event. The requester can change or cancel, and moving
  the event moves the equipment dates.
- The Tickets, Rentals & Events and People lists all have tabs, search,
  filters and sortable columns. Every tab is the person's own saved filter
  set: they can change and save it, add new tabs, rename, reorder and remove
  them, or reset to the defaults admins set in Settings > Default tabs.
- Department managers can switch on "Show my departments' tickets" and
  reply on those tickets. Anyone CC'd on a ticket sees it in their lists.
- Staff can submit a request for a coworker: the coworker becomes the
  requester and the person submitting is CC'd. Technicians use the
  Requester box instead.
- The ticket page: the conversation, replies, technician notes (hidden from
  the requester), HR notes on bookings (HR and technicians), attachments,
  the side panel for status, technician, priority, type, category and the
  rest, and the history of every change. Pick up assigns an unassigned
  ticket to you after asking for any missing category, subcategory or
  department. Close ticket asks for a written resolution (technicians only)
  and is the only way to close a ticket by hand.
- Rich text in descriptions, replies, notes and the booking guidelines:
  bold, italic, underline, lists and links, and pictures pasted or dragged
  into the text.
- Status rules: a technician reply sets Awaiting User Response, a requester
  reply switches it back (the target status is a setting), and closing stamps
  the close date.
- Equipment on tickets with costs, a double-booking warning for rentals and
  bookings, and marking items out and returned.
- Onboarding, Access & Equipment Change and Off Boarding checklists. Ticking
  an item hands out or collects equipment and assigns or frees a license
  seat. A change can add and remove in one ticket, and technicians can add
  checklist lines on the ticket page.
- The Inventory page, with Equipment and Licenses: on-hand counts with − and
  +, costs, the monthly license spend, adding an item with its quantity and
  cost, a low-stock "Warn at" number per item (or none), deleting an item
  once nothing is out, and a change history. Any technician can edit it.
- The People page and a page per person: what they hold (with Mark
  returned, Remove seat and Assign), their tickets, their change history,
  and buttons that open the request form filled in for a change, off
  boarding or onboarding. Closing an Off Boarding ticket turns the account
  off and closing an Onboarding ticket turns it back on. Admins set roles;
  any technician can set a department.
- The Settings page (the gear in the header), grouped by area, where admins
  edit every list, the form fields for each ticket type, email templates,
  notification addresses, shared views, the organization's name, time zone,
  staff email domains and mailbox, and the general settings. Every section
  keeps its own change history. Event Managers see only Rooms, Booking
  guidelines and Room statuses.
- New ticket numbers start at 0010000.
- Email, each part behind its own switch in Settings > Email, and every
  switch Off until you turn it on (script 13):
  - Incoming: new emails become tickets, replies land on their ticket
    (found by `Ticket #0010023` or the old desk's `##0005854##` in the
    subject, or by the reply headers), a reply always reopens a closed
    ticket, and mail from unknown senders can wait in Held mail. The
    mailbox is only read: nothing is moved, deleted or marked read.
  - Outgoing: ticket received, the IT team alert, technician and HR
    replies (with the conversation below, newest first), the requester
    reply alert, the waiting on you warning, closed and survey, and the
    booking emails. Branded with the logo and header color. Replies that
    weren't emailed say "Not emailed" on the ticket.
  - Automations: the business day 4 automatic close (8:15 in the morning in
    the desk's time zone, skipping weekends and Holidays) and writing room
    bookings to the events calendar.
- The satisfaction survey page (no sign-in needed), with the answer shown to
  technicians on the ticket.
- Merging a ticket into another, Held mail, error alert emails, and the
  Email status line in Settings.
- Settings > System > Access and maintenance: keep staff out of the web app
  until the desk opens to them, and maintenance mode (only technicians and
  admins get in, and all mail is read from and sent to the testing
  mailbox).

## Not in this MVP yet

- The one-time import from the SharePoint lists (waits on a sample export).
- Reports.

## What's in the zip

- `database/` holds the SQL scripts, numbered in the order you run them.
- `api/` holds the API, an Azure Functions app (Node.js). It replaces the
  `api/` folder in the repo.
- `frontend/` holds the web app (React). It replaces the `frontend/` folder
  in the repo.
- `docs/design.md` is the final design.
- `swa-cli.config.json` runs everything on your computer.

## Before you start

You need these on your computer:

- [Node.js](https://nodejs.org) 20 or later.
- [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
  version 4.
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli),
  signed in with `az login` as `astengel@vsb.org`.
- VS Code with the SQL Server (mssql) extension, which you already use.
- The Static Web Apps CLI, for running the app locally:
  `npm install -g @azure/static-web-apps-cli`.

The names below match your resource group. Where a name is new (the Storage
account, the Function App and the Static Web App), you can pick another one;
just use your name everywhere the README shows mine.

- Resource group: `rg-VSB-ServiceDesk` (East US)
- SQL server: `sv-vsb-servicedesk`
- Database: `db-VSB-ServiceDesk`
- Storage account (new): `stvsbservicedesk`
- Function App (new): `func-vsb-servicedesk`
- Static Web App (new): `swa-vsb-servicedesk`

## Step 1. Set up the database

Your tables only hold test data, but the scripts keep it. Each script only
makes a change if it hasn't been made yet, so running one twice is safe.

1. In VS Code, connect to `db-VSB-ServiceDesk` with your Microsoft Entra
   account (the "ServiceDesk" connection).
2. Run `database/00_inspect.sql`. It changes nothing. It lists every column
   so you can see the current shape.
3. Run these in order, one at a time, and check each one ends with its
   "Step N complete" message:
   1. `01_prepare_existing_tables.sql` renames `Users.UserId` to `Id`,
      `Departments.DepartmentId` to `Id` and `Departments.DepartmentName` to
      `Name`, so every table uses the same pattern. It also removes the
      tables from the first zip if you ran it.
   2. `02_lookups.sql` creates the lists (statuses, priorities, categories,
      subcategories, sources, ticket types, holidays, user types, roles and
      billing periods) with their starting values, and adds `Code`,
      `SortOrder` and `IsActive` to Departments.
   3. `03_users.sql` adds the new columns to Users (display name, user type,
      role, department, active, created date), makes email addresses unique
      and lower case, and creates `DepartmentManagers`. It copies each
      person's primary department from `UserDepartments` onto Users, and
      copies the rows marked `IsManager` into `DepartmentManagers`.
   4. `04_catalog.sql` creates the inventory items and software lists.
   5. `05_tickets.sql` creates `Tickets`, `TicketConversations` and the
      other ticket tables, the form fields for each ticket type, and the
      settings.
   6. `07_make_admin.sql` makes `astengel@vsb.org` the first Admin.
   7. `08_ticket_types_and_event_booking.sql` reduces the ticket types to
      Support, Access & Equipment and Equipment Rental, makes categories
      belong to a ticket type, adds the Event Manager role, and creates the
      event booking tables (`BookingStatuses`, `Rooms`, `EventBookings` and
      `BookingEvents`). See "Ticket types and event booking" below.
   8. `09_visual_overhaul.sql`, `10_delete_retired_ticket_types.sql`,
      `11_one_ticket_bookings.sql`, `12_light_and_dark_mode.sql`,
      `13_email_and_automation.sql` and
      `15_personal_tabs_and_ticket_actions.sql`. Scripts 09, 10, 11, 13 and
      15 have their own sections below.
4. Leave `06_grant_function_app.sql` for Step 3.

If `03_users.sql` prints a WARNING about duplicate emails, remove the
duplicates and run it again.

The old `UserDepartments` table is left in place. Once you've checked
`Users.DepartmentId` and `DepartmentManagers` look right, drop it with
`DROP TABLE dbo.UserDepartments;`.

I tested these scripts on SQL Server 2022 against a copy of your current
table shape, twice in a row, with no errors.

## Step 2. Create the Storage account for attachments

1. In the Azure portal, create a Storage account in `rg-VSB-ServiceDesk`:
   name `stvsbservicedesk`, region East US, Standard performance, locally
   redundant storage (LRS).
2. Under Configuration, set "Allow Blob anonymous access" to Disabled.
3. Under Data storage, Containers, add a container named `attachments` with
   access level Private.
4. Under Access control (IAM), add the role "Storage Blob Data Contributor"
   for yourself, so you can run the app locally.

## Step 3. Create the Function App (the API)

1. In the portal, create a Function App in `rg-VSB-ServiceDesk`:
   - Hosting plan: Flex Consumption
   - Name: `func-vsb-servicedesk`
   - Runtime stack: Node.js, version 20 or later
   - Region: East US
   - Storage: `stvsbservicedesk`
   - Application Insights: on
2. Under Settings, Identity, turn the System assigned identity On and save.
3. Under Settings, Environment variables, add:
   - `SQL_SERVER` = `sv-vsb-servicedesk.database.windows.net`
   - `SQL_DATABASE` = `db-VSB-ServiceDesk`
   - `STORAGE_ACCOUNT` = `stvsbservicedesk`
   - `ATTACHMENTS_CONTAINER` = `attachments`
   - `ALLOWED_EMAIL_DOMAINS` = `vsb.org` (only used until script 11 adds
     the staff email domains setting)
4. Let it use the database without a password:
   1. Open `database/06_grant_function_app.sql` and replace
      `func-vsb-servicedesk` with your Function App's name if it differs.
   2. Run it in VS Code, signed in as the SQL server's Microsoft Entra
      admin.
5. Let it use the attachments container: on the Storage account, under
   Access control (IAM), add the role "Storage Blob Data Contributor" for
   the managed identity `func-vsb-servicedesk`.
6. Let it reach the SQL server: on `sv-vsb-servicedesk`, under Security,
   Networking, tick "Allow Azure services and resources to access this
   server" and save.
7. Deploy the code. In a terminal:

   ```bash
   cd api
   func azure functionapp publish func-vsb-servicedesk --javascript --build remote
   ```

   Or use "Deploy to Function App" from the Azure Functions extension in
   VS Code.

Don't add an `AZURE_CLIENT_ID` setting to the Function App. The code uses
the system assigned identity automatically.

## Step 4. Register the app for sign-in

1. In the portal, open Microsoft Entra ID, App registrations, New
   registration:
   - Name: `VSB Service Desk`
   - Supported account types: "Accounts in this organizational directory
     only" (single tenant, `vsb.org` only)
   - Redirect URI: leave empty for now. You add it in Step 5.
2. On the Overview page, copy the Application (client) ID and the Directory
   (tenant) ID.
3. Under Certificates & secrets, add a client secret and copy its Value.
   Note when it expires, because sign-in stops working on that date until
   you add a new one.
4. Under Authentication, tick "ID tokens" and save.
5. In `frontend/public/staticwebapp.config.json`, replace `<TENANT_ID>`
   with the Directory (tenant) ID.

## Step 5. Create the Static Web App

1. Push the code to GitHub first (see "Putting the code in the repo"
   below), so the Static Web App can build it.
2. In the portal, create a Static Web App in `rg-VSB-ServiceDesk`:
   - Name: `swa-vsb-servicedesk`
   - Plan type: Standard (needed for your own sign-in and the linked API)
   - Source: GitHub, repository `Virginia-State-Bar/ServiceDesk`, branch
     `main`
   - Build presets: React
   - App location: `/frontend`
   - Api location: leave empty
   - Output location: `dist`

   Azure adds a GitHub Actions workflow to the repo and runs the first
   build.
3. Under Settings, Environment variables, add:
   - `AZURE_CLIENT_ID` = the Application (client) ID from Step 4
   - `AZURE_CLIENT_SECRET` = the client secret Value from Step 4
4. Under Settings, APIs, link the Production environment to the Function
   App `func-vsb-servicedesk`. Once linked, the Function App only accepts
   calls that come through the Static Web App.
5. Copy the Static Web App's URL from Overview. Back in the app
   registration, under Authentication, add a Web redirect URI:
   `https://<your-static-web-app-host>/.auth/login/aad/callback`.
   If you add a custom domain later, add its callback URL too.

### Ticket types and event booking (script 08)

If you already ran steps 01 to 07, run only `08_ticket_types_and_event_booking.sql`.
It is safe to run twice. In plain terms it:

- Renames the Access Request type to Access & Equipment and gives it three
  categories: Onboarding, Access & Equipment Change and Off Boarding.
- Retires (hides) the Event Booking, Equipment Provisioning, Onboarding and
  Offboarding types. Nothing is deleted. Test tickets of the old Onboarding,
  Offboarding and Access Request types move to Access & Equipment with the
  matching category. Old Event Booking and Equipment Provisioning test
  tickets stay as they are.
- Puts every existing category (Phone, iMIS and the rest) under Support.
- Moves the onboarding and offboarding checklist setting from ticket types
  to categories, and drops the `TicketTypes.ChecklistSource` column.
- Lets form fields be set per category, and sets up the Access & Equipment
  form fields the first time it runs.
- Adds the Event Manager role, for HR. Event Managers handle room bookings
  and the room list, and nothing else.
- Creates the booking tables and the booking settings, including the VSB
  Events calendar address (`VSBEventsCalender@vsb.org`) for later.
- Widens `Settings.Value` to 4,000 characters for the booking guidelines.

After running it, publish the API again (it won't work with the new tables
until you do), then on the Event bookings page add your rooms and the
guidelines, and on the People page set HR's role to Event Manager.

### Visual overhaul (script 09)

If you already ran steps 01 to 08, run only `09_visual_overhaul.sql`. It is
safe to run twice. In plain terms it:

- Adds the `SavedViews` table for saved and shared list views.
- Adds the `ChangeLog` table for the change history on Settings, Inventory
  and each person.
- Adds the `EquipmentStatuses` list (Requested, Checked out, Returned).
- Lets equipment be handed straight to a person without a ticket
  (`TicketItems.HolderId`), and lets inventory items and software be deleted
  without losing their history (`IsDeleted`).
- Adds settings for the HR email addresses, the low-stock warning and the
  six email templates.

After running it, publish the API again.

## Step 6. First sign-in and setup

1. Open the Static Web App's URL and sign in as `astengel@vsb.org`. You see
   every tile on the home page and the Settings gear because Step 1 made you
   an Admin.
2. In Settings, Lists:
   - Add your subcategories under each category.
   - Add the year's holidays.
   - Add inventory items with their cost and the number owned. Tick
     "Onboarding default" on the items every new hire gets.
   - Add software with its cost per seat, billing period and seats bought.
     Tick "Onboarding default" on the licenses every new hire gets.
   - Check departments have the right names.
3. In Settings, Form fields, check the fields each ticket type shows.
4. In Settings, General, check the status rules. Leave Outgoing email set to
   Off.
5. Ask the IT team to sign in once, then promote them on the People page by
   setting their role to Technician (or Admin).

## Run it on your computer

1. Copy `api/local.settings.example.json` to `api/local.settings.json`.
   The values already point at your Azure database and Storage account.
2. Make sure you are signed in with `az login`. The API uses your own
   account for the database and Storage, so no passwords are needed.
3. Add your computer's IP address to the SQL server's firewall (on
   `sv-vsb-servicedesk`, Security, Networking) if it isn't there already.
4. Install the packages once:

   ```bash
   cd api && npm install && cd ..
   cd frontend && npm install && cd ..
   ```

5. Start everything from the top folder:

   ```bash
   swa start servicedesk
   ```

6. Open `http://localhost:4280`. The CLI shows a pretend sign-in page: type
   your `@vsb.org` email as the username and sign in.

Local runs use the real database, so tickets you create locally are real
rows.

## Putting the code in the repo

1. In your `VSBServiceDesk` folder, replace the `api/` and `frontend/`
   folders with the ones from this zip, and add `database/`, `docs/`,
   `swa-cli.config.json` and `.gitignore`.
2. The old `createUser.js`, `getUsers.js` and `getDepartments.js` functions
   are gone. The new API covers what they did, using the renamed columns.
3. Commit and push to `main`, or open a pull request if you want me to
   review the change first.

## Who can do what

- Requesters (everyone who signs in) submit requests, see tickets they asked
  for or that are for them, reply until a ticket is closed, and download
  their tickets' files.
- Technicians also see the queue, every ticket, technician notes and
  history. They edit ticket fields, assign tickets, add equipment, work
  checklists, log tickets for other people (including adding someone who
  isn't listed), and use the People and Inventory pages.
- Admins also use Settings, set people's roles and share saved views.
- Everyone can book a room or rent equipment, and change or cancel their own
  requests.
- Event Managers (HR) see every request with a room on the Event bookings
  page and on its ticket: the event, the room, replies, HR notes and the
  room's history. They confirm, decline and change bookings, reply to the
  requester, add HR notes, and manage the rooms and the booking guidelines.
  They don't see any equipment, technician notes, or tickets without a room
  other than their own.
- Only HR and Admins confirm or decline rooms. Technicians see every request
  with equipment, but not requests that only book a room.

Roles come from the Roles list. A role with Technician ticked gives
technician access, Admin ticked gives both, and Event Manager ticked gives
event booking access.

### Delete the retired ticket types (script 10)

Run `10_delete_retired_ticket_types.sql` once to remove the four ticket types
that script 08 turned off: Event Booking, Equipment Provisioning, Onboarding
and Offboarding. They only hold test data. In plain terms it:

- Deletes those four types with their categories, subcategories and form
  fields, and their test tickets with each ticket's replies, notes,
  attachment records, CCs, equipment lines, checklist, survey and history.
- Keeps license seats, event bookings and inbound emails that pointed at one
  of those tickets, and just unlinks them.
- Leaves Support, Access & Equipment and Equipment Rental alone.

It runs as one transaction, so nothing changes if any part fails. Set
`@PreviewOnly = 1` at the top to see the counts first. No API publish is
needed.

### One ticket for rentals and event bookings (script 11)

Run `11_one_ticket_bookings.sql` once, then publish the API. It is safe to
run twice. In plain terms it:

- Makes each event booking part of a ticket. A booking that already has an
  Equipment Rental ticket joins that ticket; a booking without one gets a
  new ticket. Bookings that are over, declined or cancelled get a closed
  ticket. The room details move to a new `TicketRooms` table, and the
  booking's history is copied onto the ticket.
- Drops the `EventBookings` and `BookingEvents` tables afterwards.
- Renames the Equipment Rental type to Equipment Rental / Event Booking.
- Turns the text already saved in descriptions, replies, notes and the
  booking guidelines into rich text, keeping line breaks.
- Gives each equipment item its own low-stock "Warn at" number, starting
  from the old single setting, and removes that setting.
- Adds the organization settings: app name, organization name, time zone,
  staff email domains and an empty testing mailbox.
- Widens `Settings.Value` so long guidelines fit.

Everything after the new columns and tables runs as one transaction, so
nothing changes if any part fails.
It ends with "Step 11 complete: rentals and event bookings are one ticket."

Then publish the API:

```bash
git checkout main; git pull; cd api
func azure functionapp publish func-vsb-servicedesk --javascript --build remote
```

The website updates on its own when the change is merged.

### Personal tabs, managers, Pick up and Close ticket (script 15)

Run `15_personal_tabs_and_ticket_actions.sql` once, **before** publishing
the API (the same two commands as above). It is safe to run twice. In plain
terms it:

- Turns every list tab into each person's own saved tab, and adds the
  default tabs (the same ones the lists had) for requesters, event managers
  and technicians. Each person gets a copy the first time they open a list.
- Copies each team view an admin shared to every technician as their own
  tab, then removes the shared copy. Team sharing is gone.
- Adds the remembered "Show my departments' tickets" switch for managers.
- Adds resolutions to the ticket conversation for Close ticket.

After publishing, Closed is no longer offered in the Status dropdown or the
reply box: Close ticket is the only way to close a ticket by hand. Automatic
closes (no answer after the waiting period, merges, finished room-only
bookings) still happen on their own and keep their line in the ticket's
history.

### Email, automations and maintenance mode (script 13)

Run `13_email_and_automation.sql` once, then publish the API (the same two
commands as above). It is safe to run twice. In plain terms it:

- Adds the Settings > Email switches (Incoming, Outgoing, Automations) and
  sets **every one to Off**. Nothing is read from or sent to any mailbox,
  and nothing is written to the calendar, until you turn a switch on. The
  old single "Outgoing email" setting is removed and its value is not
  copied.
- Adds "Staff can use the web app" (On) and "Maintenance mode" (Off) under
  Settings > System > Access and maintenance.
- Adds the error alert list (empty, so no alerts go out until you fill it),
  the app's web address for links in emails, and four new email templates.
  The six existing template subjects change to the `Ticket #0010023:
  Subject` form, only where nobody has edited them.
- Adds the tables for mail the app has read and sent, merged tickets, and
  the Email status line.

#### Let the app reach the mailboxes

The Function App signs in to Microsoft Graph as its managed identity. Give
it access with Exchange Online "RBAC for Applications", limited to the
desk's mailboxes, so it can't reach any other mailbox. Don't also grant the
Graph permissions in Entra ID: those would cover every mailbox.

1. In the Azure portal, open Microsoft Entra ID > Enterprise applications,
   change the filter to Managed Identities, and open
   `func-vsb-servicedesk`. Note its **Application ID** and **Object ID**.
2. In PowerShell, as an Exchange admin:

```powershell
Connect-ExchangeOnline
$appId = "<Application ID>"
$objectId = "<Object ID>"
New-ServicePrincipal -AppId $appId -ObjectId $objectId `
  -DisplayName "func-vsb-servicedesk"
$scope = "Service desk mailboxes"
$filter = "PrimarySmtpAddress -eq 'servicedesk@vsb.org'" +
  " -or PrimarySmtpAddress -eq 'sdtest@vsb.org'" +
  " -or PrimarySmtpAddress -eq 'VSBEventsCalender@vsb.org'"
New-ManagementScope -Name $scope -RecipientRestrictionFilter $filter
$roles = "Application Mail.Read", "Application Mail.Send",
  "Application Calendars.ReadWrite"
foreach ($role in $roles) {
  New-ManagementRoleAssignment -App $objectId -Role $role `
    -CustomResourceScope $scope
}
Test-ServicePrincipalAuthorization -Identity $objectId -Resource sdtest@vsb.org
Test-ServicePrincipalAuthorization -Identity $objectId -Resource someone.else@vsb.org
```

The first test should list the three roles with `InScope` True; the second
should show `InScope` False. Changes can take up to an hour to apply.

Optional: the Graph permission User.Read.All (granted in Entra ID) lets the
app tell shared mailboxes apart when it creates accounts for new senders.
Without it they count as staff, and you can change the Account type on the
person's page.

#### The events calendar

The calendar is written as a mailbox (`/users/VSBEventsCalender@vsb.org`).
Microsoft doesn't support this kind of app access on Microsoft 365 group
calendars, so test it during the trial: turn on "Write room bookings to the
events calendar", book a room, and check the calendar. If it doesn't
appear, the ticket's history says "Events calendar not updated" with the
reason, and the switch can go back Off while a fallback is chosen.

#### Turning email on (trial first)

1. Settings > Organization: check the testing mailbox (`sdtest@vsb.org`)
   and the app's web address.
2. Settings > Notifications: add yourself to Error alert recipients.
3. Settings > System > Access and maintenance: turn on Maintenance mode.
   Staff and HR now see a "down for maintenance" page. All mail is read
   from and sent to the testing mailbox only, with the real recipients
   written at the top of each email.
4. Settings > Email: turn on the Incoming and Outgoing switches you want to
   try. Turning incoming on for the first time sets "Only read mail
   received after" to that moment, so old mail never becomes tickets.
5. On cutover day, turn the old desk's Power Automate flow off, then turn
   Maintenance mode off. From then on the app reads and sends from
   `servicedesk@vsb.org`.

Settings > Email shows the last mailbox check, anything failing, and how
much mail went out in the last day.
