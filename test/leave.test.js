'use strict';
// One employee list (union / superintendent / office staff), one time-off record,
// union holidays, PTO/Vacation allowances, and email notifications.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');
const { holidaysForYear } = require('../server/holidays');

const conn = db.open(':memory:');
const sent = [];
const notifier = { configured: true, from: 'workforce@example.com', send: async (m) => { sent.push(m); } };
let server; let base;
const flush = () => new Promise((r) => setTimeout(r, 20));
const year = new Date().getUTCFullYear() + 1;

before(async () => {
  conn.prepare(`INSERT INTO users (username, name, password_hash, role, email) VALUES ('boss', 'Boss', ?, 'admin', 'boss@example.com')`).run(auth.hashPassword('password1'));
  server = createApp(conn, { notifier }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(username) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(r.status, 200, `login ${username}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
}

let boss; let om; let alice; let sue; let dan; let pm;
let eAlice; let eSue; let eDan; let ePm; let job;

test('union holidays: Saturday -> Friday, Sunday -> Monday', () => {
  const h = Object.fromEntries(holidaysForYear(2026).map((x) => [x.name, x.date]));
  assert.equal(h['Independence Day'], '2026-07-03'); // Jul 4 2026 is a Saturday
  assert.equal(h['Memorial Day'], '2026-05-25');
  assert.equal(h['Labor Day'], '2026-09-07');
  assert.equal(h['Thanksgiving Day'], '2026-11-26');
  assert.equal(h['Veterans Day'], '2026-11-11');
  const h27 = holidaysForYear(2027).map((x) => x.date);
  assert.ok(h27.includes('2027-07-05')); // Jul 4 2027 is a Sunday
  assert.ok(h27.includes('2027-12-24')); // Christmas 2027 is a Saturday
  assert.ok(h27.includes('2027-12-31')); // New Year's 2028 is a Saturday
  assert.equal(holidaysForYear(2026).length, 7);
});

test('one employee list: union, superintendent and office staff; every login links to it', async () => {
  boss = await login('boss');
  eDan = (await boss('POST', '/employees', { first_name: 'Dan', last_name: 'Union', trade: 'Carpenter' })).body.id;
  eSue = (await boss('POST', '/employees', { first_name: 'Sue', last_name: 'Super', classification: 'Superintendent' })).body.id;
  eAlice = (await boss('POST', '/employees', { first_name: 'Alice', last_name: 'Estimator', employee_type: 'staff', department: 'Estimating', email: 'alice@example.com' })).body.id;
  ePm = (await boss('POST', '/employees', { first_name: 'Pat', last_name: 'Manager', classification: 'Project Manager' })).body.id;
  assert.equal((await boss('POST', '/employees', { first_name: 'X', last_name: 'Y', employee_type: 'contractor' })).status, 400);
  const types = Object.fromEntries((await boss('GET', '/employees')).body.map((e) => [e.id, e.employee_type]));
  assert.deepEqual([types[eDan], types[eSue], types[eAlice], types[ePm]], ['union', 'superintendent', 'staff', 'staff']);
  job = (await boss('POST', '/projects', { job_number: '99-100', name: 'Test Job', superintendent_employee_id: eSue })).body.id;
  const mk = (b) => boss('POST', '/users', { password: 'password1', ...b });
  assert.equal((await mk({ username: 'om', name: 'Office Mgr', role: 'office_admin', email: 'om@example.com' })).status, 200);
  assert.equal((await mk({ username: 'alice', name: 'Alice', role: 'office', employee_id: eAlice })).status, 200);
  assert.equal((await mk({ username: 'sue', name: 'Sue', role: 'super', employee_id: eSue, email: 'sue@example.com' })).status, 200);
  assert.equal((await mk({ username: 'dan', name: 'Dan', role: 'viewer', employee_id: eDan })).status, 200);
  assert.equal((await mk({ username: 'pm', name: 'Pat', role: 'office', employee_id: ePm, can_view_schedule: true })).status, 200);
  om = await login('om'); alice = await login('alice'); sue = await login('sue'); dan = await login('dan'); pm = await login('pm');
  // The Office Manager adds employees in the same list.
  assert.equal((await om('POST', '/employees', { first_name: 'New', last_name: 'Hire', employee_type: 'staff' })).status, 200);
  assert.equal((await dan('POST', '/employees', { first_name: 'No', last_name: 'Access' })).status, 403);
});

test('holidays show on the schedule and scheduling on one is allowed with a warning', async () => {
  const wk = (await boss('GET', `/schedule?start=${year}-11-08`)).body;
  const vet = holidaysForYear(year).find((h) => h.name === 'Veterans Day').date;
  if (vet >= wk.start && vet <= wk.end) assert.equal(wk.holidays[vet], 'Veterans Day');
  const r = await boss('POST', '/assignments', { project_id: job, employee_ids: [eDan], dates: [vet], planned_hours: 8 });
  assert.equal(r.status, 200);
  assert.ok(r.body.warnings.some((w) => w.type === 'holiday' && /Veterans Day/.test(w.message)));
  assert.equal((await boss('GET', `/holidays?year=${year}`)).body.length, holidaysForYear(year).length);
});

test('time-off types: staff PTO/Vacation/Other, superintendents PTO/Other, no Personal', async () => {
  const day = `${year}-03-02`;
  assert.equal((await alice('POST', '/time-off/request', { from: day, reason: 'Personal' })).status, 400);
  assert.equal((await sue('POST', '/time-off/request', { from: day, reason: 'Vacation' })).status, 400);
  assert.deepEqual((await alice('GET', '/leave/mine')).body.reasons, ['PTO', 'Vacation', 'Other']);
  assert.deepEqual((await sue('GET', '/leave/mine')).body.reasons, ['PTO', 'Other']);
  assert.equal((await dan('GET', '/leave/mine')).body.balance, null); // union crew have no allowance
});

test('allowances: staff get PTO + Vacation, superintendents PTO; set by the Office Manager', async () => {
  await boss('PUT', '/settings', { staff_pto_default_hours: 40, staff_vacation_default_hours: 80, super_pto_default_hours: 120 });
  let b = (await alice('GET', `/leave/mine?year=${year}`)).body.balance;
  assert.deepEqual(Object.keys(b.kinds), ['pto', 'vacation']);
  assert.equal(b.kinds.pto.allowance, 40); assert.equal(b.kinds.vacation.allowance, 80);
  b = (await sue('GET', `/leave/mine?year=${year}`)).body.balance;
  assert.deepEqual(Object.keys(b.kinds), ['pto']); assert.equal(b.kinds.pto.allowance, 120);
  assert.equal((await om('PUT', `/leave/allowance/${eAlice}`, { year, kind: 'vacation', hours: 120, note: '10+ years' })).body.kinds.vacation.allowance, 120);
  assert.equal((await om('PUT', `/leave/allowance/${eSue}`, { year, kind: 'vacation', hours: 40 })).status, 400);
  assert.equal((await sue('PUT', `/leave/allowance/${eSue}`, { year, kind: 'pto', hours: 999 })).status, 403);
  const all = (await om('GET', `/leave/balances?year=${year}`)).body;
  assert.ok(all.employees.some((e) => e.id === eSue) && all.employees.some((e) => e.id === eAlice));
  assert.ok(!all.employees.some((e) => e.id === eDan));
});

test('requests: staff -> Office Manager, superintendents -> both managers, union -> Workforce Manager', async () => {
  sent.length = 0;
  // Mon Mar 1 – Fri Mar 5 next year style range; weekends skipped.
  const r = await alice('POST', '/time-off/request', { from: `${year}-06-07`, to: `${year}-06-13`, weekdays_only: true, reason: 'Vacation', note: 'Lake week' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await flush();
  assert.equal(sent[0].to, 'om@example.com');
  assert.match(sent[0].text, /Lake week/); assert.match(sent[0].text, /Vacation balance before this request: 120 h left of 120 h/);
  sent.length = 0;
  assert.equal((await sue('POST', '/time-off/request', { from: `${year}-04-12`, reason: 'PTO' })).status, 200);
  await flush();
  assert.equal(sent[0].to, 'boss@example.com, om@example.com');
  sent.length = 0;
  assert.equal((await dan('POST', '/time-off/request', { from: `${year}-04-12`, reason: 'Jury duty' })).status, 200);
  await flush();
  assert.equal(sent[0].to, 'boss@example.com');
  // The superintendent's request is in the same records the Office Manager works from.
  const q = (await om('GET', '/leave/requests')).body.pending;
  assert.ok(q.some((g) => g.employee_id === eSue && g.reason === 'PTO'));
  assert.ok(q.some((g) => g.employee_id === eAlice && g.days === 5));
  assert.equal((await alice('GET', '/leave/requests')).status, 403);
});

test('decisions, calendar privacy, cancel rules', async () => {
  const q = (await om('GET', '/leave/requests')).body.pending;
  const aliceReq = q.find((g) => g.employee_id === eAlice); const sueReq = q.find((g) => g.employee_id === eSue);
  sent.length = 0;
  assert.equal((await om('POST', '/time-off/decide', { ids: aliceReq.ids, action: 'approve' })).body.approved, 5);
  await flush();
  assert.equal(sent[0].to, 'alice@example.com');
  assert.equal((await om('POST', '/time-off/decide', { ids: sueReq.ids, action: 'reject' })).status, 400);
  assert.equal((await om('POST', '/time-off/decide', { ids: sueReq.ids, action: 'reject', reason: 'Gym pour that day' })).body.rejected, 1);
  const b = (await alice('GET', `/leave/mine?year=${year}`)).body.balance.kinds.vacation;
  assert.equal(b.scheduled, 40); assert.equal(b.left, 80);
  // Everyone sees approved time off for everyone; nobody sees pending or rejected there.
  const cal = (await dan('GET', `/leave/calendar?start=${year}-06-01&end=${year}-06-30`)).body;
  assert.equal(cal.days.filter((d) => d.employee_id === eAlice).length, 5);
  const apr = (await alice('GET', `/leave/calendar?start=${year}-04-01&end=${year}-04-30`)).body;
  assert.equal(apr.days.length, 0);
  // Staff see only their own requests.
  const mine = (await alice('GET', '/leave/mine')).body.requests;
  assert.ok(mine.every((g) => g.employee_id === eAlice));
  // Can't cancel someone else's; can cancel own approved future days.
  assert.equal((await dan('DELETE', `/time-off/${aliceReq.ids[0]}`)).status, 403);
  assert.equal((await alice('DELETE', `/time-off/${aliceReq.ids[0]}`)).status, 200);
  // The Office Manager enters time off for office staff only.
  assert.equal((await om('POST', '/time-off', { employee_id: eAlice, from: `${year}-08-03`, reason: 'PTO' })).body.added, 1);
  assert.equal((await om('POST', '/time-off', { employee_id: eDan, from: `${year}-08-03`, reason: 'Vacation' })).status, 403);
});

test('approved time off blocks scheduling; a scheduled day cannot be approved', async () => {
  await boss('POST', '/assignments', { project_id: job, employee_ids: [eDan], dates: [`${year}-04-13`], planned_hours: 8 });
  assert.equal((await dan('POST', '/time-off/request', { from: `${year}-04-13`, reason: 'Vacation' })).status, 200);
  const g = (await boss('GET', '/leave/requests')).body.pending.find((x) => x.employee_id === eDan && x.start_date === `${year}-04-13`);
  const r = (await boss('POST', '/time-off/decide', { ids: g.ids, action: 'approve' })).body;
  assert.equal(r.approved, 0); assert.match(r.conflicts[0], /scheduled on 99-100/);
  const jury = (await boss('GET', '/leave/requests')).body.pending.find((x) => x.employee_id === eDan && x.reason === 'Jury duty');
  await boss('POST', '/time-off/decide', { ids: jury.ids, action: 'approve' });
  const block = await boss('POST', '/assignments', { project_id: job, employee_ids: [eDan], dates: [`${year}-04-12`] });
  assert.equal(block.status, 409);
});

test('approvers edit and delete requests; the person is emailed; the Office Manager only for staff', async () => {
  // Alice (staff) has an approved PTO day on Aug 3 entered by the Office Manager.
  let up = (await om('GET', '/leave/requests')).body.upcoming.find((g) => g.employee_id === eAlice && g.reason === 'PTO');
  assert.ok(up, 'upcoming approved request listed');
  sent.length = 0;
  // Move it to Aug 10–11 as Vacation, 8 h a day: stays approved.
  let r = await om('PUT', '/time-off/request', { ids: up.ids, from: `${year}-08-10`, to: `${year}-08-11`, reason: 'Vacation', hours: 8, weekdays_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await flush();
  assert.match(sent[0].subject, /Your time off was changed/); assert.equal(sent[0].to, 'alice@example.com');
  const cal = (await dan('GET', `/leave/calendar?start=${year}-08-01&end=${year}-08-31`)).body.days.filter((d) => d.employee_id === eAlice);
  assert.deepEqual(cal.map((d) => d.reason), ['Vacation', 'Vacation']);
  // Invalid type for an office staff member; the Office Manager can't edit union crew.
  up = (await om('GET', '/leave/requests')).body.upcoming.find((g) => g.employee_id === eAlice && g.start_date === `${year}-08-10`);
  assert.equal((await om('PUT', '/time-off/request', { ids: up.ids, from: `${year}-08-10`, reason: 'Jury duty' })).status, 400);
  const union = (await boss('GET', '/leave/requests')).body.upcoming.find((g) => g.employee_id === eDan);
  assert.equal((await om('POST', '/time-off/remove', { ids: union.ids })).status, 403);
  assert.equal((await alice('POST', '/time-off/remove', { ids: up.ids })).status, 403);
  // Moving approved time off onto a scheduled day is refused and leaves the original alone.
  await boss('POST', '/assignments', { project_id: job, employee_ids: [eDan], dates: [`${year}-04-20`], planned_hours: 8 });
  const bad = await boss('PUT', '/time-off/request', { ids: union.ids, from: `${year}-04-20`, reason: 'Jury duty' });
  assert.equal(bad.status, 400);
  assert.ok((await boss('GET', '/leave/requests')).body.upcoming.some((g) => g.employee_id === eDan && g.start_date === union.start_date));
  // Delete with a reason -> email, gone from the calendar and the balance.
  sent.length = 0;
  assert.equal((await om('POST', '/time-off/remove', { ids: up.ids, reason: 'Entered by mistake' })).body.removed, 2);
  await flush();
  assert.match(sent[0].subject, /Your time off was removed/); assert.match(sent[0].text, /Entered by mistake/);
  assert.equal((await dan('GET', `/leave/calendar?start=${year}-08-01&end=${year}-08-31`)).body.days.filter((d) => d.employee_id === eAlice).length, 0);
});

test('a PM (office login with schedule access) sees approved work only and cannot edit', async () => {
  assert.equal((await pm('GET', '/me')).body.user.can_view_schedule, 1);
  const s = (await pm('GET', `/schedule?start=${year}-04-12`)).body;
  assert.ok(s.assignments.every((a) => a.approval_status === 'approved'));
  assert.deepEqual(s.slots, []);
  assert.equal((await pm('POST', '/assignments', { project_id: job, employee_ids: [eDan], dates: [`${year}-04-14`] })).status, 403);
});

test('upgrade from v9: office roster, logins, requests and allowances move onto employees', () => {
  const old = new (require('node:sqlite').DatabaseSync)(':memory:');
  old.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY, employee_no TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL, phone TEXT, email TEXT, trade TEXT,
      union_local TEXT, classification TEXT, hire_date TEXT, active INTEGER NOT NULL DEFAULT 1, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE office_staff (id INTEGER PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, department TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','super','viewer','office','office_admin')), can_view_payroll INTEGER NOT NULL DEFAULT 0,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL, office_staff_id INTEGER REFERENCES office_staff(id) ON DELETE SET NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), email TEXT, notify_requests INTEGER NOT NULL DEFAULT 1, can_view_schedule INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE office_time_off_requests (id INTEGER PRIMARY KEY, office_staff_id INTEGER NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'pto', note TEXT, status TEXT NOT NULL DEFAULT 'pending', requested_by INTEGER, decided_by INTEGER, decided_at TEXT, decision_note TEXT,
      calendar_event_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE office_pto_allowances (office_staff_id INTEGER NOT NULL, year INTEGER NOT NULL, hours REAL NOT NULL, note TEXT, updated_by INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (office_staff_id, year));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO settings VALUES ('office_pto_default_hours', '96');
    INSERT INTO employees (first_name, last_name, classification) VALUES ('Sarah', 'Collins', 'Project Manager'), ('Mike', 'Jones', 'Superintendent'), ('Kyle', 'Brooks', 'Journeyman');
    INSERT INTO office_staff (first_name, last_name, email, department) VALUES ('Sarah', 'Collins', 's@example.com', 'PM'), ('Pat', 'Morgan', 'p@example.com', 'Accounting');
    INSERT INTO users (username, name, password_hash, role, office_staff_id) VALUES ('pmorgan', 'Pat', 'x', 'office_admin', 2), ('scollins', 'Sarah', 'x', 'office', 1);
    INSERT INTO office_time_off_requests (office_staff_id, start_date, end_date, type, status) VALUES (2, '2026-12-21', '2026-12-27', 'pto', 'approved'), (1, '2026-12-01', '2026-12-01', 'sick', 'cancelled');
    INSERT INTO office_pto_allowances (office_staff_id, year, hours) VALUES (2, 2026, 160);
    PRAGMA user_version = 9;`);
  const file = require('node:path').join(require('node:os').tmpdir(), `wf-up10-${process.pid}.db`);
  old.exec(`VACUUM INTO '${file}'`); old.close();
  const up = db.open(file);
  const emp = (f) => up.prepare('SELECT * FROM employees WHERE first_name = ?').get(f);
  assert.equal(emp('Sarah').employee_type, 'staff'); assert.equal(emp('Sarah').department, 'PM');
  assert.equal(emp('Mike').employee_type, 'superintendent'); assert.equal(emp('Kyle').employee_type, 'union');
  assert.equal(emp('Pat').employee_type, 'staff'); assert.equal(emp('Pat').email, 'p@example.com');
  assert.equal(up.prepare("SELECT employee_id FROM users WHERE username = 'pmorgan'").get().employee_id, emp('Pat').id);
  assert.equal(up.prepare("SELECT employee_id FROM users WHERE username = 'scollins'").get().employee_id, emp('Sarah').id);
  const days = up.prepare('SELECT off_date, status, reason FROM time_off WHERE employee_id = ? ORDER BY off_date').all(emp('Pat').id);
  assert.deepEqual(days.map((d) => d.off_date), ['2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25']);
  assert.ok(days.every((d) => d.status === 'approved' && d.reason === 'PTO'));
  assert.equal(up.prepare('SELECT COUNT(*) AS n FROM time_off WHERE employee_id = ?').get(emp('Sarah').id).n, 0); // cancelled not carried over
  assert.equal(up.prepare("SELECT hours FROM leave_allowances WHERE employee_id = ? AND kind = 'pto'").get(emp('Pat').id).hours, 160);
  assert.equal(up.prepare("SELECT value FROM settings WHERE key = 'staff_pto_default_hours'").get().value, '96');
  assert.equal(up.prepare('PRAGMA user_version').get().user_version, 10);
  up.close();
  require('node:fs').rmSync(file, { force: true });
});
