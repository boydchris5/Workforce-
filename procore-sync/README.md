# Procore Timecard Sync

Pulls project-level Timesheet / Timecard Entry data out of the Procore sandbox
(company ID **4293208**) and writes it to an `.xlsx` workbook.

## Prerequisite: Developer Managed Service Account (DMSA)

This script authenticates with OAuth 2.0 **Client Credentials**, which is not
tied to a logged-in user. Procore requires a **Developer Managed Service
Account (DMSA)** to be set up for your app before client-credentials calls
will return any data:

1. In the Procore Developer Portal, open your app's **Manage App** page.
2. Configure the app's **company-level and/or project-level tool
   permissions** -- grant it access to the **Timesheets** tool for company
   4293208 (and the projects you want to sync).
3. Once tool permissions are defined, Procore generates the Client ID /
   Client Secret shown on the **OAuth Credentials** section of that page --
   these are the values that go into `PROCORE_CLIENT_ID` /
   `PROCORE_CLIENT_SECRET` below. Make sure you're using the **sandbox**
   pair, not the production pair.

Without this setup, `--test` will fail with a 401/403 even with correct
credentials.

## Setup

```bash
python -m pip install -r requirements.txt
```

Set credentials as persistent environment variables (PowerShell), then open
a **new** terminal so they're picked up:

```powershell
setx PROCORE_CLIENT_ID "your-sandbox-client-id"
setx PROCORE_CLIENT_SECRET "your-sandbox-client-secret"
```

Optional overrides (env vars, only needed if the defaults below turn out to
be wrong for your sandbox -- see "Known unknown" below):

- `PROCORE_COMPANY_ID` (default `4293208`)
- `PROCORE_OAUTH_BASE_URL` (default `https://login-sandbox.procore.com`)
- `PROCORE_API_BASE_URL` (default `https://sandbox.procore.com/rest/v1.0`)

## Usage

Test the connection first:

```bash
python sync_timecards.py --test
```

This authenticates, fetches the company record, and lists the projects your
app can see. Fix any errors here before running a real sync.

Sync timecard entries for all projects in the last 30 days:

```bash
python sync_timecards.py
```

Sync a specific date range / single project:

```bash
python sync_timecards.py --start-date 2026-10-01 --end-date 2026-10-31 --project-id 123456
```

Output defaults to `timecards_<timestamp>.xlsx` in the current directory;
override with `--output path\to\file.xlsx`.

## Verified against the sandbox

Both confirmed working against company 4293208 ("Fager-McGee Workforce Sync")
on 2026-11-04:

- **Hostnames** -- the defaults (`https://login-sandbox.procore.com` for
  OAuth, `https://sandbox.procore.com/rest/v1.0` for the API) are correct.
  The DMSA for this app was already configured with Timesheets access.
- **Timecard entry fields** -- `normalize_entry()` in `sync_timecards.py` is
  built from a real entry response. Key mappings: the person is under
  `party` (`user_id`/`id`, `name`, `employee_id`), the cost code is under
  `cost_code.full_code`, the labor category is `timecard_time_type.time_type`
  (e.g. "Regular Time"), and the entry's approval state is `approval_status`
  (not `status`, which only exists at the parent timesheet level). This
  sandbox's timesheets are configured for straight hours entry, so `hours`
  is populated and `time_in`/`time_out` are `null` -- if a project uses
  Start/Stop time entry instead, expect the reverse.

## Files

- `procore_client.py` -- OAuth token handling + paginated REST calls.
- `sync_timecards.py` -- CLI: `--test` connection check, or run a sync to an `.xlsx` file.
- `workforce_client.py` -- session-auth client for the Fager-McGee Workforce Scheduler app's internal API.
- `sync_to_workforce.py` -- CLI: pulls Procore timecard entries and pushes them into the workforce app's `POST /api/timecards/import`.
- `requirements.txt` -- `requests`, `openpyxl`.

## Syncing into the Workforce Scheduler app (`sync_to_workforce.py`)

The [Workforce Scheduler app](https://github.com/boydchris5/Workforce-) already
has a built-in "Import Procore time cards" feature (normally driven by
uploading a CSV exported from Procore by hand). This script does the same
thing, but pulls directly from the Procore API instead of a manual CSV
export, and POSTs the parsed rows to the app's existing
`/api/timecards/import` endpoint -- no changes to the app itself were
needed.

**Matching**: the app matches each line to an employee by Employee # (falls
back to full name) and to a project by Job/Project Number, both against its
own `employees`/`projects` tables. Lines that don't match an existing
employee or project are listed as "unmatched" in the preview rather than
silently dropped or guessed at.

**Replace semantics**: re-running the sync for a date range **replaces**
whatever time card lines already exist in the app for that range (this is
the app's own import behavior, not something this script added). Always
check the preview before committing.

### Setup

In addition to the Procore env vars above, set:

```powershell
setx WORKFORCE_APP_URL "https://workforce-scheduler-9ar8.onrender.com"
setx WORKFORCE_USERNAME "sync"
setx WORKFORCE_PASSWORD "..."
```

The app has no API-key system -- it's session-cookie auth only, so this uses
a dedicated admin-role account (`sync`) created via Admin -> Users in the
app, rather than a real person's login. The `/api/timecards/import` endpoint
is admin-only, so this account must have the "Workforce Manager (admin)"
role.

### Usage

```bash
python sync_to_workforce.py --test
```

Tests both the Procore connection and the workforce app login.

```bash
python sync_to_workforce.py --start-date 2026-10-01 --end-date 2026-10-31
```

**Preview only** (default) -- pulls from Procore, sends to the app with
`commit: false`, and prints the match/variance/unmatched/error summary. No
data is changed.

```bash
python sync_to_workforce.py --start-date 2026-10-01 --end-date 2026-10-31 --commit
```

Applies the import for real: writes `timecard_entries` rows and updates
`assignments.timecard_hours` / `actual_hours` in the workforce app, exactly
as if the CSV had been uploaded through the UI.
