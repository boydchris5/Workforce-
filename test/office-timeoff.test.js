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

let boss; let field;
let alice; let bob; // office_staff ids
let aliceUser; let approverUser; // logged-in helpers
let reqId;

test('setup: admin creates office staff, an office login, and an office_admin login', async () => {
  boss = await login('boss'); field = await login('field');

  alice = (await boss('POST', '/office-staff', { first_name: 'Alice', last_name: 'Estimator', email: 'alice@fm.com', department: 'Estimating' })).body.id;
  bob = (await boss('POST', '/office-staff', { first_name: 'Bob', last_name: 'Accounting', email: 'bob@fm.com', department: 'Accounting' })).body.id;
  assert.ok(alice && bob);

  const roster = (await boss('GET', '/office-staff')).body;
  assert.equal(roster.length, 2);

  await boss('POST', '/users', { username: 'alice', name: 'Alice Estimator', role: 'office', office_staff_id: alice, password: 'password1' });
  await boss('POST', '/users', { username: 'approver', name: 'Office Manager', role: 'office_admin', password: 'password1' });

  // The admin's user list must carry office_staff_id -- it's how the UI shows
  // and edits the "Linked office staff" field on an office-role login.
  const users = (await boss('GET', '/users')).body;
  assert.equal(users.find((u) => u.username === 'alice').office_staff_id, alice);

  aliceUser = await login('alice');
  approverUser = await login('approver');

  // Field and random visitors can't see or touch the office roster
  assert.equal((await field('GET', '/office-staff')).status, 403);
  assert.equal((await fetch(`${base}/office-staff`)).status, 401);
});

test('office role requests their own time off; cannot act on someone else\'s', async () => {
  const bad1 = await aliceUser('POST', '/time-off-requests', { start_date: '2026-12-10', end_date: '2026-12-05', type: 'pto' });
  assert.equal(bad1.status, 400); // end before start

  const r = await aliceUser('POST', '/time-off-requests', { start_date: '2026-12-10', end_date: '2026-12-12', type: 'pto', note: 'Trip' });
  assert.equal(r.status, 200);
  reqId = r.body.id;

  const mine = (await aliceUser('GET', '/time-off-requests')).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'pending');
  assert.equal(mine[0].first_name, 'Alice');

  // Alice can't see or create for Bob
  const forBob = await aliceUser('POST', '/time-off-requests', { office_staff_id: bob, start_date: '2026-12-15', end_date: '2026-12-15' });
  assert.equal(forBob.status, 200); // office role ignores office_staff_id in body, uses their own link
  const stillMine = (await aliceUser('GET', '/time-off-requests')).body;
  assert.ok(stillMine.every((x) => x.first_name === 'Alice'));

  // Field staff have no access to this area at all
  assert.equal((await field('GET', '/time-off-requests')).status, 403);
  assert.equal((await field('POST', '/time-off-requests', { start_date: '2026-12-01', end_date: '2026-12-01' })).status, 403);
});

test('office_admin approves/denies; a decided request cannot be re-decided; requester can cancel', async () => {
  // Only office_admin/admin can decide
  assert.equal((await aliceUser('POST', `/time-off-requests/${reqId}/decide`, { status: 'approved' })).status, 403);

  const bad = await approverUser('POST', `/time-off-requests/${reqId}/decide`, { status: 'bogus' });
  assert.equal(bad.status, 400);

  const ok = await approverUser('POST', `/time-off-requests/${reqId}/decide`, { status: 'approved', decision_note: 'Enjoy the trip' });
  assert.equal(ok.status, 200);

  const again = await approverUser('POST', `/time-off-requests/${reqId}/decide`, { status: 'denied' });
  assert.equal(again.status, 400); // already decided

  const all = (await approverUser('GET', '/time-off-requests')).body;
  const mine = all.find((x) => x.id === reqId);
  assert.equal(mine.status, 'approved');
  assert.equal(mine.decision_note, 'Enjoy the trip');
  assert.equal(mine.decided_by_name, 'Office Manager');

  // The requester can still cancel an approved request
  const cancel = await aliceUser('POST', `/time-off-requests/${reqId}/cancel`, {});
  assert.equal(cancel.status, 200);
  const after2 = (await aliceUser('GET', '/time-off-requests')).body.find((x) => x.id === reqId);
  assert.equal(after2.status, 'cancelled');

  const cancelAgain = await aliceUser('POST', `/time-off-requests/${reqId}/cancel`, {});
  assert.equal(cancelAgain.status, 400); // already cancelled
});

test('office_admin manages the roster; admin sees everything too', async () => {
  const edited = await approverUser('PUT', `/office-staff/${bob}`, { first_name: 'Bob', last_name: 'Accounting', department: 'Finance', active: 1 });
  assert.equal(edited.status, 200);
  const roster = (await boss('GET', '/office-staff')).body;
  assert.equal(roster.find((x) => x.id === bob).department, 'Finance');

  // Status filter
  const pendingOnly = (await approverUser('GET', '/time-off-requests?status=pending')).body;
  assert.ok(pendingOnly.every((x) => x.status === 'pending'));

  // Admin can also create a request on someone's behalf
  const onBehalf = await boss('POST', '/time-off-requests', { office_staff_id: bob, start_date: '2026-12-20', end_date: '2026-12-20', type: 'sick' });
  assert.equal(onBehalf.status, 200);
});

test('the calendar view only ever shows approved time off, never pending/denied, and is open to field roles too', async () => {
  // Bob's on-behalf request from the previous test is still pending
  const decBefore = (await aliceUser('GET', '/time-off-requests/calendar?start=2026-12-01&end=2026-12-31')).body;
  assert.ok(!decBefore.some((x) => x.office_staff_id === bob));

  const all = (await boss('GET', '/time-off-requests?status=pending')).body;
  const bobReq = all.find((x) => x.office_staff_id === bob);
  await boss('POST', `/time-off-requests/${bobReq.id}/decide`, { status: 'approved' });

  const decAfter = (await aliceUser('GET', '/time-off-requests/calendar?start=2026-12-01&end=2026-12-31')).body;
  const bobEntry = decAfter.find((x) => x.office_staff_id === bob);
  assert.ok(bobEntry);
  assert.equal(bobEntry.first_name, 'Bob');
  assert.equal(bobEntry.start_date, '2026-12-20');
  // Minimal fields only -- no decision notes or requester identity leaked
  assert.equal(bobEntry.note, undefined);
  assert.equal(bobEntry.decision_note, undefined);

  // A range before everything is still out excludes it
  const earlier = (await aliceUser('GET', '/time-off-requests/calendar?start=2026-01-01&end=2026-01-31')).body;
  assert.ok(!earlier.some((x) => x.office_staff_id === bob));

  // Unlike the main /time-off-requests endpoint, the calendar is open to field
  // roles too -- the whole company can see who's out, not just office roles.
  assert.equal((await field('GET', '/time-off-requests/calendar?start=2026-12-01&end=2026-12-31')).status, 200);
  const fieldView = (await field('GET', '/time-off-requests/calendar?start=2026-12-01&end=2026-12-31')).body;
  assert.ok(fieldView.some((x) => x.office_staff_id === bob));
  // But field logins still can't see pending requests or act on any of this
  assert.equal((await field('GET', '/time-off-requests')).status, 403);
});
