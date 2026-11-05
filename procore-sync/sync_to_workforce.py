"""Pull project-level Timesheet / Timecard Entry data out of Procore and
push it into the Fager-McGee Workforce Scheduler app's
`POST /api/timecards/import` endpoint.

By default this only PREVIEWS the import (no data is changed in the
workforce app) -- pass --commit to actually apply it. Re-importing a date
range replaces whatever time card lines are already there for those dates,
so always review the preview before committing.

Usage:
    python sync_to_workforce.py --test
        Verify both Procore and the workforce app are reachable.

    python sync_to_workforce.py --start-date 2026-10-01 --end-date 2026-10-31
        Preview the import only -- prints the match/variance/error summary.

    python sync_to_workforce.py --start-date 2026-10-01 --end-date 2026-10-31 --commit
        Actually apply the import.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import date, timedelta

from procore_client import PROJECT_PACING_SECONDS, ProcoreAPIError, ProcoreAuthError, ProcoreClient, ProcoreConfig
from workforce_client import WorkforceAPIError, WorkforceAuthError, WorkforceClient, WorkforceConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--test", action="store_true", help="Test both connections, then exit.")
    parser.add_argument("--start-date", type=str, default=None, help="YYYY-MM-DD, default = 7 days ago.")
    parser.add_argument("--end-date", type=str, default=None, help="YYYY-MM-DD, default = today.")
    parser.add_argument("--project-id", type=int, default=None, help="Limit to a single Procore project ID.")
    parser.add_argument("--commit", action="store_true", help="Apply the import (default is preview-only).")
    return parser.parse_args()


def test_connections(procore: ProcoreClient, workforce: WorkforceClient) -> None:
    print(f"Procore: testing connection to {procore.config.api_base_url} ...")
    try:
        company = procore.test_connection()
        projects = procore.list_projects()
    except (ProcoreAuthError, ProcoreAPIError) as exc:
        print(f"  FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"  OK -- company {company.get('name')!r}, {len(projects)} project(s) visible.")

    print(f"Workforce app: testing connection to {workforce.config.base_url} ...")
    try:
        health = workforce.health()
        if not health.get("ok"):
            raise WorkforceAPIError(f"Unexpected /api/health response: {health}", 0, "")
    except WorkforceAPIError as exc:
        print(f"  FAILED (health check): {exc}", file=sys.stderr)
        sys.exit(1)
    print("  OK -- /api/health reachable.")
    try:
        workforce._ensure_login()  # noqa: SLF001 -- deliberately testing login here
    except WorkforceAuthError as exc:
        print(f"  FAILED (login): {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"  OK -- logged in as {workforce.config.username!r}.")


def entry_to_row(project: dict, entry: dict) -> dict:
    party = entry.get("party") or {}
    cost_code = entry.get("cost_code") or {}
    time_type = entry.get("timecard_time_type") or {}
    return {
        "date": entry.get("date"),
        "employee_id": party.get("employee_id"),
        "employee_name": party.get("name"),
        "project_number": project.get("project_number"),
        "project_name": project.get("name"),
        "cost_code": cost_code.get("full_code") or cost_code.get("name"),
        "cost_code_name": cost_code.get("name"),
        "hours": entry.get("hours"),
        "time_type": time_type.get("time_type") or time_type.get("abbreviated_time_type"),
        "billable": entry.get("billable"),
        "description": entry.get("description"),
    }


def run_sync(procore: ProcoreClient, workforce: WorkforceClient, start_date: str, end_date: str, project_id: int | None, commit: bool) -> None:
    if project_id is not None:
        projects = [p for p in procore.list_projects() if p.get("id") == project_id]
        if not projects:
            print(f"Project {project_id} not found (or not visible to this app).", file=sys.stderr)
            sys.exit(1)
    else:
        # Skip inactive/archived projects by default -- cuts API calls a lot on
        # companies with a long project history, and avoids tripping Procore's
        # rate limit for no benefit (archived jobs don't get new time cards).
        projects = [p for p in procore.list_projects() if p.get("active") is not False]
    print(f"Found {len(projects)} Procore project(s) to pull from.")

    rows: list[dict] = []
    for i, project in enumerate(projects):
        if i > 0:
            time.sleep(PROJECT_PACING_SECONDS)
        pid = project["id"]
        try:
            entries = procore.list_timecard_entries(
                pid, params={"start_date": start_date, "end_date": end_date}
            )
        except ProcoreAPIError as exc:
            print(f"  WARNING: skipping Procore project {pid} -- {exc}", file=sys.stderr)
            continue
        if entries:
            print(f"  Project [{pid}] {project.get('name')}: {len(entries)} timecard entries")
        for entry in entries:
            rows.append(entry_to_row(project, entry))

    if not rows:
        print("No timecard entries found in Procore for this range -- nothing to sync.")
        return

    print(f"\nPulled {len(rows)} timecard entries from Procore. Sending to workforce app ({'COMMIT' if commit else 'PREVIEW only'}) ...")
    filename = f"procore-sync_{start_date}_to_{end_date}.json"
    try:
        result = workforce.import_timecards(rows, filename=filename, commit=commit)
    except WorkforceAPIError as exc:
        print(f"Import call failed: {exc}", file=sys.stderr)
        sys.exit(1)

    preview = result.get("preview", {})
    print("\n--- Summary ---")
    print(f"  Period:            {preview.get('period')}")
    print(f"  Lines sent:        {preview.get('lines')}")
    print(f"  Total hours:       {preview.get('total_hours')}")
    print(f"  People:            {preview.get('people')}")
    print(f"  Matched schedule:  {preview.get('matched')}")
    print(f"  Variances:         {preview.get('variances')}")
    print(f"  Unscheduled:       {preview.get('unscheduled')}")
    print(f"  No time card:      {preview.get('no_timecard')}")
    print(f"  Unmatched lines:   {preview.get('unmatched_lines')}")
    print(f"  Replaces existing: {preview.get('replaces')} line(s) already on file for this period")

    if preview.get("errors"):
        print(f"\n  {len(preview['errors'])} row error(s):")
        for err in preview["errors"][:20]:
            print(f"    line {err['line']}: {err['reason']}")

    if preview.get("unmatched"):
        print(f"\n  Unmatched employee/job combinations ({preview.get('unmatched_lines')} line(s)):")
        for u in preview["unmatched"][:20]:
            print(f"    employee={u.get('employee')!r} job={u.get('job')!r}")

    if not commit:
        print("\nThis was a PREVIEW -- no data was changed. Re-run with --commit to apply.")
    else:
        applied = result.get("result", {})
        print(f"\nCOMMITTED. {json.dumps(applied)}")


def main() -> None:
    args = parse_args()

    try:
        procore_config = ProcoreConfig.from_env()
    except ProcoreAuthError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    try:
        workforce_config = WorkforceConfig.from_env()
    except WorkforceAuthError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    procore = ProcoreClient(procore_config)
    workforce = WorkforceClient(workforce_config)

    if args.test:
        test_connections(procore, workforce)
        return

    end_date = args.end_date or date.today().isoformat()
    start_date = args.start_date or (date.today() - timedelta(days=7)).isoformat()

    run_sync(procore, workforce, start_date, end_date, args.project_id, args.commit)


if __name__ == "__main__":
    main()
