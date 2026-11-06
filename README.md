# Fager-McGee Workforce Scheduler

A web app for scheduling field staff by project. It works in any browser on a computer or phone, and phones can add it to the home screen like an app.

## What it does

| Area | Who can use it | What it does |
|---|---|---|
| **Schedule** | Everyone can view. The Workforce Manager and superintendents can edit. | Weekly board organized **by project**: each row is a job and each column is a day. **Who's Where** flips the view to show each person's job for each day. Running totals show people and hours per cell, per project, per day and for the week, plus project-to-date hours against budget. **Only jobs with hours** (on by default, remembered per device) hides jobs with no crew scheduled that week – or that day on the phone and All Jobs views – so the list stays short; a note shows how many are hidden with a one-click *Show all jobs*. |
| **Crew requests & approval** | Superintendents request, manager approves | A superintendent requests crew only on the jobs where they are the listed superintendent; those entries are **Pending** (dashed outline). The workforce manager's own entries are approved immediately. The manager approves or rejects from **Requests** (one at a time, selected, or all), and a **reason is required to reject**. Approved entries show a ✓; rejected entries are struck through with ✕ and the reason, and the person is freed for other jobs. If a superintendent changes an approved entry it goes back to Pending. Field staff, hour verification and payroll see approved work only. **Trade requests:** a superintendent can instead ask for a trade and a head count (e.g. *2 × Carpenter*, Tuesday, 8 h) with a short note on the work; it shows on the job as *2 × Carpenter needed* until the manager clicks it, picks people of that trade (availability shown, double booking blocked) and fills in the names – or rejects it with a reason. In All Jobs, dragging a matching person onto the job fills the request. Removing a person who filled a request reopens it. |
| **All Jobs board (desktop)** | Everyone views; manager and superintendents drag | One day at a time: every job side by side with its crew, and the crew still available (grouped by trade) on the left. Drag a person onto a job to schedule or request them, between jobs to move them, or back to Available to take them off. Filter and sort by project manager or superintendent. Phones keep the By Project and Who's Where views. |
| **No double booking, split days allowed** | Automatic | Schedule by **total hours per day** (no start times). A person can split a day across two or more jobs. It is blocked as a double booking when they are already on the same job that day, the day would pass the hard limit (12 h by default), or they are marked off. **Anyone scheduled over 8 hours in a day gets a warning**: it shows when you save, as an orange ⚠ on their chips and Who's Where cell, and in a summary at the top of the schedule. Both numbers are set in Admin → Settings. |
| **Copy last week** | Manager, superintendents | Rolls a week's crews forward. Anyone who would be double booked is skipped and listed. |
| **Verify Hours** | Manager, superintendents | Compares projected and actual hours for each person and day. Rows can be confirmed, adjusted or marked as a no-show, or a supervisor can verify everyone as scheduled in one click. Shows variance, the pending count and who verified each row. Marking a **no-show requires a reason** (e.g. Sick – excused), saved on the employee's attendance history. |
| **Time card import (Procore)** | Workforce Manager imports; manager and superintendents review | Verify Hours runs on the **payroll week** (Admin → Settings, default Wednesday–Tuesday; payroll overtime uses the same week). **Import Procore time cards** takes the weekly time card CSV, matches lines by Employee ID and Project Number, and adds a person's hours per day per job across cost codes. If `PROCORE_CLIENT_ID`/`PROCORE_CLIENT_SECRET` are set (see below), **Sync from Procore…** does the same thing without a CSV -- it pulls time cards directly from the Procore API for a date range you pick. Each row then shows Scheduled vs Time card vs Actual: *Matches*, *Differs*, *Not scheduled – from time card* (added as an entry so the hours count toward the job and payroll; can be removed), or *No time card*. Actual hours stay editable afterwards (the time card total is kept for reference). Lines for people or jobs not in the app are listed; add them and click *Re-match*. Re-importing (or re-syncing) the same dates replaces those time card lines. |
| **Employees** | Everyone can view. Manager, superintendents and the Office Manager can edit. | **One list for everyone** – each person's Type is Union (field crew), Superintendent or Office staff (with department; not on the field schedule). Employee list with union trade, local, classification, phone, and skills and certifications with expiration dates (expired ones are flagged in red). Filter by trade or skill. Classification drives project roles: "Superintendent" or "Foreman" can be picked as a project superintendent; "Project Manager" can be picked as PM (project managers are office staff, so they are left out of the crew picker and Who's Where). Each record has a **Time off** section: enter any future date range (weekdays only by default) with a reason; it appears on the schedule when that week comes up and blocks scheduling. **No-shows** are listed with their reasons. |
| **Import employees** | Workforce Manager | Employees → **Import from spreadsheet…**: upload a CSV (Excel → Save As → CSV) with columns such as Employee #, First Name, Last Name, Phone, Trade, Union Local, Classification, Hire Date, Active, Skills, Notes. A preview shows who will be added, updated, skipped or has errors before anything is saved. Rows are matched by Employee # (then name), so re-importing an updated list updates people instead of duplicating them, and blank cells never erase existing data. Rows whose trade or classification is excluded (default: Clerical, CLER) are skipped. Never put SSNs, pay rates or home addresses in the file. |
| **Projects** | Everyone can view. Manager and superintendents can edit. | Job number, **project manager**, **superintendent/foreman**, address (opens in maps on a phone), budgeted labor hours, status and board color. Click any column header to sort (e.g. by project manager) or filter by project manager. The superintendent list shows employees classified Superintendent or Foreman; the project manager list shows employees classified Project Manager. The schedule can also be filtered and sorted by project manager or superintendent. Each project has an **original budget**, **starting hours** (hours already used before the job was set up in the app, counted in hours to date) and a **change order log** (CO #, description, date, hours; negative for deducts). Total budget = original + change orders. |
| **Import projects** | Workforce Manager | Projects → **Import from spreadsheet…**: CSV with Job Number, Project Name, Customer, Address, City, State, ZIP, Status (or Stage), Start/End Date, Budget Hours, Starting Hours, Change Order Hours, Superintendent, Project Manager, Notes. Matched by job number (re-import updates). Stages map to status (Course of Construction/Warranty → Active; Pre-Construction/Bidding → Planned). Superintendent and PM are matched to employees by name; unmatched names are left blank with a note in the preview. |
| **Records** | Everyone | Searchable history of every crew-day by date range, project, employee, trade and status, with hours by project and by trade. Exports to CSV for Excel. |
| **🔒 Payroll** | Admin, plus anyone given payroll access | Private pay rates (base, fringe, burden %) with **effective dates and full history**. Every day worked is costed at the rate in effect that day, so past weeks keep the rate actually paid and a union increase applies only from its start date. A "Union increase for a trade" button adds a dated raise for everyone in a trade at once. The labor cost forecast covers 1–26 weeks (pick a past week to see historical cost), broken down by week, project × week, project, trade and employee. Overtime is calculated after 40 hours a week at 1.5× (both adjustable). Pay rates are stored in a separate table that no other screen reads. |
| **My Schedule** | Anyone with a linked login | A phone-friendly list of upcoming days, job, hours and task, plus their **time-off balance** and **Request time off**. |
| **Time off (one record for everyone)** | Everyone requests; Workforce Manager / Office Manager approve | Union crew, superintendents and office staff all use one time-off record: requests from My Schedule or Time Off, approval with a required reason to reject, and approved days block scheduling. Types: office staff **PTO / Vacation / Other**, superintendents **PTO / Other**, union crew vacation, sick, jury duty, union business, etc. Office staff have yearly **PTO** and **Vacation** allowances, superintendents **PTO** (defaults in Settings, per-person amounts on Time Off → Balances); union crew have none. Everyone sees the **Who's out** calendar of approved time off for the whole company; each person sees only their own requests and balances. |
| **Union holidays** | Automatic | New Year's, Memorial Day, Independence Day, Labor Day, Veterans Day, Thanksgiving and Christmas are greyed out on the schedule and the Time Off calendar (Saturday holidays observed Friday, Sunday holidays Monday). Scheduling on one is saved with a warning; Mon–Fri and work-days-only time off skip them. |
| **Notifications** | Workforce Manager, Office Manager | New crew requests, trade requests and time-off requests show in the Requests count, and – once SMTP is set up (see below) – each one emails every Workforce Manager who has an email address and “Email me each new request” ticked. Office time-off requests email the Office Manager(s) instead (or the Workforce Manager if no Office Manager has an email). Employees with an email hear back when their time off is approved or rejected. |
| **Admin** | Workforce Manager | Users and roles, payroll access, company settings, activity log (who changed what) and a one-click database backup. |

## Help & user guide

The **? Help** button in the app's top bar opens the built-in user guide (`public/help.html`) at the section for the current page. It covers every screen with screenshots, a quick start for each role, the weekly workflow, a symbols glossary, troubleshooting and an FAQ. Screenshots live in `public/help/img/` and use demo data only.

## Roles

- **Workforce Manager (admin):** builds the schedule (entries are approved immediately), approves or rejects superintendents' requests, and has full access including users, settings, backups and payroll.
- **Superintendent:** requests crew on the jobs where they are the listed superintendent (requests need the manager's approval), marks time off and verifies hours. Their login must be linked to their employee record. No payroll access unless it is granted.
- **Project managers (office):** an Office Staff login with **Can view the field schedule** ticked – view-only access to the schedule, projects, employees and records (opening on their own jobs when linked to their PM employee record), plus Time Off for their own requests.
- **Field staff (viewer):** read-only access to the schedule, employees, projects and records. They see their own schedule if their login is linked to an employee record.

Payroll access is a separate checkbox on each user, so you can grant it to an owner or the CFO without making them admins.

## Hosting (so everyone can reach it)

The app is a single Node.js service with an embedded SQLite database file, so it needs one small server with **persistent storage**.

### Recommended: Render (about $8/month, roughly 15 minutes)
1. Create an account at render.com and connect GitHub.
2. Choose **New → Blueprint** and select this repo. `render.yaml` sets up the web service and a 1 GB persistent disk.
3. Enter an `ADMIN_PASSWORD` when prompted, then deploy.
4. You get an `https://…onrender.com` address. You can add a custom domain such as `crew.yourcompany.com` in Render settings.
5. Sign in as `admin`, then create logins for superintendents and field staff.

### Alternative: Azure App Service (if IT prefers Microsoft 365 / Azure)
Deploy the included `Dockerfile` to an Azure Web App for Containers. Mount Azure Files storage at `/data` and set `ADMIN_PASSWORD`. This keeps the app under your existing Microsoft tenant and makes it easier to add Microsoft sign-in later.

### Backups
Go to **Admin → Settings → Download database backup**. It downloads one file that contains everything. Download one weekly, or set up an automated job that calls `/api/backup`. Render disks also keep daily snapshots.

## Running locally

Requires Node.js 22.13 or newer. Branding (logo, orange #F15A22 / charcoal #2D2D2D palette, contact footer) follows the Fager-McGee brand standard; the logo files are in `public/`.

```bash
npm install
npm run seed      # optional demo data (logins: admin / mjones / tgarcia, password changeme123)
npm start         # http://localhost:3000
npm test
```

On first start with an empty database, an `admin` login is created. Its password is `ADMIN_PASSWORD` if that is set; otherwise a random password is printed in the server log.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `DB_FILE` | `./data/workforce.db` | Database location (put it on persistent storage) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / random | First-run admin login |
| `NODE_ENV=production` | | Marks session cookies Secure (HTTPS only) |
| `PROCORE_CLIENT_ID` / `PROCORE_CLIENT_SECRET` | unset | Enables the **Sync from Procore…** button on Verify Hours (OAuth Client Credentials grant; requires a Developer Managed Service Account -- see `procore-sync/README.md`). Without these, only CSV import is available. |
| `PROCORE_COMPANY_ID` | `4293208` (sandbox) | Which Procore company to sync from |
| `PROCORE_OAUTH_BASE_URL` / `PROCORE_API_BASE_URL` | sandbox hosts | Override to point at Procore production once ready |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | off | Email notifications (e.g. `smtp.office365.com` / `587` / the sending mailbox / its password). Without `SMTP_HOST`, requests show in-app only |
| `MAIL_FROM` | `SMTP_USER` | From address, e.g. `Fager-McGee Workforce <workforce@fager-mcgee.com>` |
| `APP_URL` | request host | The app's address, used for the link in each email |

## Upgrading

The database upgrades itself on startup. Earlier versions are migrated in place: schedule history is kept, each person's single pay rate becomes the first entry in their rate history, and a project's superintendent carries over when that user login is linked to an employee record.

## Project layout

```
server/
  index.js    startup + first-run admin
  app.js      API routes (auth, schedule, verification, records, payroll, admin)
  db.js       SQLite schema
  notify.js   email notifications (SMTP)
  holidays.js union holidays (observed dates)
  payroll.js  OT and cost math
  seed.js     demo data
public/       front end (plain HTML/CSS/JS, no build step)
test/         API tests (node --test)
procore-sync/ Python tool that pulls time cards from the Procore API and
              posts them to /api/timecards/import automatically, instead of
              exporting a CSV from Procore by hand -- see procore-sync/README.md
```
