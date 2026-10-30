'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');

let server; let base;
const conn = db.open(':memory:');

before(async () => {
  conn.prepare(`INSERT INTO users (username, name, password_hash, role, can_view_payroll) VALUES ('boss', 'Boss', ?, 'admin', 1)`).run(auth.hashPassword('password1'));
  conn.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES ('super', 'Super', ?, 'super')`).run(auth.hashPassword('password1'));
  conn.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES ('field', 'Field', ?, 'viewer')`).run(auth.hashPassword('password1'));
  server = createApp(conn).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(username) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
}

const MON = '2026-11-02';
let boss; let sup; let field; let p1; let p2; let e1; let e2;

test('rejects unauthenticated access and bad passwords', async () => {
  assert.equal((await fetch(`${base}/schedule`)).status, 401);
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'nope' }) });
  assert.equal(r.status, 401);
});

test('setup projects and employees', async () => {
  boss = await login('boss'); sup = await login('super'); field = await login('field');
  p1 = (await boss('POST', '/projects', { job_number: '25-001', name: 'School', budget_hours: 100 })).body.id;
  p2 = (await sup('POST', '/projects', { job_number: '25-002', name: 'Bridge' })).body.id;
  assert.ok(p1 && p2);
  assert.equal((await boss('POST', '/projects', { job_number: '25-001', name: 'Dup' })).status, 400);
  e1 = (await boss('POST', '/employees', { first_name: 'Dan', last_name: 'Miller', trade: 'Carpenter', union_local: '1445', skills: [{ name: 'OSHA 30', expires_on: '2027-01-01' }, 'Forklift'] })).body.id;
  e2 = (await boss('POST', '/employees', { first_name: 'Jose', last_name: 'Ramirez', trade: 'Laborer' })).body.id;
  const emp = (await field('GET', `/employees/${e1}`)).body;
  assert.deepEqual(emp.skills.map((s) => s.name), ['Forklift', 'OSHA 30']);
  assert.equal((await field('POST', '/employees', { first_name: 'X', last_name: 'Y' })).status, 403);
});

