"""Minimal Procore REST API client using the OAuth 2.0 Client Credentials grant.

Client Credentials requires a Developer Managed Service Account (DMSA) to be
configured for your app in the Procore Developer Portal, with company/project
tool permissions granted for the Timesheets tool on the target company. See
README.md for setup steps -- this script cannot create that account for you.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any, Iterator

import requests

DEFAULT_OAUTH_BASE_URL = "https://login-sandbox.procore.com"
DEFAULT_API_BASE_URL = "https://sandbox.procore.com/rest/v1.0"
PAGE_SIZE = 100
MAX_RATE_LIMIT_RETRIES = 6
BASE_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0
PROJECT_PACING_SECONDS = 0.15  # spread out per-project requests on companies with many projects


class ProcoreAuthError(RuntimeError):
    pass


class ProcoreAPIError(RuntimeError):
    def __init__(self, message: str, status_code: int, body: str):
        super().__init__(message)
        self.status_code = status_code
        self.body = body


@dataclass
class ProcoreConfig:
    client_id: str
    client_secret: str
    company_id: int
    oauth_base_url: str = DEFAULT_OAUTH_BASE_URL
    api_base_url: str = DEFAULT_API_BASE_URL

    @classmethod
    def from_env(cls) -> "ProcoreConfig":
        client_id = os.environ.get("PROCORE_CLIENT_ID")
        client_secret = os.environ.get("PROCORE_CLIENT_SECRET")
        company_id = os.environ.get("PROCORE_COMPANY_ID", "4293208")
        if not client_id or not client_secret:
            raise ProcoreAuthError(
                "PROCORE_CLIENT_ID and/or PROCORE_CLIENT_SECRET are not set.\n"
                "Set them as persistent environment variables, e.g.:\n"
                '  setx PROCORE_CLIENT_ID "your-client-id"\n'
                '  setx PROCORE_CLIENT_SECRET "your-client-secret"\n'
                "Then open a new terminal so the new values are picked up."
            )
        return cls(
            client_id=client_id,
            client_secret=client_secret,
            company_id=int(company_id),
            oauth_base_url=os.environ.get("PROCORE_OAUTH_BASE_URL", DEFAULT_OAUTH_BASE_URL),
            api_base_url=os.environ.get("PROCORE_API_BASE_URL", DEFAULT_API_BASE_URL),
        )


class ProcoreClient:
    def __init__(self, config: ProcoreConfig):
        self.config = config
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0
        self._session = requests.Session()
        # Required by Procore for /me and /companies calls when using a DMSA;
        # harmless to send on every request.
        self._session.headers["Procore-Company-Id"] = str(config.company_id)

    # -- auth -----------------------------------------------------------
    def _fetch_token(self) -> None:
        url = f"{self.config.oauth_base_url}/oauth/token"
        resp = self._session.post(
            url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            raise ProcoreAuthError(
                f"Token request to {url} failed with HTTP {resp.status_code}: {resp.text[:500]}\n"
                "If this is a 404/connection error, the sandbox OAuth host may differ -- "
                "override it with the PROCORE_OAUTH_BASE_URL env var.\n"
                "If this is a 401/invalid_client, double-check PROCORE_CLIENT_ID / "
                "PROCORE_CLIENT_SECRET and that a Developer Managed Service Account "
                "(DMSA) has been configured for this app (see README.md)."
            )
        payload = resp.json()
        self._access_token = payload["access_token"]
        expires_in = payload.get("expires_in", 3600)
        self._token_expires_at = time.time() + expires_in - 60  # refresh a bit early

    def _ensure_token(self) -> str:
        if not self._access_token or time.time() >= self._token_expires_at:
            self._fetch_token()
        assert self._access_token is not None
        return self._access_token

    # -- http -------------------------------------------------------------
    def _request(self, method: str, path: str, **kwargs: Any) -> requests.Response:
        token = self._ensure_token()
        url = path if path.startswith("http") else f"{self.config.api_base_url}{path}"
        headers = kwargs.pop("headers", {}) or {}
        headers["Authorization"] = f"Bearer {token}"
        resp = self._session.request(method, url, headers=headers, timeout=30, **kwargs)
        if resp.status_code == 401:
            # token may have been revoked/expired early -- retry once with a fresh token
            self._access_token = None
            token = self._ensure_token()
            headers["Authorization"] = f"Bearer {token}"
            resp = self._session.request(method, url, headers=headers, timeout=30, **kwargs)
        # Companies with many projects can trip Procore's rate limit; back off
        # (honoring Retry-After when given) and retry instead of failing the sync.
        attempt = 0
        while resp.status_code == 429 and attempt < MAX_RATE_LIMIT_RETRIES:
            retry_after = resp.headers.get("Retry-After")
            try:
                delay = float(retry_after) if retry_after else min(BASE_BACKOFF_SECONDS * (2**attempt), MAX_BACKOFF_SECONDS)
            except ValueError:
                delay = min(BASE_BACKOFF_SECONDS * (2**attempt), MAX_BACKOFF_SECONDS)
            time.sleep(delay)
            resp = self._session.request(method, url, headers=headers, timeout=30, **kwargs)
            attempt += 1
        if resp.status_code >= 400:
            raise ProcoreAPIError(
                f"{method} {url} failed with HTTP {resp.status_code}: {resp.text[:1000]}",
                status_code=resp.status_code,
                body=resp.text,
            )
        return resp

    def get(self, path: str, params: dict | None = None) -> Any:
        return self._request("GET", path, params=params).json()

    def get_paginated(self, path: str, params: dict | None = None) -> Iterator[dict]:
        """Yield items from a paginated list endpoint (Procore uses page/per_page)."""
        params = dict(params or {})
        params.setdefault("per_page", PAGE_SIZE)
        page = 1
        while True:
            params["page"] = page
            batch = self.get(path, params=params)
            if not batch:
                return
            for item in batch:
                yield item
            if len(batch) < params["per_page"]:
                return
            page += 1

    # -- connection test ----------------------------------------------------
    def test_connection(self) -> dict:
        """Verify auth works and the configured company is reachable."""
        self._ensure_token()
        company = self.get(f"/companies/{self.config.company_id}")
        return company

    # -- domain calls -----------------------------------------------------
    def list_projects(self) -> list[dict]:
        return list(self.get_paginated("/projects", params={"company_id": self.config.company_id}))

    def list_timesheets(self, project_id: int, params: dict | None = None) -> list[dict]:
        return list(self.get_paginated(f"/projects/{project_id}/timesheets", params=params))

    def list_timecard_entries(self, project_id: int, params: dict | None = None) -> list[dict]:
        return list(self.get_paginated(f"/projects/{project_id}/timecard_entries", params=params))
