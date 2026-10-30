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
  const r1 = await sup('POST', '/assignments', { project_id: p1, employee_ids: [e1, e2], dates: [MON, '2026-11-03'], planned_hours: 8, start_time: '07:00' });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.created.length, 4);

  // Same person, same day, overlapping time on another job -> rejected
  const r2 = await sup('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: [MON], planned_hours: 8, start_time: '07:00' });
  assert.equal(r2.status, 409);
  assert.match(r2.body.conflicts[0].message, /overlaps 25-001 \(07:00–15:00\)/);

  // Same person on the same job twice in one day -> rejected
  const r3 = await sup('POST', '/assignments', { project_id: p1, employee_ids: [e1], dates: [MON], planned_hours: 2, start_time: '16:00' });
  assert.equal(r3.status, 409);
  assert.match(r3.body.conflicts[0].message, /already scheduled on 25-001/);

  // Mixed request: new day goes through, overlapping day is skipped
  const r4 = await sup('POST', '/assignments', { project_id: p2, employee_ids: [e1], dates: [MON, '2026-11-04'], planned_hours: 8, start_time: '07:00' });
  assert.equal(r4.body.created.length, 1);
  assert.equal(r4.body.conflicts.length, 1);

  // Moving an assignment onto an overlapping slot -> rejected
  const sched = (await field('GET', `/schedule?start=${MON}`)).body;
  const wed = sched.assignments.find((a) => a.employee_id === e1 && a.work_date === '2026-11-04');
  const move = await sup('PUT', `/assignments/${wed.id}`, { work_date: MON });
  assert.equal(move.status, 409);

  // Database constraint backs up the same-job rule even if app checks were bypassed
  assert.throws(() => conn.prepare('INSERT INTO assignments (employee_id, project_id, work_date) VALUES (?, ?, ?)').run(e1, p1, MON), /UNIQUE/);
});

test('allows split days within the daily cap', async () => {
  const day = '2026-11-12';
  const a = await sup('POST', '/assignments', { project_id: p1, employee_ids: [e2], dates: [day], planned_hours: 4, start_time: '07:00' });
  assert.equal(a.status, 200);
  const b = await sup('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: [day], planned_hours: 4, start_time: '11:30' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const s = (await field('GET', `/schedule?start=${day}`)).body;
  assert.equal(s.assignments.filter((x) => x.employee_id === e2 && x.work_date === day).length, 2);
  assert.equal(s.totals.by_day[day].headcount, 1); // one person, two jobs
  assert.equal(s.totals.by_day[day].hours, 8);

  // Third slot that pushes the day past the 12-hour cap -> rejected
  const c = await sup('POST', '/assignments', { project_id: (await boss('POST', '/projects', { job_number: '25-003', name: 'Plant' })).body.id, employee_ids: [e2], dates: [day], planned_hours: 6, start_time: '16:00' });
  assert.equal(c.status, 409);
  assert.match(c.body.conflicts[0].message, /would have 14 hrs \(daily limit 12\)/);

  // Without start times only the cap applies
  const d2 = '2026-11-13';
  assert.equal((await sup('POST', '/assignments', { project_id: p1, employee_ids: [e2], dates: [d2], planned_hours: 6 })).status, 200);
  assert.equal((await sup('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: [d2], planned_hours: 6 })).status, 200);
  // Clean up so later tests see the original schedule
  for (const x of (await field('GET', `/schedule?start=${day}`)).body.assignments) await sup('DELETE', `/assignments/${x.id}`);
});

test('blocks scheduling on time off', async () => {
  const r = await sup('POST', '/time-off', { employee_id: e2, dates: ['2026-11-05'], reason: 'Vacation' });
  assert.equal(r.body.added, 1);
  const a = await sup('POST', '/assignments', { project_id: p1, employee_ids: [e2], dates: ['2026-11-05'] });
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
  await sup('POST', `/assignments/${b.id}/verify`, { status: 'no_show' });
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
  await sup('POST', '/assignments', { project_id: p2, employee_ids: [e2], dates: ['2026-11-09'] });
  const r = (await sup('POST', '/assignments/copy-week', { from: MON, to: '2026-11-09' })).body;
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

test('upgrades a database from the earlier version without losing data', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`
    CREATE TABLE employees (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE projects (id INTEGER PRIMARY KEY, job_number TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, can_view_payroll INTEGER NOT NULL DEFAULT 0, employee_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE employee_pay (employee_id INTEGER PRIMARY KEY, base_rate REAL NOT NULL DEFAULT 0, fringe_rate REAL NOT NULL DEFAULT 0, burden_pct REAL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE assignments (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL, project_id INTEGER NOT NULL, work_date TEXT NOT NULL,
      planned_hours REAL NOT NULL DEFAULT 8, start_time TEXT, task TEXT, actual_hours REAL, status TEXT NOT NULL DEFAULT 'scheduled',
      verified_by INTEGER, verified_at TEXT, verify_note TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (employee_id, work_date));
    INSERT INTO employees (id, first_name, last_name) VALUES (1, 'Dan', 'Miller');
    INSERT INTO projects (id, job_number, name) VALUES (1, '24-101', 'School'), (2, '24-115', 'Bridge');
    INSERT INTO employee_pay (employee_id, base_rate, fringe_rate, updated_at) VALUES (1, 45.5, 24.5, '2026-05-01 10:00:00');
    INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, status, actual_hours) VALUES (1, 1, '2026-10-26', 8, 'verified', 8);
  `);
  old.close();

  const up = db.open(file);
  assert.equal(up.prepare('PRAGMA user_version').get().user_version, 2);
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
