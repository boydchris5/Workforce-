'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// A person may split a day across jobs, so the hard database guarantee is one
// row per employee per project per day. Overlapping times and the daily hours
// cap are enforced by the app (see conflictFor in app.js).
const assignmentsDdl = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  planned_hours REAL NOT NULL DEFAULT 8,
  start_time TEXT,
  task TEXT,
  actual_hours REAL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','verified','adjusted','no_show')),
  verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified_at TEXT,
  verify_note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, work_date, project_id)
);`;
const ASSIGNMENTS = assignmentsDdl('assignments');

// Roles: admin = Workforce Manager, super = superintendent, viewer = field staff,
// office = office staff (requests own time off), office_admin = Office Manager.
// can_view_schedule lets an office login (e.g. a project manager) see the field
// schedule, read-only. email + notify_requests drive email notifications.
const usersDdl = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','super','viewer','office','office_admin')),
  can_view_payroll INTEGER NOT NULL DEFAULT 0,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  office_staff_id INTEGER REFERENCES office_staff(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  email TEXT,
  notify_requests INTEGER NOT NULL DEFAULT 1,
  can_view_schedule INTEGER NOT NULL DEFAULT 0
);`;

const SCHEMA = `
${usersDdl('users')}

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  employee_no TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  trade TEXT,
  union_local TEXT,
  classification TEXT,
  hire_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  employee_type TEXT NOT NULL DEFAULT 'union', -- union | general_foreman | superintendent | project_manager | staff (office)
  department TEXT,
  vacation_tier INTEGER, -- 1/2/3 set by hand; NULL = from hire date (Policy Manual 7.2)
  pto_tier INTEGER -- superintendent PTO tier set by hand: 0 not eligible / 1 / 2; NULL = from hire date (7.1(A))
);

-- Yearly time-off allowance in hours, per employee, year and kind.
-- Office staff get PTO and Vacation; superintendents get PTO; union crew none.
CREATE TABLE IF NOT EXISTS leave_allowances (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pto','vacation')),
  hours REAL NOT NULL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, year, kind)
);

-- Balance carried into a year (entered for the first year in the app, or to correct
-- a year; otherwise the app calculates it from the previous year's ending balance).
CREATE TABLE IF NOT EXISTS leave_carry (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pto','vacation')),
  hours REAL NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, year, kind)
);

-- PTO / Vacation hours already used in a year before that time was in the app
-- (entered once when starting to use the app mid-year).
CREATE TABLE IF NOT EXISTS leave_prior_used (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pto','vacation')),
  hours REAL NOT NULL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, year, kind)
);

CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS employee_skills (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  expires_on TEXT,
  PRIMARY KEY (employee_id, skill_id)
);

-- Pay data lives in its own table so it is only ever read by payroll endpoints.
-- Rates are effective-dated: each work day is costed at the rate in effect
-- on that day, so past payroll keeps the rate that was actually paid.
CREATE TABLE IF NOT EXISTS employee_pay_rates (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL,
  base_rate REAL NOT NULL DEFAULT 0,
  fringe_rate REAL NOT NULL DEFAULT 0,
  burden_pct REAL,
  note TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, effective_date)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  job_number TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  customer TEXT,
  address TEXT,
  superintendent_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- legacy (v1-v2); superintendent_employee_id replaces it
  superintendent_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  project_manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','on_hold','complete')),
  start_date TEXT,
  end_date TEXT,
  budget_hours REAL,
  color TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

${ASSIGNMENTS}
CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(work_date);
CREATE INDEX IF NOT EXISTS idx_assign_project ON assignments(project_id, work_date);
CREATE INDEX IF NOT EXISTS idx_assign_emp ON assignments(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_pay_rates ON employee_pay_rates(employee_id, effective_date);

-- Change orders add labor hours to a project's budget.
CREATE TABLE IF NOT EXISTS project_change_orders (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  co_number TEXT,
  description TEXT,
  hours REAL NOT NULL DEFAULT 0,
  co_date TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_co_project ON project_change_orders(project_id);

-- Weekly time card imports (e.g. Procore). Lines are kept as imported; the
-- per person/day/job totals are written to assignments.timecard_hours and
-- assignments.actual_hours, where they can still be adjusted by hand.
CREATE TABLE IF NOT EXISTS timecard_imports (
  id INTEGER PRIMARY KEY,
  filename TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  line_count INTEGER NOT NULL DEFAULT 0,
  total_hours REAL NOT NULL DEFAULT 0,
  imported_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS timecard_entries (
  id INTEGER PRIMARY KEY,
  import_id INTEGER REFERENCES timecard_imports(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  employee_no TEXT,
  employee_name TEXT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  job_number TEXT,
  project_name TEXT,
  cost_code TEXT,
  cost_code_name TEXT,
  description TEXT,
  time_type TEXT,
  billable TEXT,
  hours REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tc_date ON timecard_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_tc_match ON timecard_entries(employee_id, project_id, work_date);

-- Trade requests: a superintendent asks for "a carpenter" (one row per person
-- needed per day) and the workforce manager fills it with a named employee,
-- which creates the schedule entry (assignment_id), or rejects it.
CREATE TABLE IF NOT EXISTS crew_request_slots (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  trade TEXT NOT NULL,
  planned_hours REAL NOT NULL DEFAULT 8,
  task TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','rejected','cancelled')),
  reject_reason TEXT,
  assignment_id INTEGER REFERENCES assignments(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_slots_date ON crew_request_slots(work_date, status);

-- status: approved (blocks scheduling, counts against the balance),
-- pending (an employee's request waiting for the manager) or rejected.
-- batch groups the days of one request.
CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  off_date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hours REAL,
  status TEXT NOT NULL DEFAULT 'approved',
  note TEXT,
  batch TEXT,
  created_at TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  reject_reason TEXT,
  UNIQUE (employee_id, off_date)
);

-- Yearly time-off allowance per office staff member (same idea, office roster).
CREATE TABLE IF NOT EXISTS office_pto_allowances (
  office_staff_id INTEGER NOT NULL REFERENCES office_staff(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  hours REAL NOT NULL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (office_staff_id, year)
);

-- Yearly time-off allowance per field employee (hours granted for that calendar year).
CREATE TABLE IF NOT EXISTS pto_allowances (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  hours REAL NOT NULL,
  note TEXT,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (employee_id, year)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);

-- Office staff (estimators, PM/accounting/admin) are a separate lightweight
-- roster from field employees() -- no trades/union/classification fields apply.
CREATE TABLE IF NOT EXISTS office_staff (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  department TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No PTO balance/accrual tracking yet -- just request -> decide -> log.
-- calendar_event_id is unused until Phase 2 (M365 calendar sync).
CREATE TABLE IF NOT EXISTS office_time_off_requests (
  id INTEGER PRIMARY KEY,
  office_staff_id INTEGER NOT NULL REFERENCES office_staff(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'pto' CHECK (type IN ('pto','sick','personal','other')),
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled')),
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  decision_note TEXT,
  calendar_event_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otor_staff ON office_time_off_requests(office_staff_id, start_date);
CREATE INDEX IF NOT EXISTS idx_otor_status ON office_time_off_requests(status, start_date);
`;

