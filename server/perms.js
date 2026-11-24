'use strict';
// Per-user permissions, Procore style: each tool is None / Read only / Standard / Admin.
// A login's grid is stored in users.permissions (JSON). Logins without a saved grid get one
// worked out from their role and flags, exactly matching what they could do before grids
// existed, so nobody gains or loses access until someone edits their permissions.

const LEVELS = ['None', 'Read only', 'Standard', 'Admin'];

// What each level means, per tool (shown in the permissions screen). A dash = not used.
const TOOLS = [
  { key: 'schedule', label: 'Schedule', group: 'Field Operations', levels: ['—', 'View the schedule', 'Request crew on own jobs', 'Schedule anyone, approve and fill requests'] },
  { key: 'verify', label: 'Verify Hours', group: 'Field Operations', levels: ['—', 'View', 'Verify / adjust hours', 'Plus import and sync time cards'] },
  { key: 'records', label: 'Records', group: 'Field Operations', levels: ['—', 'View', null, null] },
  { key: 'projects', label: 'Projects', group: 'Resources', levels: ['—', 'View', 'Add and edit projects', 'Plus Procore sync and import'] },
  { key: 'employees', label: 'Employees', group: 'Resources', levels: ['—', 'View', 'Add and edit', 'Plus import and delete'] },
  { key: 'timeoff', label: 'Time Off', group: 'Resources', levels: ['—', 'Request own, see calendar', 'Plus enter time off for field crew', 'Approve requests'] },
  { key: 'est_schedule', label: 'Bid Board Schedule', group: 'Preconstruction', levels: ['—', 'View', 'Add and edit bids', 'Plus import'] },
  { key: 'est_gng', label: 'Go / No-Go', group: 'Preconstruction', levels: ['—', 'View', 'Rate and decide', 'Plus scorecard weights'] },
  { key: 'est_history', label: 'Bid Results & History', group: 'Preconstruction', levels: ['—', 'View', 'Log results', null] },
  { key: 'payroll', label: 'Payroll (private)', group: 'Company', levels: ['—', 'View forecast and rates', null, 'Edit pay rates'] },
  { key: 'admin', label: 'Admin (users, settings)', group: 'Company', levels: ['—', null, null, 'Full'] },
];
const KEYS = TOOLS.map((t) => t.key);
const allowed = (key) => TOOLS.find((t) => t.key === key).levels.map((d, i) => (i === 0 || d ? i : null)).filter((x) => x !== null);

const z = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
const TEMPLATES = {
  field: { label: 'Field', perm: { ...z(), schedule: 1, records: 1, projects: 1, employees: 1, timeoff: 1 } },
  superintendent: { label: 'Superintendent', perm: { ...z(), schedule: 2, verify: 2, records: 1, projects: 2, employees: 2, timeoff: 2 } },
  project_manager: { label: 'Project Manager', perm: { ...z(), schedule: 2, records: 1, projects: 3, employees: 1, timeoff: 1, est_schedule: 1, est_gng: 1, est_history: 1 } },
  estimator: { label: 'Estimator', perm: { ...z(), schedule: 1, records: 1, projects: 1, employees: 1, timeoff: 1, est_schedule: 2, est_gng: 2, est_history: 2 } },
  office_staff: { label: 'Office Staff', perm: { ...z(), timeoff: 1 } },
  office_manager: { label: 'Office Manager', perm: { ...z(), schedule: 1, verify: 3, records: 1, projects: 1, employees: 2, timeoff: 3, est_schedule: 2, est_gng: 2, est_history: 2 } },
  accounting: { label: 'Accounting', perm: { ...z(), schedule: 1, verify: 3, records: 1, projects: 1, timeoff: 1, payroll: 3 } },
  workforce_manager: { label: 'Workforce Manager', perm: Object.fromEntries(KEYS.map((k) => [k, Math.max(...allowed(k))])) },
};

// The template that fits a login, from its role and the linked employee's Type / Department.
function suggestTemplate(u) {
  if (!u) return 'field';
  if (u.role === 'admin') return 'workforce_manager';
  if (u.role === 'office_admin') return 'office_manager';
  const type = u.employee_type; const dept = String(u.department || '').toLowerCase();
  if (type === 'superintendent' || u.role === 'super') return 'superintendent';
  if (type === 'project_manager') return 'project_manager';
  if (/estimat|pre-?con/.test(dept)) return 'estimator';
  if (/account|payroll/.test(dept) || u.can_view_payroll) return 'accounting';
  if (u.role === 'office') return 'office_staff';
  return 'field';
}

// Grid matching the access each role had before permission grids.
function legacy(u) {
  const p = z();
  const isPm = u.role !== 'admin' && u.employee_type === 'project_manager';
  const payroll = !!u.can_view_payroll;
  if (u.role === 'admin') return { ...TEMPLATES.workforce_manager.perm };
  if (u.role === 'super') Object.assign(p, { schedule: 2, verify: 2, records: 1, projects: 2, employees: 2, timeoff: 2 });
  else if (u.role === 'viewer') Object.assign(p, { schedule: 1, records: 1, projects: 1, employees: 1, timeoff: 1 });
  else if (u.role === 'office_admin') {
    const sees = u.can_view_schedule ? 1 : 0;
    Object.assign(p, { schedule: sees, records: sees, projects: sees, employees: 2, verify: 3, timeoff: 3, est_schedule: 2, est_gng: 2, est_history: 2 });
  } else if (u.role === 'office') {
    if (isPm) Object.assign(p, { schedule: 2, records: 1, projects: 3, employees: 1 });
    else if (u.can_view_schedule) Object.assign(p, { schedule: 1, records: 1, projects: 1, employees: 1 });
    Object.assign(p, { timeoff: 1, est_schedule: 2, est_gng: 2, est_history: 2 });
  }
  if (payroll) { p.payroll = 3; p.verify = 3; }
  return p;
}

// Clean a submitted grid: known tools only, levels each tool supports.
function normalize(obj) {
  const out = z();
  for (const k of KEYS) {
    const v = Math.round(Number(obj && obj[k]) || 0);
    const ok = allowed(k);
    out[k] = ok.includes(v) ? v : ok.filter((x) => x <= v).pop() || 0;
  }
  return out;
}

function permsFor(u) {
  if (u && u.permissions) {
    try { return normalize(JSON.parse(u.permissions)); } catch { /* fall through */ }
  }
  return legacy(u || {});
}

module.exports = { LEVELS, TOOLS, KEYS, TEMPLATES, suggestTemplate, legacy, normalize, permsFor, allowed };
