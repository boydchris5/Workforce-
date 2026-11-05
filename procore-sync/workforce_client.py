"""Minimal client for the Fager-McGee Workforce Scheduler app's
(`boydchris5/Workforce-`) internal REST API, used to push Procore timecard
data into its `/api/timecards/import` endpoint.

Auth is session-cookie based (POST /api/login), not API-key based, so this
client logs in once per run and reuses the session cookie for subsequent
calls.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

import requests


class WorkforceAuthError(RuntimeError):
    pass


class WorkforceAPIError(RuntimeError):
    def __init__(self, message: str, status_code: int, body: str):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


@dataclass
class WorkforceConfig:
    base_url: str
    username: str
    password: str

    @classmethod
    def from_env(cls) -> "WorkforceConfig":
        base_url = os.environ.get("WORKFORCE_APP_URL")
        username = os.environ.get("WORKFORCE_USERNAME")
        password = os.environ.get("WORKFORCE_PASSWORD")
        missing = [
            name
            for name, val in [
                ("WORKFORCE_APP_URL", base_url),
                ("WORKFORCE_USERNAME", username),
                ("WORKFORCE_PASSWORD", password),
            ]
            if not val
        ]
        if missing:
            raise WorkforceAuthError(
                f"Missing env var(s): {', '.join(missing)}.\n"
                "Set them, e.g.:\n"
                '  setx WORKFORCE_APP_URL "https://workforce-scheduler-9ar8.onrender.com"\n'
                '  setx WORKFORCE_USERNAME "procore-sync"\n'
                '  setx WORKFORCE_PASSWORD "..."\n'
                "Then open a new terminal so the new values are picked up."
            )
        return cls(base_url=base_url.rstrip("/"), username=username, password=password)


class WorkforceClient:
    def __init__(self, config: WorkforceConfig):
        self.config = config
        self._session = requests.Session()
        self._logged_in = False

    def _login(self) -> None:
        url = f"{self.config.base_url}/api/login"
        resp = self._session.post(
            url,
            json={"username": self.config.username, "password": self.config.password},
            timeout=30,
        )
        if resp.status_code != 200:
            raise WorkforceAuthError(
                f"Login to {url} failed with HTTP {resp.status_code}: {resp.text[:500]}\n"
                "Check WORKFORCE_USERNAME / WORKFORCE_PASSWORD, and that the account is "
                "active with the 'admin' role (the import endpoint is admin-only)."
            )
        self._logged_in = True

    def _ensure_login(self) -> None:
        if not self._logged_in:
            self._login()

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        self._ensure_login()
        url = f"{self.config.base_url}{path}"
        resp = self._session.request(method, url, timeout=60, **kwargs)
        if resp.status_code == 401:
            # session may have expired -- retry once after a fresh login
            self._logged_in = False
            self._ensure_login()
            resp = self._session.request(method, url, timeout=60, **kwargs)
        if resp.status_code >= 400:
            raise WorkforceAPIError(
                f"{method} {url} failed with HTTP {resp.status_code}: {resp.text[:1000]}",
                status_code=resp.status_code,
                body=resp.text,
            )
        return resp

    def health(self) -> dict:
        return self._session.get(f"{self.config.base_url}/api/health", timeout=15).json()

    def import_timecards(self, rows: list[dict], filename: str, commit: bool) -> dict:
        return self._request(
            "POST",
            "/api/timecards/import",
            json={"rows": rows, "filename": filename, "commit": commit},
        ).json()
