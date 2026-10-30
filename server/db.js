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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','super','viewer')),
  can_view_payroll INTEGER NOT NULL DEFAULT 0,
  employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  off_date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (employee_id, off_date)
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
`;

const DEFAULT_SETTINGS = {
  company_name: 'Fager-McGee Commercial Construction',
  ot_threshold_hours: '40',
  ot_multiplier: '1.5',
  default_burden_pct: '25',
  default_hours: '8',
  default_start_time: '07:00',
  max_daily_hours: '12',
  warn_daily_hours: '8',
};

const SCHEMA_VERSION = 3;

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
      db.exec('INSERT INTO assignments_v2 SELECT id, employee_id, project_id, work_date, planned_hours, start_time, task, actual_hours, status, verified_by, verified_at, verify_note, created_by, created_at, updated_at FROM assignments;');
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
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
