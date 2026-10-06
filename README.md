# VSB Service Desk MVP

This is the first working version of the new service desk, built from the
final design in [docs/design.md](docs/design.md). It covers build steps 1 to
3 of the design: the database, the API and the web app.

## What works in this MVP

- Staff sign in with their `@vsb.org` Microsoft account. Anyone else is
  refused. A person's account is created the first time they sign in.
- Submit a request: pick the ticket type first (Support, Access & Equipment
  or Equipment Rental), and the form shows the fields set up for that type.
  Access & Equipment then asks for its category (Onboarding, Access &
  Equipment Change or Off Boarding), and shows that category's fields.
  Subject, Description, Priority, CC and Attachments are on every type.
- A home page: Create new buttons for each ticket type, a few counts, and
  the five latest things that happened. Technicians, admins and Event
  Managers get Go to and Manage requests sections at the top.
- One Equipment Rental / Event Booking form: equipment, a room, or both (the
  room is optional). HR confirms or declines the room on the record's own
  page, which has its own history. Equipment goes to IT as a linked
  Equipment Rental ticket. Event Managers never see equipment. The requester
  can change or cancel, and moving the dates moves the equipment dates.
- The Tickets, Rentals & Events and People lists all have tabs, search,
  filters, sortable columns and saved views. Admins can share a ticket view
  with the team, where it shows as a "Team:" tab.
- The ticket page: the conversation, replies, technician notes (hidden from
  the requester), attachments, the side panel for status, technician,
  priority, type, category and the rest, Move to Closure, and the history of
  every change.
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
  cost, deleting an item once nothing is out, and a change history. Any
  technician can edit it.
- The People page and a page per person: what they hold (with Mark
  returned, Remove seat and Assign), their tickets, their change history,
  and buttons that open the request form filled in for a change, off
  boarding or onboarding. Closing an Off Boarding ticket turns the account
  off and closing an Onboarding ticket turns it back on. Admins set roles;
  any technician can set a department.
- The Settings page (the gear in the header), grouped by area, where admins
  edit every list, the form fields for each ticket type, email templates,
  notification addresses, the low-stock warning, shared views and the
  general settings. Every section keeps its own change history. Event
  Managers see only Rooms, Booking guidelines and Room statuses.
- New ticket numbers start at 0010000.

## Not in this MVP yet

These are the next build steps from the design:

- Email. The MVP sends no email and does not read `servicedesk@vsb.org`, so
  the live mailbox is untouched. The "ticket received" email, the IT team
  notice, reply emails, the business day 3 warning, the business day 4
  automatic close and the survey come next, behind the Outgoing email switch
  (Off by default).
- The survey page.
- Event booking emails and the VSB Events calendar. Nothing is emailed to HR
  yet and nothing is written to the calendar. Both come with the email step.
- The one-time import from the SharePoint lists.
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
   - `ALLOWED_EMAIL_DOMAINS` = `vsb.org`
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
   npm install
   func azure functionapp publish func-vsb-servicedesk --javascript
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
- Everyone can book an event and change or cancel their own bookings.
- Event Managers (HR) see every booking on the Event bookings page, confirm,
  decline and change bookings, and manage the rooms and the booking
  guidelines. They don't see any equipment, and they can't see tickets
  other than their own. Technicians and Admins can do everything Event
  Managers can.

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
