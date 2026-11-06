'use strict';
// Time-off requests and balances, office logins that can view the field schedule, and email notifications.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');

const conn = db.open(':memory:');
const sent = []; // emails the app tried to send
const notifier = { configured: true, from: 'workforce@example.com', send: async (m) => { sent.push(m); } };
let server; let base;
const flush = () => new Promise((r) => setTimeout(r, 20)); // emails go out after the response

before(async () => {
  const pw = auth.hashPassword('password1');
  conn.prepare(`INSERT INTO users (username, name, password_hash, role, email) VALUES ('boss', 'Boss', ?, 'admin', 'boss@example.com')`).run(pw);
  conn.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES ('super', 'Super', ?, 'super')`).run(pw);
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

const year = new Date().getUTCFullYear() + 1; // next year, so every day is in the future
let boss; let worker; let pm; let eid; let pmEid; let job;

test('setup: an employee with a login, and a project manager', async () => {
  boss = await login('boss');
  eid = (await boss('POST', '/employees', { first_name: 'Test', last_name: 'Carpenter', trade: 'Carpenter' })).body.id;
  pmEid = (await boss('POST', '/employees', { first_name: 'Test', last_name: 'Manager', classification: 'Project Manager' })).body.id;
  job = (await boss('POST', '/projects', { job_number: '99-001', name: 'Test Job', project_manager_employee_id: pmEid })).body.id;
  assert.equal((await boss('POST', '/users', { username: 'worker', name: 'Test Carpenter', password: 'password1', role: 'viewer', employee_id: eid, email: 'worker@example.com' })).status, 200);
  assert.equal((await boss('POST', '/users', { username: 'pm', name: 'Test Manager', password: 'password1', role: 'office', employee_id: pmEid, can_view_schedule: true })).status, 200);
  assert.equal((await boss('POST', '/users', { username: 'acct', name: 'Test Accounting', password: 'password1', role: 'office' })).status, 200);
  assert.equal((await boss('POST', '/users', { username: 'x', name: 'X', password: 'password1', role: 'owner' })).status, 400);
  assert.equal((await boss('POST', '/users', { username: 'y', name: 'Y', password: 'password1', role: 'viewer', email: 'not-an-email' })).status, 400);
  worker = await login('worker'); pm = await login('pm');
});

test('an office login with "can view the field schedule" (a PM) sees approved work only and cannot edit', async () => {
  await boss('POST', '/assignments', { project_id: job, employee_ids: [eid], dates: [`${year}-02-01`], planned_hours: 8 });
  const sched = (await pm('GET', `/schedule?start=${year}-02-01`)).body;
  assert.ok(sched.assignments.length >= 1);
  assert.deepEqual(sched.slots, []);
  assert.equal((await pm('POST', '/assignments', { project_id: job, employee_ids: [eid], dates: [`${year}-02-02`] })).status, 403);
  assert.equal((await pm('GET', '/requests')).status, 403);
  assert.equal((await pm('GET', '/pto')).status, 403);
  assert.equal((await pm('GET', '/me')).body.user.can_view_schedule, 1);
  const acct = await login('acct');
  assert.equal((await acct('GET', '/me')).body.user.can_view_schedule, 0);
});

test('yearly allowance and balance', async () => {
  await boss('PUT', '/settings', { pto_default_hours: 40 });
  let b = (await worker('GET', `/my-schedule?year=${year}`)).body.pto;
  assert.equal(b.allowance, 40);
  b = (await boss('PUT', `/pto/${eid}`, { year, hours: 80, note: '5+ years' })).body;
  assert.equal(b.allowance, 80); assert.equal(b.left, 80); assert.equal(b.custom, true);
  assert.equal((await worker('PUT', `/pto/${eid}`, { year, hours: 999 })).status, 403);
  const bulk = (await boss('POST', '/pto/bulk', { year, hours: 60, trade: 'Laborer' })).body;
  assert.equal(bulk.updated, 0); // no laborers
});

test('an employee requests time off, the manager is emailed, then approves it', async () => {
  sent.length = 0;
  const r = await worker('POST', '/time-off/request', { from: `${year}-03-01`, to: `${year}-03-07`, weekdays_only: true, reason: 'Vacation', note: 'Family trip' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.added, 5);
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'boss@example.com');
  assert.match(sent[0].subject, /Time-off request: Test Carpenter/);
  assert.match(sent[0].text, /Family trip/);
  assert.match(sent[0].text, /80 h left of 80 h/);

  // Pending: counted as pending, doesn't block scheduling, isn't on the schedule.
  let b = (await worker('GET', `/my-schedule?year=${year}`)).body.pto;
  assert.equal(b.pending, 40); assert.equal(b.left, 80);
  const wk = (await boss('GET', `/schedule?start=${year}-03-01`)).body;
  assert.equal(wk.time_off.length, 0);
  assert.equal(wk.totals.time_off_pending, 1);
  // Asking for the same days again is refused; another person can't request for them.
  assert.equal((await worker('POST', '/time-off/request', { from: `${year}-03-02`, reason: 'Vacation' })).status, 400);
  assert.equal((await worker('POST', '/time-off/request', { from: `${year}-03-20` })).status, 400); // reason required
  assert.equal((await worker('POST', '/time-off/decide', { ids: [1], action: 'approve' })).status, 403);

  // Scheduled on one of the days -> that day can't be approved until moved.
  await boss('POST', '/assignments', { project_id: job, employee_ids: [eid], dates: [`${year}-03-02`], planned_hours: 8 });
  const reqs = (await boss('GET', '/requests')).body.time_off;
  assert.equal(reqs.length, 5);
  sent.length = 0;
  const d = (await boss('POST', '/time-off/decide', { ids: reqs.map((x) => x.id), action: 'approve' })).body;
  assert.equal(d.approved, 4);
  assert.match(d.conflicts[0], /scheduled on 99-001/);
  await flush();
  assert.equal(sent[0].to, 'worker@example.com');
  assert.match(sent[0].subject, /Time off approved/);

  b = (await worker('GET', `/my-schedule?year=${year}`)).body.pto;
  assert.equal(b.scheduled, 32); assert.equal(b.pending, 8); assert.equal(b.left, 48);
  // Approved days now block scheduling.
  const block = await boss('POST', '/assignments', { project_id: job, employee_ids: [eid], dates: [`${year}-03-03`] });
  assert.equal(block.status, 409);
  assert.match(block.body.conflicts[0].message, /is off \(Vacation\)/);
});

test('rejecting needs a reason; the employee can withdraw a pending day; non-counting reasons', async () => {
  const left = (await boss('GET', '/requests')).body.time_off;
  assert.equal(left.length, 1);
  assert.equal((await boss('POST', '/time-off/decide', { ids: [left[0].id], action: 'reject' })).status, 400);
  const r = (await boss('POST', '/time-off/decide', { ids: [left[0].id], action: 'reject', reason: 'Needed on 99-001 that day' })).body;
  assert.equal(r.rejected, 1);
  // A rejected day can be requested again.
  assert.equal((await worker('POST', '/time-off/request', { from: `${year}-03-02`, reason: 'Personal' })).status, 200);
  const mine = (await worker('GET', '/my-schedule')).body.time_off.find((t) => t.off_date === `${year}-03-02`);
  assert.equal(mine.status, 'pending');
  assert.equal((await worker('DELETE', `/time-off/${mine.id}`)).status, 200);
  // Can't delete approved time off yourself.
  const appr = (await worker('GET', '/my-schedule')).body.time_off.find((t) => t.status === 'approved');
  assert.equal((await worker('DELETE', `/time-off/${appr.id}`)).status, 403);
  // Jury duty (not in the counting reasons) doesn't use the balance.
  await boss('POST', '/time-off', { employee_id: eid, from: `${year}-04-05`, reason: 'Jury duty' });
  const b = (await boss('GET', `/employees/${eid}?year=${year}`)).body.pto;
  assert.equal(b.other, 8); assert.equal(b.left, 48);
  // Balance report for the manager.
  const all = (await boss('GET', `/pto?year=${year}`)).body;
  assert.equal(all.employees.find((e) => e.id === eid).left, 48);
  assert.ok(!all.employees.some((e) => e.id === pmEid)); // office PMs aren't listed
});

test('superintendent crew and trade requests email the manager', async () => {
  conn.prepare('UPDATE projects SET superintendent_employee_id = ? WHERE id = ?').run(eid, job);
  conn.prepare("UPDATE users SET employee_id = ? WHERE username = 'super'").run(eid);
  const sup = await login('super');
  sent.length = 0;
  assert.equal((await sup('POST', '/crew-requests', { project_id: job, trade: 'Laborer', quantity: 2, dates: [`${year}-05-03`], task: 'Clean up level 2' })).status, 200);
  await flush();
  assert.match(sent[0].subject, /Trade request: 2 × Laborer on 99-001/);
  assert.match(sent[0].text, /Clean up level 2/);
  // Manager turns off notifications -> no more emails.
  const me = conn.prepare("SELECT id FROM users WHERE username = 'boss'").get();
  conn.prepare('UPDATE users SET notify_requests = 0 WHERE id = ?').run(me.id);
  sent.length = 0;
  await sup('POST', '/crew-requests', { project_id: job, trade: 'Laborer', quantity: 1, dates: [`${year}-05-04`] });
  await flush();
  assert.equal(sent.length, 0);
  const st = (await boss('GET', '/notify/status')).body;
  assert.equal(st.configured, true); assert.deepEqual(st.recipients, []);
});

test('office staff: yearly balance, the Office Manager is emailed, the person hears back', async () => {
  const osid = (await boss('POST', '/office-staff', { first_name: 'Test', last_name: 'Estimator', email: 'estimator@example.com', department: 'Estimating' })).body.id;
  assert.equal((await boss('POST', '/users', { username: 'om', name: 'Office Mgr', password: 'password1', role: 'office_admin', email: 'om@example.com' })).status, 200);
  assert.equal((await boss('POST', '/users', { username: 'est', name: 'Test Estimator', password: 'password1', role: 'office', office_staff_id: osid })).status, 200);
  const om = await login('om'); const est = await login('est');
  await boss('PUT', '/settings', { office_pto_default_hours: 120 });
  assert.equal((await est('GET', `/time-off-requests/balance?year=${year}`)).body.allowance, 120);
  assert.equal((await est('PUT', `/office-pto/${osid}`, { year, hours: 999 })).status, 403);
  assert.equal((await om('PUT', `/office-pto/${osid}`, { year, hours: 160, note: 'Senior' })).body.allowance, 160);
  sent.length = 0;
  // Mon–Fri PTO week = 5 weekdays × 8 h
  const r = await est('POST', '/time-off-requests', { start_date: `${year}-06-07`, end_date: `${year}-06-13`, type: 'pto', note: 'Lake week' });
  assert.equal(r.status, 200);
  await flush();
  assert.equal(sent[0].to, 'om@example.com'); // the Office Manager, not the Workforce Manager
  assert.match(sent[0].text, /Lake week/);
  assert.match(sent[0].text, /160 h left of 160 h/);
  let b = (await est('GET', `/time-off-requests/balance?year=${year}`)).body;
  const days = [7, 8, 9, 10, 11, 12, 13].filter((d) => ![0, 6].includes(new Date(Date.UTC(year, 5, d)).getUTCDay())).length;
  assert.equal(b.pending, days * 8);
  sent.length = 0;
  await om('POST', `/time-off-requests/${r.body.id}/decide`, { status: 'approved' });
  await flush();
  assert.equal(sent[0].to, 'estimator@example.com');
  assert.match(sent[0].subject, /Time off approved/);
  b = (await est('GET', `/time-off-requests/balance?year=${year}`)).body;
  assert.equal(b.scheduled, days * 8); assert.equal(b.left, 160 - days * 8);
  // Sick days don't count.
  const sick = (await est('POST', '/time-off-requests', { start_date: `${year}-07-01`, end_date: `${year}-07-01`, type: 'sick' })).body.id;
  await om('POST', `/time-off-requests/${sick}/decide`, { status: 'approved' });
  assert.equal((await est('GET', `/time-off-requests/balance?year=${year}`)).body.left, 160 - days * 8);
  const all = (await om('GET', `/office-pto?year=${year}`)).body;
  assert.equal(all.staff.find((x) => x.id === osid).allowance, 160);
});

test('upgrade from v7 keeps users and time off', () => {
  const old = new (require('node:sqlite').DatabaseSync)(':memory:');
  old.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','super','viewer')), can_view_payroll INTEGER NOT NULL DEFAULT 0,
      employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE time_off (id INTEGER PRIMARY KEY, employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE, off_date TEXT NOT NULL, reason TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, UNIQUE (employee_id, off_date));
    INSERT INTO employees VALUES (1, 'A', 'B');
    INSERT INTO users (username, name, password_hash, role, employee_id) VALUES ('old', 'Old', 'x', 'super', 1);
    INSERT INTO time_off (employee_id, off_date, reason, created_by) VALUES (1, '2026-12-24', 'Vacation', 1);
    PRAGMA user_version = 7;`);
  const file = require('node:path').join(require('node:os').tmpdir(), `wf-up8-${process.pid}.db`);
  old.exec(`VACUUM INTO '${file}'`); old.close();
  const up = db.open(file);
  const u = up.prepare("SELECT * FROM users WHERE username = 'old'").get();
  assert.equal(u.role, 'super'); assert.equal(u.employee_id, 1); assert.equal(u.notify_requests, 1);
  assert.equal(up.prepare('SELECT status, created_by FROM time_off').get().status, 'approved');
  assert.equal(up.prepare('SELECT created_by FROM time_off').get().created_by, 1);
  assert.equal(up.prepare("SELECT can_view_schedule FROM users WHERE username = 'old'").get().can_view_schedule, 0);
  up.prepare("INSERT INTO users (username, name, password_hash, role, can_view_schedule) VALUES ('newpm', 'PM', 'x', 'office', 1)").run();
  up.close();
  require('node:fs').rmSync(file, { force: true });
});
