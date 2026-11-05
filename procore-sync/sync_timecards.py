"""Pull project-level Timesheet / Timecard Entry data out of Procore and
write it to an Excel workbook.

Usage:
    python sync_timecards.py --test
        Verify credentials and connectivity only.

    python sync_timecards.py --start-date 2026-10-01 --end-date 2026-10-31
        Pull timecard entries for all projects under the configured company
        and write them to timecards_<timestamp>.xlsx.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import date, datetime, timedelta

from openpyxl import Workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter

from procore_client import PROJECT_PACING_SECONDS, ProcoreAPIError, ProcoreAuthError, ProcoreClient, ProcoreConfig

TIMECARD_COLUMNS = [
    "project_id",
    "project_name",
    "timecard_entry_id",
    "timesheet_id",
    "person_id",
    "employee_id",
    "person_name",
    "date",
    "cost_code",
    "time_type",
    "time_in",
    "time_out",
    "hours",
    "lunch_minutes",
    "approval_status",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--test", action="store_true", help="Only test the Procore connection, then exit.")
    parser.add_argument("--start-date", type=str, default=None, help="YYYY-MM-DD, default = 30 days ago.")
    parser.add_argument("--end-date", type=str, default=None, help="YYYY-MM-DD, default = today.")
    parser.add_argument("--output", type=str, default=None, help="Output .xlsx path.")
    parser.add_argument(
        "--project-id",
        type=int,
        default=None,
        help="Limit the sync to a single project ID instead of all projects in the company.",
    )
    return parser.parse_args()


def test_connection(client: ProcoreClient) -> None:
    print(f"Testing connection to {client.config.api_base_url} ...")
    try:
        company = client.test_connection()
    except ProcoreAuthError as exc:
        print(f"AUTH FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
    except ProcoreAPIError as exc:
        print(f"API CALL FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"OK -- authenticated. Company: {company.get('name')!r} (id={company.get('id')})")

    try:
        projects = client.list_projects()
    except ProcoreAPIError as exc:
        print(f"Could not list projects: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"OK -- {len(projects)} project(s) visible to this app under company {client.config.company_id}:")
    for proj in projects[:20]:
        print(f"  - [{proj.get('id')}] {proj.get('name')}")
    if len(projects) > 20:
        print(f"  ... and {len(projects) - 20} more")


def normalize_entry(project: dict, entry: dict) -> dict:
    party = entry.get("party") or {}
    cost_code = entry.get("cost_code") or {}
    time_type = entry.get("timecard_time_type") or {}
    return {
        "project_id": project.get("id"),
        "project_name": project.get("name"),
        "timecard_entry_id": entry.get("id"),
        "timesheet_id": entry.get("timesheet_id"),
        "person_id": party.get("user_id") or party.get("id"),
        "employee_id": party.get("employee_id"),
        "person_name": party.get("name"),
        "date": entry.get("date"),
        "cost_code": cost_code.get("full_code") or cost_code.get("name"),
        "time_type": time_type.get("time_type") or time_type.get("abbreviated_time_type"),
        "time_in": entry.get("time_in"),
        "time_out": entry.get("time_out"),
        "hours": entry.get("hours"),
        "lunch_minutes": entry.get("lunch_time"),
        "approval_status": entry.get("approval_status"),
    }


def run_sync(client: ProcoreClient, start_date: str, end_date: str, project_id: int | None, output_path: str) -> None:
    if project_id is not None:
        projects = [p for p in client.list_projects() if p.get("id") == project_id]
        if not projects:
            print(f"Project {project_id} not found (or not visible to this app) in company {client.config.company_id}.", file=sys.stderr)
            sys.exit(1)
    else:
        # Skip inactive/archived projects by default -- cuts API calls a lot on
        # companies with a long project history, and avoids tripping Procore's
        # rate limit for no benefit (archived jobs don't get new time cards).
        projects = [p for p in client.list_projects() if p.get("active") is not False]
    print(f"Found {len(projects)} project(s) to sync.")

    all_rows: list[dict] = []
    for i, project in enumerate(projects):
        if i > 0:
            time.sleep(PROJECT_PACING_SECONDS)
        pid = project["id"]
        print(f"  Project [{pid}] {project.get('name')}: fetching timecard entries ({start_date} to {end_date}) ...")
        try:
            entries = client.list_timecard_entries(
                pid,
                params={"start_date": start_date, "end_date": end_date},
            )
        except ProcoreAPIError as exc:
            print(f"    WARNING: skipping project {pid} -- {exc}", file=sys.stderr)
            continue
        print(f"    {len(entries)} entries")
        for entry in entries:
            all_rows.append(normalize_entry(project, entry))

    write_workbook(all_rows, output_path)
    print(f"Wrote {len(all_rows)} timecard entries to {output_path}")


def write_workbook(rows: list[dict], output_path: str) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Timecard Entries"
    ws.append(TIMECARD_COLUMNS)
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append([row.get(col) for col in TIMECARD_COLUMNS])
    for idx, col in enumerate(TIMECARD_COLUMNS, start=1):
        width = max(len(col), 12)
        ws.column_dimensions[get_column_letter(idx)].width = width + 2
    ws.freeze_panes = "A2"
    wb.save(output_path)


def main() -> None:
    args = parse_args()

    try:
        config = ProcoreConfig.from_env()
    except ProcoreAuthError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)

    client = ProcoreClient(config)

    if args.test:
        test_connection(client)
        return

    end_date = args.end_date or date.today().isoformat()
    start_date = args.start_date or (date.today() - timedelta(days=30)).isoformat()
    output_path = args.output or f"timecards_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"

    run_sync(client, start_date, end_date, args.project_id, output_path)


if __name__ == "__main__":
    main()