const DEFAULT_SETTINGS = {
  company_name: 'Fager-McGee Commercial Construction',
  ot_threshold_hours: '40',
  ot_multiplier: '1.5',
  default_burden_pct: '25',
  default_hours: '8',
  default_start_time: '07:00',
  max_daily_hours: '12',
  payroll_week_start: '3', // 0 = Sunday … 3 = Wednesday (payroll week Wed–Tue)
  warn_daily_hours: '8',
  // Time-off policy (Policy Manual 7.1 PTO, 7.2 Vacation, 7.1(A) Field Superintendents).
  staff_pto_default_hours: '56', // office staff / PM PTO per year
  staff_pto_cap: '160', // PTO balance never goes above this
  vac_tier1_hours: '40', vac_tier2_hours: '80', vac_tier3_hours: '120', // under 4 yrs / 4+ / 10+
  vac_cap: '160', // vacation over this at year end is paid out
  super_pto_tier1_hours: '40', super_pto_tier2_hours: '80', // after 1 yr / after 5 yrs
  super_pto_cap: '160',
  leave_start_year: String(new Date().getUTCFullYear()), // first year tracked in the app
  staff_vacation_default_hours: '0',
  super_pto_default_hours: '0',
};

const SCHEMA_VERSION = 13;

// Upgrades databases created by earlier versions without losing data.
function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version >= SCHEMA_VERSION) return;
  const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql || '';

  // v2: allow split days (one row per employee per project per day).
  if (!/UNIQUE \(employee_id, work_date, project_id\)/.test(tableSql('assignments'))) {
    db.exec('PRAGMA foreign_keys = OFF;');
    tx(db, () => {
      db.exec(assignmentsDdl('assignments_v2'));
      const cols = 'id, employee_id, project_id, work_date, planned_hours, start_time, task, actual_hours, status, verified_by, verified_at, verify_note, created_by, created_at, updated_at';
      db.exec(`INSERT INTO assignments_v2 (${cols}) SELECT ${cols} FROM assignments;`);
      db.exec('DROP TABLE assignments; ALTER TABLE assignments_v2 RENAME TO assignments;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_assign_date ON assignments(work_date); CREATE INDEX IF NOT EXISTS idx_assign_project ON assignments(project_id, work_date); CREATE INDEX IF NOT EXISTS idx_assign_emp ON assignments(employee_id, work_date);');
    });
    db.exec('PRAGMA foreign_keys = ON;');
  }

  // v2: single pay rate per person -> effective-dated rate history.
  if (tableSql('employee_pay')) {
    tx(db, () => {
      db.exec(`INSERT OR IGNORE INTO employee_pay_rates (employee_id, effective_date, base_rate, fringe_rate, burden_pct, note)
        SELECT employee_id, date(updated_at), base_rate, fringe_rate, burden_pct, 'Carried over from earlier version' FROM employee_pay;`);
      db.exec('DROP TABLE employee_pay;');
    });
  }
  // v3: superintendent and project manager are picked from employees.
  const projectCols = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
  if (!projectCols.includes('superintendent_employee_id')) {
    tx(db, () => {
      db.exec('ALTER TABLE projects ADD COLUMN superintendent_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;');
      db.exec('ALTER TABLE projects ADD COLUMN project_manager_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL;');
      // Carry over superintendents whose login is linked to an employee record.
      db.exec(`UPDATE projects SET superintendent_employee_id =
        (SELECT u.employee_id FROM users u WHERE u.id = projects.superintendent_user_id) WHERE superintendent_user_id IS NOT NULL;`);
    });
  }
  // v4: superintendents request crew; the workforce manager approves or rejects.
  // Everything scheduled before this version counts as approved.
  const asgCols = db.prepare('PRAGMA table_info(assignments)').all().map((c) => c.name);
  if (!asgCols.includes('approval_status')) {
    tx(db, () => {
      db.exec("ALTER TABLE assignments ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved';");
      db.exec('ALTER TABLE assignments ADD COLUMN approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;');
      db.exec('ALTER TABLE assignments ADD COLUMN approved_at TEXT;');
      db.exec('ALTER TABLE assignments ADD COLUMN reject_reason TEXT;');
      db.exec('CREATE INDEX IF NOT EXISTS idx_assign_approval ON assignments(approval_status, work_date);');
    });
  }
  // v5: hours already used on a job before it came into this app.
  if (!db.prepare('PRAGMA table_info(projects)').all().some((c) => c.name === 'starting_hours')) {
    db.exec('ALTER TABLE projects ADD COLUMN starting_hours REAL NOT NULL DEFAULT 0;');
  }
  // v6: time card import. source = 'schedule' or 'timecard' (worked but not
  // scheduled); timecard_hours = hours from the imported time card.
  const asg6 = db.prepare('PRAGMA table_info(assignments)').all().map((c) => c.name);
  if (!asg6.includes('source')) {
    db.exec("ALTER TABLE assignments ADD COLUMN source TEXT NOT NULL DEFAULT 'schedule';");
    db.exec('ALTER TABLE assignments ADD COLUMN timecard_hours REAL;');
  }
  // v8: office staff logins (role 'office'/'office_admin') and their link to
  // an office_staff roster row. SQLite can't ALTER a CHECK constraint, so
  // rebuild users the same way the v2 assignments migration did.
  if (!/'office'/.test(tableSql('users'))) {
    db.exec('PRAGMA foreign_keys = OFF;');
    tx(db, () => {
      db.exec(`CREATE TABLE users_v2 (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','super','viewer','office','office_admin')),
        can_view_payroll INTEGER NOT NULL DEFAULT 0,
        employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        office_staff_id INTEGER REFERENCES office_staff(id) ON DELETE SET NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );`);
      const cols = 'id, username, name, password_hash, role, can_view_payroll, employee_id, active, created_at';
      db.exec(`INSERT INTO users_v2 (${cols}) SELECT ${cols} FROM users;`);
      db.exec('DROP TABLE users; ALTER TABLE users_v2 RENAME TO users;');
    });
    db.exec('PRAGMA foreign_keys = ON;');
  }
  // v9: email notifications + office logins that can view the field schedule.
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const addUser = { email: 'TEXT', notify_requests: 'INTEGER NOT NULL DEFAULT 1', can_view_schedule: 'INTEGER NOT NULL DEFAULT 0' };
  for (const [c, type] of Object.entries(addUser)) if (!userCols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${type};`);
  // v9: field time-off requests (pending/approved/rejected), hours per day.
  const offCols = db.prepare('PRAGMA table_info(time_off)').all().map((c) => c.name);
  const addOff = { hours: 'REAL', status: "TEXT NOT NULL DEFAULT 'approved'", note: 'TEXT', batch: 'TEXT', created_at: 'TEXT',
    decided_by: 'INTEGER REFERENCES users(id) ON DELETE SET NULL', decided_at: 'TEXT', reject_reason: 'TEXT' };
  for (const [c, type] of Object.entries(addOff)) if (!offCols.includes(c)) db.exec(`ALTER TABLE time_off ADD COLUMN ${c} ${type};`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_timeoff_status ON time_off(status, off_date);');
  // v10: one employee list for union crew, superintendents and office staff, and one
  // time-off record for everyone (office requests move into time_off).
  const empCols = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
  if (!empCols.includes('employee_type')) {
    tx(db, () => {
      db.exec("ALTER TABLE employees ADD COLUMN employee_type TEXT NOT NULL DEFAULT 'union';");
      db.exec('ALTER TABLE employees ADD COLUMN department TEXT;');
      if (empCols.includes('classification')) {
        db.exec("UPDATE employees SET employee_type = 'superintendent' WHERE classification LIKE '%superintendent%';");
        db.exec("UPDATE employees SET employee_type = 'staff' WHERE classification LIKE '%project manager%';");
      }
      if (tableSql('office_staff')) migrateOfficeStaff(db);
    });
  }
  // v11: Type (not Classification) decides who is a project manager / general foreman.
  // Classification becomes union-only, so office titles and "Superintendent" move out of it.
  if (version < 11 && db.prepare('PRAGMA table_info(employees)').all().some((c) => c.name === 'classification')) {
    tx(db, () => {
      db.exec("UPDATE employees SET employee_type = 'project_manager' WHERE classification LIKE '%project manager%' AND employee_type IN ('staff','union');");
      db.exec("UPDATE employees SET employee_type = 'general_foreman' WHERE classification LIKE '%general foreman%' AND employee_type = 'union';");
      db.exec("UPDATE employees SET classification = NULL WHERE employee_type IN ('staff','project_manager');");
      db.exec("UPDATE employees SET classification = NULL WHERE employee_type = 'superintendent' AND classification LIKE '%superintendent%';");
      db.exec("UPDATE employees SET classification = NULL WHERE employee_type = 'general_foreman' AND classification LIKE '%general foreman%';");
    });
  }
  // v12: vacation tier on the employee; PTO policy default (56 h) replaces the old 0 default.
  if (!db.prepare('PRAGMA table_info(employees)').all().some((c) => c.name === 'vacation_tier')) {
    db.exec('ALTER TABLE employees ADD COLUMN vacation_tier INTEGER;');
  }
  // v13: superintendent PTO tier set by hand.
  if (!db.prepare('PRAGMA table_info(employees)').all().some((c) => c.name === 'pto_tier')) {
    db.exec('ALTER TABLE employees ADD COLUMN pto_tier INTEGER;');
  }
  if (version < 12 && version > 0) {
    db.exec("UPDATE settings SET value = '56' WHERE key = 'staff_pto_default_hours' AND value IN ('0', '');");
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

// Moves the separate office roster, its logins, requests and allowances onto employees.
function migrateOfficeStaff(db) {
  const def = Number(db.prepare("SELECT value FROM settings WHERE key = 'default_hours'").get()?.value) || 8;
  const byName = db.prepare('SELECT id FROM employees WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)');
  const map = new Map();
  const roster = db.prepare('SELECT * FROM office_staff').all();
  const ins = roster.length ? db.prepare(`INSERT INTO employees (first_name, last_name, email, department, active, employee_type) VALUES (?, ?, ?, ?, ?, 'staff')`) : null;
  for (const o of roster) {
    const hit = byName.get(o.first_name, o.last_name);
    if (hit) {
      db.prepare("UPDATE employees SET employee_type = 'staff', department = COALESCE(department, ?), email = COALESCE(email, ?) WHERE id = ?").run(o.department, o.email, hit.id);
      map.set(o.id, hit.id);
    } else map.set(o.id, Number(ins.run(o.first_name, o.last_name, o.email, o.department, o.active).lastInsertRowid));
  }
  for (const u of db.prepare('SELECT id, office_staff_id FROM users WHERE office_staff_id IS NOT NULL AND employee_id IS NULL').all()) {
    if (map.has(u.office_staff_id)) db.prepare('UPDATE users SET employee_id = ? WHERE id = ?').run(map.get(u.office_staff_id), u.id);
  }
  const typeReason = { pto: 'PTO', personal: 'PTO', vacation: 'Vacation', sick: 'Other', other: 'Other' };
  const statusMap = { pending: 'pending', approved: 'approved', denied: 'rejected' };
  const addOff = db.prepare(`INSERT OR IGNORE INTO time_off (employee_id, off_date, reason, hours, status, note, batch, created_by, created_at, decided_by, decided_at, reject_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'office_time_off_requests'").get()) {
    for (const r of db.prepare('SELECT * FROM office_time_off_requests').all()) {
      const eid = map.get(r.office_staff_id); const st = statusMap[r.status];
      if (!eid || !st) continue; // cancelled requests aren't carried over
      for (let d = r.start_date; d <= r.end_date; d = new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10)) {
        const w = new Date(d + 'T00:00:00Z').getUTCDay();
        if (w === 0 || w === 6) continue;
        addOff.run(eid, d, typeReason[r.type] || 'Other', def, st, r.note, `office-${r.id}`, r.requested_by, r.created_at, r.decided_by, r.decided_at, st === 'rejected' ? r.decision_note : null);
      }
    }
  }
  const addAllow = db.prepare('INSERT OR IGNORE INTO leave_allowances (employee_id, year, kind, hours, note, updated_by) VALUES (?, ?, ?, ?, ?, ?)');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'office_pto_allowances'").get()) {
    for (const a of db.prepare('SELECT * FROM office_pto_allowances').all()) if (map.has(a.office_staff_id)) addAllow.run(map.get(a.office_staff_id), a.year, 'pto', a.hours, a.note, a.updated_by);
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'pto_allowances'").get()) {
    for (const a of db.prepare('SELECT * FROM pto_allowances').all()) addAllow.run(a.employee_id, a.year, 'pto', a.hours, a.note, a.updated_by);
  }
  const old = db.prepare("SELECT key, value FROM settings WHERE key IN ('office_pto_default_hours','pto_default_hours')").all();
  for (const o of old) db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(o.key === 'office_pto_default_hours' ? 'staff_pto_default_hours' : 'super_pto_default_hours', o.value);
}

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

module.exports = { open, tx, getSettings };
