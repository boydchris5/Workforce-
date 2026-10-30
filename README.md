# Fager-McGee Workforce Scheduler

A web app for scheduling field staff by project. It works in any browser on a computer or phone, and phones can add it to the home screen like an app.

## What it does

| Area | Who can use it | What it does |
|---|---|---|
| **Schedule** | Everyone can view. The Workforce Manager and superintendents can edit. | Weekly board organized **by project**: each row is a job and each column is a day. **Who's Where** flips the view to show each person's job for each day. Running totals show people and hours per cell, per project, per day and for the week, plus project-to-date hours against budget. |
| **Crew requests & approval** | Superintendents request, manager approves | A superintendent requests crew only on the jobs where they are the listed superintendent; those entries are **Pending** (dashed outline). The workforce manager's own entries are approved immediately. The manager approves or rejects from **Requests** (one at a time, selected, or all), and a **reason is required to reject**. Approved entries show a ✓; rejected entries are struck through with ✕ and the reason, and the person is freed for other jobs. If a superintendent changes an approved entry it goes back to Pending. Field staff, hour verification and payroll see approved work only. |
| **All Jobs board (desktop)** | Everyone views; manager and superintendents drag | One day at a time: every job side by side with its crew, and the crew still available (grouped by trade) on the left. Drag a person onto a job to schedule or request them, between jobs to move them, or back to Available to take them off. Filter and sort by project manager or superintendent. Phones keep the By Project and Who's Where views. |
| **No double booking, split days allowed** | Automatic | Schedule by **total hours per day** (no start times). A person can split a day across two or more jobs. It is blocked as a double booking when they are already on the same job that day, the day would pass the hard limit (12 h by default), or they are marked off. **Anyone scheduled over 8 hours in a day gets a warning**: it shows when you save, as an orange ⚠ on their chips and Who's Where cell, and in a summary at the top of the schedule. Both numbers are set in Admin → Settings. |
| **Copy last week** | Manager, superintendents | Rolls a week's crews forward. Anyone who would be double booked is skipped and listed. |
| **Verify Hours** | Manager, superintendents | Compares projected and actual hours for each person and day. Rows can be confirmed, adjusted or marked as a no-show, or a supervisor can verify everyone as scheduled in one click. Shows variance, the pending count and who verified each row. |
| **Employees** | Everyone can view. Manager and superintendents can edit. | Employee list with union trade, local, classification, phone, and skills and certifications with expiration dates (expired ones are flagged in red). Filter by trade or skill. Classification drives project roles: "Superintendent" or "Foreman" can be picked as a project superintendent; "Project Manager" can be picked as PM (project managers are office staff, so they are left out of the crew picker and Who's Where). |
| **Projects** | Everyone can view. Manager and superintendents can edit. | Job number, **project manager**, **superintendent/foreman**, address (opens in maps on a phone), budgeted labor hours, status and board color. Click any column header to sort (e.g. by project manager) or filter by project manager. The superintendent list shows employees classified Superintendent or Foreman; the project manager list shows employees classified Project Manager. The schedule can also be filtered and sorted by project manager or superintendent. |
| **Records** | Everyone | Searchable history of every crew-day by date range, project, employee, trade and status, with hours by project and by trade. Exports to CSV for Excel. |
| **🔒 Payroll** | Admin, plus anyone given payroll access | Private pay rates (base, fringe, burden %) with **effective dates and full history**. Every day worked is costed at the rate in effect that day, so past weeks keep the rate actually paid and a union increase applies only from its start date. A "Union increase for a trade" button adds a dated raise for everyone in a trade at once. The labor cost forecast covers 1–26 weeks (pick a past week to see historical cost), broken down by week, project × week, project, trade and employee. Overtime is calculated after 40 hours a week at 1.5× (both adjustable). Pay rates are stored in a separate table that no other screen reads. |
| **My Schedule** | Field staff with a linked login | A phone-friendly list of upcoming days, job, start time and task. |
| **Admin** | Workforce Manager | Users and roles, payroll access, company settings, activity log (who changed what) and a one-click database backup. |

## Roles

- **Workforce Manager (admin):** builds the schedule (entries are approved immediately), approves or rejects superintendents' requests, and has full access including users, settings, backups and payroll.
- **Superintendent:** requests crew on the jobs where they are the listed superintendent (requests need the manager's approval), marks time off and verifies hours. Their login must be linked to their employee record. No payroll access unless it is granted.
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

## Upgrading

The database upgrades itself on startup. Earlier versions are migrated in place: schedule history is kept, each person's single pay rate becomes the first entry in their rate history, and a project's superintendent carries over when that user login is linked to an employee record.

## Project layout

```
server/
  index.js    startup + first-run admin
  app.js      API routes (auth, schedule, verification, records, payroll, admin)
  db.js       SQLite schema
  payroll.js  OT and cost math
  seed.js     demo data
public/       front end (plain HTML/CSS/JS, no build step)
test/         API tests (node --test)
```