test('prevents double booking', async () => {
  const r1 = await boss('POST', '/assignments', { project_id: p1, employee_ids: [e1, e2], dates: [MON, '2026-11-03'], planned_hours: 8 });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.created.length, 4);
  assert.deepEqual(r1.body.warnings, []); // exactly 8 h is not over

  // Same person on the same job twice in one day -> rejected
  const r3 = await boss('POST', '/assignments', { project_id: p1, employee_ids: [e1], dates: [MON], planned_hours: 2 });
  assert.equal(r3.status, 409);
  assert.match(r3.body.conflicts[0].message, /already scheduled on 25-001/);

  // Over the hard daily limit (12) -> rejected
  const r2 = await boss('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: [MON], planned_hours: 6 });
  assert.equal(r2.status, 409);
  assert.match(r2.body.conflicts[0].message, /would have 14 hrs \(daily limit 12\)/);

  // Moving onto a day already on that job -> rejected
  await boss('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: ['2026-11-04'], planned_hours: 8 });
  const sched = (await field('GET', `/schedule?start=${MON}`)).body;
  const wed = sched.assignments.find((a) => a.employee_id === e1 && a.work_date === '2026-11-04');
  assert.equal((await boss('PUT', `/assignments/${wed.id}`, { work_date: MON, project_id: p1 })).status, 409);

  // Database constraint backs up the same-job rule even if app checks were bypassed
  assert.throws(() => conn.prepare('INSERT INTO assignments (employee_id, project_id, work_date) VALUES (?, ?, ?)').run(e1, p1, MON), /UNIQUE/);
});

test('split days are allowed and over 8 hours a day is warned, not blocked', async () => {
  const day = '2026-11-12';
  const a = await boss('POST', '/assignments', { project_id: p1, employee_ids: [e2], dates: [day], planned_hours: 4 });
  assert.equal(a.status, 200);
  const b = await boss('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: [day], planned_hours: 4 });
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.warnings, []);
  let s = (await field('GET', `/schedule?start=${day}`)).body;
  assert.equal(s.totals.by_day[day].headcount, 1); // one person, two jobs
  assert.equal(s.totals.by_day[day].hours, 8);
  assert.deepEqual(s.totals.over_day, []);

  // A third job taking the day to 10 h is saved, with a warning
  const p3 = (await boss('POST', '/projects', { job_number: '25-003', name: 'Plant' })).body.id;
  const c = await boss('POST', '/assignments', { project_id: p3, employee_ids: [e2], dates: [day], planned_hours: 2 });
  assert.equal(c.status, 200);
  assert.equal(c.body.warnings.length, 1);
  assert.match(c.body.warnings[0].message, /Jose Ramirez is scheduled 10 hrs on 2026-11-12 \(over 8\)/);
  s = (await field('GET', `/schedule?start=${day}`)).body;
  assert.deepEqual(s.totals.over_day, [{ employee_id: e2, work_date: day, hours: 10 }]);

  // Editing hours up also warns; threshold follows the admin setting
  const one = s.assignments.find((x) => x.project_id === p1);
  assert.equal((await boss('PUT', `/assignments/${one.id}`, { planned_hours: 5 })).body.warnings[0].hours, 11);
  await boss('PUT', '/settings', { warn_daily_hours: 12 });
  assert.deepEqual((await boss('PUT', `/assignments/${one.id}`, { planned_hours: 4 })).body.warnings, []);
  await boss('PUT', '/settings', { warn_daily_hours: 8 });

  // Clean up so later tests see the original schedule
  for (const x of (await field('GET', `/schedule?start=${day}`)).body.assignments) await boss('DELETE', `/assignments/${x.id}`);
});

test('projects list a superintendent and project manager from employees', async () => {
  const supt = (await boss('POST', '/employees', { first_name: 'Mike', last_name: 'Jones', classification: 'Superintendent' })).body.id;
  const pm = (await boss('POST', '/employees', { first_name: 'Sarah', last_name: 'Collins', classification: 'Project Manager' })).body.id;
  assert.equal((await sup('PUT', `/projects/${p1}`, { job_number: '25-001', name: 'School', budget_hours: 100, superintendent_employee_id: supt, project_manager_employee_id: pm })).status, 200);
  const proj = (await field('GET', '/projects')).body.find((x) => x.id === p1);
  assert.equal(proj.superintendent_name, 'Mike Jones');
  assert.equal(proj.project_manager_name, 'Sarah Collins');
  const sched = (await field('GET', `/schedule?start=${MON}`)).body.projects.find((x) => x.id === p1);
  assert.equal(sched.project_manager_employee_id, pm);
  // Removing the employee clears the field rather than breaking the project
  await boss('DELETE', `/employees/${pm}`);
  assert.equal((await field('GET', '/projects')).body.find((x) => x.id === p1).project_manager_name, null);
});

test('blocks scheduling on time off', async () => {
  const r = await sup('POST', '/time-off', { employee_id: e2, dates: ['2026-11-05'], reason: 'Vacation' });
  assert.equal(r.body.added, 1);
  const a = await boss('POST', '/assignments', { project_id: p1, employee_ids: [e2], dates: ['2026-11-05'] });
  assert.equal(a.status, 409);
  assert.match(a.body.conflicts[0].message, /off \(Vacation\)/);
});

test('schedule running totals', async () => {
  const s = (await field('GET', `/schedule?start=2026-11-04`)).body;
  assert.equal(s.start, MON);
  assert.equal(s.totals.hours, 40);
  assert.equal(s.totals.by_project[p1].hours, 32);
  assert.equal(s.totals.by_project[p1].headcount, 2);
  assert.equal(s.totals.by_day[MON].headcount, 2);
  assert.equal(s.totals.by_employee[e1], 24);
});

test('field staff cannot schedule or verify', async () => {
  assert.equal((await field('POST', '/assignments', { project_id: p1, employee_ids: [e1], dates: ['2026-11-06'] })).status, 403);
  assert.equal((await field('GET', `/verification?start=${MON}`)).status, 403);
});

test('hour verification', async () => {
  const v = (await sup('GET', `/verification?start=${MON}&project_id=${p1}`)).body;
  assert.equal(v.rows.length, 4);
  const [a, b, ...rest] = v.rows;
  await sup('POST', `/assignments/${a.id}/verify`, { status: 'verified', actual_hours: 9.5 });
  assert.equal((await sup('POST', `/assignments/${b.id}/verify`, { status: 'no_show' })).status, 400); // reason required
  await sup('POST', `/assignments/${b.id}/verify`, { status: 'no_show', note: 'Sick – excused: called in at 6am' });
  const bulk = await sup('POST', '/verification/bulk', { ids: rest.map((r) => r.id) });
  assert.equal(bulk.body.verified, 2);
  const after = (await sup('GET', `/verification?start=${MON}&project_id=${p1}`)).body;
  assert.equal(after.summary.pending_count, 0);
  assert.equal(after.summary.no_show_count, 1);
  assert.equal(after.summary.actual, 9.5 + 16);
  assert.equal(after.summary.variance, 9.5 + 16 - 32);
  assert.equal(after.rows.find((r) => r.id === a.id).status, 'adjusted');
});

test('payroll is private and computes OT', async () => {
  assert.equal((await sup('GET', '/payroll/forecast')).status, 403);
  assert.equal((await field('GET', '/payroll/rates')).status, 403);
  // No pay fields leak through general endpoints
  assert.ok(!('base_rate' in (await sup('GET', '/employees')).body[0]));

  await boss('POST', `/payroll/rates/${e1}`, { effective_date: '2026-01-01', base_rate: 40, fringe_rate: 20, burden_pct: 10 });
  // Push e1 over 40 hours: Thu-Sat 12h days on p2 => 8+8+8 already + 36 = 60
  await boss('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: ['2026-11-05', '2026-11-06', '2026-11-07'], planned_hours: 12 });
  const f = (await boss('GET', `/payroll/forecast?start=${MON}&weeks=1`)).body;
  const emp = f.by_employee.find((x) => x.employee_id === e1);
  assert.equal(emp.hours, 9.5 + 8 + 8 + 36); // Mon verified 9.5
  assert.equal(emp.ot_hours, emp.hours - 40);
  const wages = 40 * 40 + emp.ot_hours * 40 * 1.5;
  assert.equal(emp.wages, wages);
  assert.equal(emp.burden, wages * 0.1);
  assert.equal(emp.fringe, emp.hours * 20);
  assert.ok(f.missing_rates.includes('Jose Ramirez'));
});

test('records search + CSV export', async () => {
  const r = (await field('GET', `/records?from=${MON}&to=2026-11-08&employee_id=${e1}`)).body;
  assert.equal(r.rows.length, 6);
  const csv = await field('GET', `/records?from=${MON}&format=csv`);
  assert.match(csv.body, /^Date,Job #,Project/);
});

test('copy week skips conflicts', async () => {
  await boss('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: ['2026-11-09'] });
  const r = (await boss('POST', '/assignments/copy-week', { from: MON, to: '2026-11-09' })).body;
  assert.ok(r.created.length > 0);
  assert.equal(r.conflicts.length, 1);
});

test('admin-only user management and audit trail', async () => {
  assert.equal((await sup('POST', '/users', { username: 'x', name: 'X', password: 'password1' })).status, 403);
  const u = await boss('POST', '/users', { username: 'newsuper', name: 'New Super', role: 'super', password: 'password1', can_view_payroll: true });
  assert.equal(u.status, 200);
  const log = (await boss('GET', '/audit')).body;
  assert.ok(log.some((l) => l.action === 'verify_bulk'));
});

test('admin can download a database backup', async () => {
  assert.equal((await sup('GET', '/backup')).status, 403);
  const r = await boss('GET', '/backup');
  assert.equal(r.status, 200);
  assert.match(String(r.body).slice(0, 16), /^SQLite format 3/);
});

test('pay rate history: each day is costed at the rate in effect that day', async () => {
  // e1 already has $40 from 2026-01-01. A raise to $50 effective Wednesday of the test week.
  assert.equal((await sup('POST', `/payroll/rates/${e1}`, { effective_date: '2026-11-04', base_rate: 50 })).status, 403);
  await boss('POST', `/payroll/rates/${e1}`, { effective_date: '2026-11-04', base_rate: 50, fringe_rate: 20, burden_pct: 10, note: 'Union increase' });
  const f = (await boss('GET', `/payroll/forecast?start=${MON}&weeks=1`)).body;
  const emp = f.by_employee.find((x) => x.employee_id === e1);
  // Mon 9.5 + Tue 8 at $40 = 17.5 reg hrs; Wed 8 + Thu 12 at $50 reg until 40 hrs, rest OT at $50
  // Hours in order: Mon 9.5, Tue 8, Wed 8 (p2), Thu 12, Fri 12, Sat 12 = 61.5
  const reg40 = 17.5 * 40;
  const reg50 = (40 - 17.5) * 50;
  const ot50 = (emp.hours - 40) * 50 * 1.5;
  assert.equal(emp.wages, reg40 + reg50 + ot50);

  const rates = (await boss('GET', '/payroll/rates')).body.find((r) => r.employee_id === e1);
  assert.equal(rates.history.length, 2);
  assert.equal(rates.history[0].effective_date, '2026-11-04');
  assert.equal(rates.history[0].note, 'Union increase');

  // Deleting the raise puts the whole week back at $40
  await boss('DELETE', `/payroll/rates/entry/${rates.history[0].id}`);
  const f2 = (await boss('GET', `/payroll/forecast?start=${MON}&weeks=1`)).body;
  assert.equal(f2.by_employee.find((x) => x.employee_id === e1).wages, 40 * 40 + (emp.hours - 40) * 40 * 1.5);
});

test('upgrades a database from an earlier version without losing data', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE projects (id INTEGER PRIMARY KEY, job_number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, superintendent_user_id INTEGER, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, can_view_payroll INTEGER NOT NULL DEFAULT 0, employee_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE employee_pay (employee_id INTEGER PRIMARY KEY, base_rate REAL NOT NULL DEFAULT 0, fringe_rate REAL NOT NULL DEFAULT 0, burden_pct REAL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE assignments (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_date TEXT NOT NULL,
      planned_hours REAL NOT NULL DEFAULT 8, start_time TEXT, task TEXT, actual_hours REAL, status TEXT NOT NULL DEFAULT 'scheduled',
      verified_by INTEGER, verified_at TEXT, verify_note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (employee_id, work_date));
    INSERT INTO employees (id, first_name, last_name) VALUES (1, 'Dan', 'Miller');
    INSERT INTO users (id, username, name, password_hash, role, employee_id) VALUES (1, 'mjones', 'Mike Jones', 'x', 'super', 1);
    INSERT INTO projects (id, job_number, name, superintendent_user_id) VALUES (1, '24-101', 'School', 1), (2, '24-115', 'Bridge', NULL);
    INSERT INTO employee_pay (employee_id, base_rate, fringe_rate, updated_at) VALUES (1, 45.5, 24.5, '2026-05-01 10:00:00');
    INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, status, actual_hours) VALUES (1, 1, '2026-10-26', 8, 'verified', 8);
  `);
  old.close();

  const up = db.open(file);
  assert.equal(up.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(up.prepare('SELECT starting_hours AS h FROM projects WHERE id = 1').get().h, 0);
  assert.equal(up.prepare('SELECT approval_status AS s FROM assignments').get().s, 'approved'); // existing work counts as approved
  assert.equal(up.prepare('SELECT superintendent_employee_id AS s FROM projects WHERE id = 1').get().s, 1);
  const a = up.prepare('SELECT * FROM assignments').all();
  assert.equal(a.length, 1);
  assert.equal(a[0].status, 'verified');
  const r = up.prepare('SELECT * FROM employee_pay_rates').all();
  assert.equal(r.length, 1);
  assert.equal(r[0].base_rate, 45.5);
  assert.equal(r[0].effective_date, '2026-05-01');
  assert.ok(!up.prepare("SELECT 1 FROM sqlite_master WHERE name = 'employee_pay'").get());
  // Split days now allowed at the database level
  up.prepare("INSERT INTO assignments (employee_id, project_id, work_date, planned_hours) VALUES (1, 2, '2026-10-26', 2)").run();
  up.close();
  // Opening again is a no-op
  const again = db.open(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM assignments').get().n, 2);
  again.close();
});

test('superintendents request crew on their own jobs; the manager approves or rejects with a reason', async () => {
  const day = '2026-11-16';
  const mike = (await boss('GET', '/employees')).body.find((e) => e.first_name === 'Mike' && e.last_name === 'Jones');
  // Link the superintendent login to Mike Jones, who runs p1 (set in the earlier projects test)
  await boss('PUT', '/users/2', { username: 'super', name: 'Super', role: 'super', employee_id: mike.id });
  const supNow = await login('super');

  // Requests on their own job are pending; other jobs are refused
  const r = await supNow('POST', '/assignments', { project_id: p1, employee_ids: [e1, e2], dates: [day], planned_hours: 8 });
  assert.equal(r.status, 200);
  assert.equal(r.body.approval_status, 'pending');
  assert.equal((await supNow('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: ['2026-11-17'] })).status, 403);
  assert.equal((await supNow('POST', '/assignments/approve', { ids: r.body.created })).status, 403);

  // Field staff don't see pending; the manager does
  assert.equal((await field('GET', `/schedule?start=${day}`)).body.assignments.length, 0);
  const s = (await boss('GET', `/schedule?start=${day}`)).body;
  assert.equal(s.totals.approval.pending, 2);
  assert.equal(s.assignments[0].requested_by_name, 'Super');
  // Payroll and verification ignore pending requests
  const f = (await boss('GET', `/payroll/forecast?start=${day}&weeks=1`)).body;
  assert.equal(f.totals.hours, 0);
  assert.deepEqual(f.pending_requests, { count: 2, hours: 16 });
  assert.equal((await boss('GET', `/verification?start=${day}`)).body.rows.length, 0);

  const [a1, a2] = r.body.created;
  const ofE1 = s.assignments.find((x) => x.employee_id === e1).id;
  const ofE2 = s.assignments.find((x) => x.employee_id === e2).id;
  assert.deepEqual([a1, a2].sort(), [ofE1, ofE2].sort());

  // Rejecting needs a reason
  assert.equal((await boss('POST', '/assignments/reject', { ids: [ofE2] })).status, 400);
  assert.equal((await boss('POST', '/assignments/reject', { ids: [ofE2], reason: 'Jose is needed on the bridge pour' })).body.rejected, 1);
  const reqs = (await supNow('GET', '/requests')).body;
  assert.equal(reqs.rejected[0].reject_reason, 'Jose is needed on the bridge pour');
  assert.equal(reqs.pending.length, 1);
  // A rejected person is free: the manager can book Jose elsewhere that day with no warning
  const elsewhere = await boss('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: [day], planned_hours: 8 });
  assert.equal(elsewhere.status, 200);
  assert.deepEqual(elsewhere.body.warnings, []);
  assert.equal(elsewhere.body.approval_status, 'approved');

  // Approving makes it visible to crews and counted in payroll
  assert.equal((await boss('POST', '/assignments/approve', { ids: [ofE1] })).body.approved, 1);
  const fieldView = (await field('GET', `/schedule?start=${day}`)).body.assignments;
  assert.ok(fieldView.some((x) => x.id === ofE1 && x.approval_status === 'approved'));
  assert.equal((await boss('GET', `/payroll/forecast?start=${day}&weeks=1`)).body.totals.hours, 16);

  // A superintendent changing an approved entry sends it back for approval
  assert.equal((await supNow('PUT', `/assignments/${ofE1}`, { planned_hours: 6 })).body.approval_status, 'pending');
  // ...but they can't touch another superintendent's job
  const other = (await boss('GET', `/schedule?start=${day}`)).body.assignments.find((x) => x.project_id === p2);
  assert.equal((await supNow('DELETE', `/assignments/${other.id}`)).status, 403);
  // The manager's own edits stay approved
  await boss('POST', '/assignments/approve', { ids: [ofE1] });
  assert.equal((await boss('PUT', `/assignments/${ofE1}`, { planned_hours: 7 })).body.approval_status, 'approved');
});

test('app files are revalidated on every load so new deploys show immediately', async () => {
  const origin = base.replace(/\/api$/, '');
  for (const path of ['/', '/app.js', '/styles.css', '/#/schedule']) {
    const r = await fetch(origin + path);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-cache', path);
  }
  // Plain http request: fetch() adds its own Cache-Control to conditional requests.
  const etag = (await fetch(origin + '/app.js')).headers.get('etag');
  const status = await new Promise((resolve, reject) => {
    require('node:http').get(origin + '/app.js', { headers: { 'If-None-Match': etag } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
  });
  assert.equal(status, 304); // unchanged files are not re-downloaded
});

test('employee import: preview, skip clerical, create, then re-import updates without duplicates', async () => {
  const rows = [
    { 'Employee #': '9001', 'First Name': 'Alan', 'Last Name': 'Pierce', Phone: '(618)790-4668', Trade: 'Carpenter', 'Union Local': 'Zone 3 Carpenters', Classification: 'Carpenter Foreman', 'Hire Date': '6/22/2026', Active: 'Yes', Skills: 'OSHA 30; Forklift' },
    { 'Employee #': '9002', 'First Name': 'Pat', 'Last Name': 'Budz', Classification: 'Project Manager', 'Hire Date': '2023-02-02' },
    { 'Employee #': '9003', 'First Name': 'Ann', 'Last Name': 'Office', Trade: 'CLER', Classification: 'Clerical' },
    { 'Employee #': '9004', 'First Name': '', 'Last Name': 'NoFirst' },
    { 'Employee #': '9005', 'First Name': 'Bad', 'Last Name': 'Date', 'Hire Date': '31/31/2026' },
  ];
  assert.equal((await sup('POST', '/employees/import', { rows })).status, 403);

  // Preview changes nothing
  const pre = (await boss('POST', '/employees/import', { rows, skip: ['Clerical', 'CLER'] })).body;
  assert.deepEqual(pre.summary, { create: 2, update: 0, skip: 1, error: 2 });
  assert.equal(pre.committed, false);
  assert.match(pre.results.find((r) => r.line === 5).reason, /First and last name/);
  assert.match(pre.results.find((r) => r.line === 6).reason, /not a date/);
  assert.ok(!(await boss('GET', '/employees')).body.some((e) => e.employee_no === '9001'));

  // Commit is refused while errors remain
  assert.equal((await boss('POST', '/employees/import', { rows, skip: ['Clerical', 'CLER'], commit: true })).status, 400);
  const good = rows.slice(0, 3);
  const done = (await boss('POST', '/employees/import', { rows: good, skip: ['Clerical', 'CLER'], commit: true })).body;
  assert.deepEqual(done.summary, { create: 2, update: 0, skip: 1, error: 0 });
  const all = (await boss('GET', '/employees?all=1')).body;
  const alan = all.find((e) => e.employee_no === '9001');
  assert.equal(alan.hire_date, '2026-06-22');
  assert.equal(alan.union_local, 'Zone 3 Carpenters');
  assert.deepEqual(alan.skills.map((s) => s.name).sort(), ['Forklift', 'OSHA 30']);
  assert.ok(!all.some((e) => e.last_name === 'Office'));

  // Re-import: matched by employee #, blank cells keep existing data, can deactivate
  const again = (await boss('POST', '/employees/import', { rows: [{ 'Employee #': '9001', 'First Name': 'Alan', 'Last Name': 'Pierce', Phone: '', Classification: 'General Foreman', Active: 'No' }], commit: true })).body;
  assert.deepEqual(again.summary, { create: 0, update: 1, skip: 0, error: 0 });
  const alan2 = (await boss('GET', '/employees?all=1')).body.find((e) => e.employee_no === '9001');
  assert.equal(alan2.classification, 'General Foreman');
  assert.equal(alan2.phone, '(618)790-4668');
  assert.equal(alan2.active, 0);
  assert.equal((await boss('GET', '/employees?all=1')).body.filter((e) => e.employee_no === '9001').length, 1);
});

test('no-show reasons and future time off show up under the employee', async () => {
  const emp = (await boss('GET', `/employees/${e2}`)).body;
  assert.ok(emp.no_shows.some((n) => /Sick – excused/.test(n.verify_note)));

  // Three weeks off next spring, weekdays only, entered from the employee record
  const r = (await boss('POST', '/time-off', { employee_id: e1, from: '2027-03-01', to: '2027-03-19', weekdays_only: true, reason: 'Vacation' })).body;
  assert.equal(r.added, 15);
  const after = (await boss('GET', `/employees/${e1}`)).body;
  assert.equal(after.time_off.filter((t) => t.off_date >= '2027-03-01').length, 15);
  // That week on the schedule already shows them off, and they can't be booked
  const wk = (await boss('GET', '/schedule?start=2027-03-08')).body;
  assert.equal(wk.time_off.filter((t) => t.employee_id === e1).length, 5);
  const book = await boss('POST', '/assignments', { project_id: p1, employee_ids: [e1], dates: ['2027-03-10'] });
  assert.equal(book.status, 409);
  assert.match(book.body.conflicts[0].message, /off \(Vacation\)/);
  assert.equal((await boss('POST', '/time-off', { employee_id: e1, from: '2027-03-19', to: '2027-03-01' })).status, 400);
});

test('projects: starting hours and change orders roll into hours used and total budget', async () => {
  const pid = (await boss('POST', '/projects', { job_number: 'CO-1', name: 'Change order job', budget_hours: 1000, starting_hours: 250 })).body.id;
  await boss('POST', `/projects/${pid}/change-orders`, { co_number: 'CO-001', description: 'Added canopy', hours: 120, co_date: '2026-11-01' });
  await boss('POST', `/projects/${pid}/change-orders`, { co_number: 'CO-002', description: 'Deduct alt 2', hours: -20 });
  assert.equal((await boss('POST', `/projects/${pid}/change-orders`, { hours: 'lots' })).status, 400);
  await boss('POST', '/assignments', { project_id: pid, employee_ids: [e2], dates: ['2026-11-30'], planned_hours: 8 });
  let p = (await field('GET', '/projects')).body.find((x) => x.id === pid);
  assert.equal(p.co_hours, 100);
  assert.equal(p.total_budget_hours, 1100);
  assert.equal(p.hours_to_date, 258);
  const cos = (await field('GET', `/projects/${pid}/change-orders`)).body;
  assert.equal(cos.length, 2);
  // A superintendent who doesn't run the job can't add change orders
  assert.equal((await sup('POST', `/projects/${pid}/change-orders`, { hours: 5 })).status, 403);
  await boss('DELETE', `/change-orders/${cos.find((c) => c.co_number === 'CO-002').id}`);
  p = (await field('GET', '/projects')).body.find((x) => x.id === pid);
  assert.equal(p.total_budget_hours, 1120);
});

test('project import: stages map to status, leads matched by name, re-import updates', async () => {
  const rows = [
    { 'Project Number': 'T530', Name: 'Apple Festival Stand-Stage Setup', Stage: 'Course of Construction', State: 'Illinois', 'Budget Hours': '400', 'Starting Hours': '120', 'Change Order Hours': '40', Superintendent: 'Mike Jones', 'Project Manager': 'Nobody Here' },
    { 'Project Number': '4365', Name: 'City of Carbondale Event Center', Address: 'S. Washington St.', City: 'Carbondale', State: 'Illinois', ZIP: '62901', Stage: 'Bidding' },
    { 'Project Number': 'T115', Name: 'Warranty Work', Stage: 'Warranty' },
    { 'Project Number': '4265', Name: 'Herrin Fire Station', Stage: 'Pre-Construction' },
    { 'Project Number': 'X1', Name: 'Bad', Stage: 'Sideways' },
  ];
  assert.equal((await sup('POST', '/projects/import', { rows })).status, 403);
  const pre = (await boss('POST', '/projects/import', { rows })).body;
  assert.deepEqual(pre.summary, { create: 4, update: 0, skip: 0, error: 1 });
  assert.match(pre.results[0].reason, /Project manager "Nobody Here" is not an employee/);
  const done = (await boss('POST', '/projects/import', { rows: rows.filter((r) => r['Project Number'] !== 'X1'), commit: true })).body;
  assert.deepEqual(done.summary, { create: 4, update: 0, skip: 0, error: 0 });
  const all = (await boss('GET', '/projects?all=1')).body;
  const t530 = all.find((x) => x.job_number === 'T530');
  assert.equal(t530.status, 'active');
  assert.equal(t530.superintendent_name, 'Mike Jones');
  assert.equal(t530.starting_hours, 120);
  assert.equal(t530.total_budget_hours, 440);
  assert.equal(all.find((x) => x.job_number === '4365').status, 'planned');
  assert.equal(all.find((x) => x.job_number === '4365').address, 'S. Washington St., Carbondale, Illinois 62901');
  assert.equal(all.find((x) => x.job_number === 'T115').status, 'active');
  assert.equal(all.find((x) => x.job_number === '4265').status, 'planned'); // Pre-Construction is not Active
  // Re-import: updates by job number, replaces imported CO hours, keeps fields left blank
  const again = (await boss('POST', '/projects/import', { rows: [{ 'Job Number': 'T530', 'Project Name': 'Apple Festival Stage', 'Change Order Hours': '60' }], commit: true })).body;
  assert.deepEqual(again.summary, { create: 0, update: 1, skip: 0, error: 0 });
  const t2 = (await boss('GET', '/projects?all=1')).body.find((x) => x.job_number === 'T530');
  assert.equal(t2.name, 'Apple Festival Stage');
  assert.equal(t2.total_budget_hours, 460);
  assert.equal(t2.starting_hours, 120);
});
