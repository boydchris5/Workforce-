# Fager-McGee Workforce Scheduler

A web app for scheduling field staff by project. It works in any browser on a computer or phone, and phones can add it to the home screen like an app.

## What it does

| Area | Who can use it | What it does |
|---|---|---|
| **Schedule** | Everyone can view. The Workforce Manager and superintendents can edit. | Weekly board organized **by project**: each row is a job and each column is a day. **Who's Where** flips the view to show each person's job for each day. Running totals show people and hours per cell, per project, per day and for the week, plus project-to-date hours against budget. |
| **No double booking** | Automatic | A person can be on only **one project per day**, and can't be scheduled on a day marked as time off. The scheduling screen greys out anyone who is already booked. The server rejects conflicts, and the database has a unique constraint on employee + date as the final safeguard. |
| **Copy last week** | Manager, superintendents | Rolls a week's crews forward. Anyone who would be double booked is skipped and listed. |
| **Verify Hours** | Manager, superintendents | Compares projected and actual hours for each person and day. Rows can be confirmed, adjusted or marked as a no-show, or a supervisor can verify everyone as scheduled in one click. Shows variance, the pending count and who verified each row. |
| **Employees** | Everyone can view. Manager and superintendents can edit. | Employee list with union trade, local, classification, phone, and skills and certifications with expiration dates (expired ones are flagged in red). Filter by trade or skill. |
| **Projects** | Everyone can view. Manager and superintendents can edit. | Job number, superintendent, address (opens in maps on a phone), budgeted labor hours, status and board color. |
| **Records** | Everyone | Searchable history of every crew-day by date range, project, employee, trade and status, with hours by project and by trade. Exports to CSV for Excel. |
| **🔒 Payroll** | Admin, plus anyone given payroll access | Private pay rates (base, fringe, burden %) and a labor cost forecast over 1–26 weeks: by week, project × week, project, trade and employee. Overtime is calculated after 40 hours a week at 1.5× (both adjustable). Pay rates are stored in a separate table that no other screen reads. |
| **My Schedule** | Field staff with a linked login | A phone-friendly list of upcoming days, job, start time and task. |
| **Admin** | Workforce Manager | Users and roles, payroll access, company settings, activity log (who changed what) and a one-click database backup. |

## Roles

- **Workforce Manager (admin):** full access, including users, settings, backups and payroll.
- **Superintendent:** schedules crews, marks time off and verifies hours on any project. No payroll access unless it is granted.
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
