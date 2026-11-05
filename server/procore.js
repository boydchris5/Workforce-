'use strict';
// Pulls project-level Timesheet / Timecard Entry data straight from the
// Procore REST API (OAuth 2.0 Client Credentials grant), so the "Sync from
// Procore" button doesn't require anyone to export/upload a CSV by hand.
// Requires a Developer Managed Service Account (DMSA) configured for the
// Procore app, with Timesheets tool access -- see procore-sync/README.md.

const DEFAULT_OAUTH_BASE_URL = 'https://login-sandbox.procore.com';
const DEFAULT_API_BASE_URL = 'https://sandbox.procore.com/rest/v1.0';
const DEFAULT_COMPANY_ID = '4293208';
const PAGE_SIZE = 100;

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const configured = () => !!(process.env.PROCORE_CLIENT_ID && process.env.PROCORE_CLIENT_SECRET);

let cachedToken = null; // { token, expiresAt }

async function fetchToken() {
  const url = `${env('PROCORE_OAUTH_BASE_URL', DEFAULT_OAUTH_BASE_URL)}/oauth/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.PROCORE_CLIENT_ID || '',
    client_secret: process.env.PROCORE_CLIENT_SECRET || '',
  });
  const resp = await fetch(url, { method: 'POST', body });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Procore token request to ${url} failed (HTTP ${resp.status}): ${text.slice(0, 500)}`);
  }
  const data = await resp.json();
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 - 60000 };
  return cachedToken.token;
}

async function getToken() {
  if (!cachedToken || Date.now() >= cachedToken.expiresAt) await fetchToken();
  return cachedToken.token;
}

async function apiGet(path, params = {}, retried = false) {
  const token = await getToken();
  const url = new URL(`${env('PROCORE_API_BASE_URL', DEFAULT_API_BASE_URL)}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Procore-Company-Id': env('PROCORE_COMPANY_ID', DEFAULT_COMPANY_ID),
    },
  });
  if (resp.status === 401 && !retried) { cachedToken = null; return apiGet(path, params, true); }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Procore ${path} failed (HTTP ${resp.status}): ${text.slice(0, 500)}`);
  }
  return resp.json();
}

async function getPaginated(path, params = {}) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const batch = await apiGet(path, { ...params, page, per_page: PAGE_SIZE });
    if (!Array.isArray(batch) || !batch.length) break;
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return out;
}

function listProjects() {
  return getPaginated('/projects', { company_id: env('PROCORE_COMPANY_ID', DEFAULT_COMPANY_ID) });
}

function listTimecardEntries(projectId, { start_date, end_date } = {}) {
  return getPaginated(`/projects/${projectId}/timecard_entries`, { start_date, end_date });
}

// Maps a raw Procore timecard entry into the same row shape the app's own
// Procore CSV import expects (see TC_FIELDS in app.js) -- using canonical
// field names directly so no alias lookup is needed.
function entryToRow(project, entry) {
  const party = entry.party || {};
  const costCode = entry.cost_code || {};
  const timeType = entry.timecard_time_type || {};
  return {
    work_date: entry.date,
    employee_no: party.employee_id || null,
    employee_name: party.name || null,
    job_number: project.project_number || null,
    project_name: project.name || null,
    cost_code: costCode.full_code || costCode.name || null,
    cost_code_name: costCode.name || null,
    hours: entry.hours,
    time_type: timeType.time_type || timeType.abbreviated_time_type || null,
    billable: entry.billable,
    description: entry.description,
  };
}

async function pullTimecardRows({ start_date, end_date, project_id }) {
  const allProjects = await listProjects();
  const projects = project_id ? allProjects.filter((p) => p.id === Number(project_id)) : allProjects;
  const rows = [];
  for (const project of projects) {
    const entries = await listTimecardEntries(project.id, { start_date, end_date });
    for (const entry of entries) rows.push(entryToRow(project, entry));
  }
  return { rows, projectCount: projects.length };
}

module.exports = { configured, pullTimecardRows, listProjects };
