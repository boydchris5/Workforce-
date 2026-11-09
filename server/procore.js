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
const MAX_RATE_LIMIT_RETRIES = 6;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const PROJECT_PACING_MS = 150; // spread out per-project requests so a company with many projects doesn't burst the rate limit

const env = (name, fallback) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function apiGet(path, params = {}, { authRetried = false, rateLimitAttempt = 0 } = {}) {
  const token = await getToken();
  const url = new URL(`${env('PROCORE_API_BASE_URL', DEFAULT_API_BASE_URL)}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Procore-Company-Id': env('PROCORE_COMPANY_ID', DEFAULT_COMPANY_ID),
    },
  });
  if (resp.status === 401 && !authRetried) { cachedToken = null; return apiGet(path, params, { authRetried: true, rateLimitAttempt }); }
  // Companies with many projects can trip Procore's rate limit even with the pacing
  // delay below; back off (honoring Retry-After when given) and retry rather than
  // failing the whole sync over a transient 429.
  if (resp.status === 429 && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
    const retryAfterSec = Number(resp.headers.get('retry-after'));
    const delayMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? retryAfterSec * 1000
      : Math.min(BASE_BACKOFF_MS * 2 ** rateLimitAttempt, MAX_BACKOFF_MS);
    await sleep(delayMs);
    return apiGet(path, params, { authRetried, rateLimitAttempt: rateLimitAttempt + 1 });
  }
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
  // Companies can accumulate many completed/archived projects; skipping inactive
  // ones cuts the number of Procore API calls a lot and avoids tripping its rate
  // limit on every sync. An explicit project_id always wins, active or not.
  const projects = project_id
    ? allProjects.filter((p) => p.id === Number(project_id))
    : allProjects.filter((p) => p.active !== false);
  const rows = [];
  for (const [i, project] of projects.entries()) {
    if (i > 0) await sleep(PROJECT_PACING_MS);
    const entries = await listTimecardEntries(project.id, { start_date, end_date });
    for (const entry of entries) rows.push(entryToRow(project, entry));
  }
  return { rows, projectCount: projects.length };
}

// ---- job information --------------------------------------------------------
// People assigned to a project in Procore's project directory, by role
// (e.g. "Project Manager", "Superintendent").
function listProjectRoles(projectId) {
  return getPaginated('/project_roles', { project_id: projectId });
}
const roleName = (r) => String(r.role?.name || r.role || r.role_name || '').trim();
const personName = (r) => String(r.user?.name || r.contact?.name || r.name_of_person || (r.role && typeof r.role === 'string' ? r.name : '') || r.login || '').trim();
const pickRole = (roles, re) => roles.filter((r) => r.is_active !== false && re.test(roleName(r))).map(personName).find(Boolean) || null;

// Every Procore project, normalized. Project roles (PM / superintendent) are read
// only for projects the app will actually use (active, past pre-construction), to
// keep API calls down. If roles can't be read (e.g. a missing permission), the
// sync still works and leaves PM / superintendent as they are.
async function pullProjects({ wantRoles = (p) => p.active !== false } = {}) {
  const raw = await listProjects();
  const out = []; const warnings = []; let roleCalls = 0;
  for (const p of raw) {
    const rec = {
      procore_id: p.id,
      job_number: p.project_number ? String(p.project_number).trim() : null,
      name: p.name || p.display_name || null,
      address: p.address || null, city: p.city || null, state: p.state_code || p.state || null, zip: p.zip || null,
      active: p.active !== false,
      stage: p.project_stage?.name || p.stage?.name || (typeof p.stage === 'string' ? p.stage : null),
      start_date: p.start_date || null,
      end_date: p.completion_date || p.projected_finish_date || null,
      project_manager: null, superintendent: null, roles_read: false,
    };
    if (wantRoles(rec) && !warnings.includes('roles')) {
      try {
        if (roleCalls++ > 0) await sleep(PROJECT_PACING_MS);
        const roles = await listProjectRoles(p.id);
        rec.project_manager = pickRole(roles, /project\s*manager/i);
        rec.superintendent = pickRole(roles, /superintendent|general foreman/i);
        rec.roles_read = true;
      } catch (e) {
        warnings.push('roles');
        warnings.roleError = e.message;
      }
    }
    out.push(rec);
  }
  return { projects: out, rolesUnavailable: warnings.includes('roles') ? warnings.roleError : null };
}

module.exports = { configured, pullTimecardRows, listProjects, pullProjects };
