'use strict';
// The superintendent hears back by email when their crew / trade request is answered.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');

const conn = db.open(':memory:');
const sent = [];
const notifier = { configured: true, from: 'workforce@example.com', send: async (m) => { sent.push(m); } };
let server; let base;
const flush = () => new Promise((r) => setTimeout(r, 450));

before(async () => {
  conn.prepare(`INSERT INTO users (username, name, password_hash, role, email) VALUES ('boss', 'Boss', ?, 'admin', 'boss@example.com')`).run(auth.hashPassword('password1'));
  server = createApp(conn, { notifier, crewNoticeDelayMs: 300 }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(username) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
}

test('approve, reject and fill: one email per superintendent; none for the manager\'s own entries', async () => {
  const boss = await login('boss');
  const emp = async (first, last, extra = {}) => (await boss('POST', '/employees', { first_name: first, last_name: last, trade: 'Carpenter', ...extra })).body.id;
  const sueE = await emp('Sue', 'Sample', { employee_type: 'superintendent', email: 'sue.home@example.com' });
  const a = await emp('Al', 'Alpha'); const b = await emp('Bo', 'Bravo'); const c = await emp('Cy', 'Charlie');
  assert.equal((await boss('POST', '/users', { username: 'sue', name: 'Sue Sample', role: 'super', employee_id: sueE, password: 'password1' })).status, 200); // no login email: uses the employee's
  const job = (await boss('POST', '/projects', { job_number: 'T-100', name: 'Test Job', superintendent_employee_id: sueE })).body.id;
  const sue = await login('sue');
  const days = ['2030-03-04', '2030-03-05', '2030-03-06'];

  // Sue requests Al and Bo for three days (pending), and 1 trade slot.
  await sue('POST', '/assignments', { project_id: job, employee_ids: [a, b], dates: days, planned_hours: 8 });
  const slot = (await sue('POST', '/crew-requests', { project_id: job, trade: 'Laborer', quantity: 1, dates: [days[0]] })).body.created[0];
  const pending = (await boss('GET', `/schedule?start=${days[0]}&days=7`)).body.assignments.filter((x) => x.approval_status === 'pending');
  assert.equal(pending.length, 6);
  sent.length = 0;
  await boss('POST', '/assignments/approve', { ids: pending.filter((x) => x.employee_id === a).map((x) => x.id) });
  await boss('POST', '/assignments/reject', { ids: pending.filter((x) => x.employee_id === b).map((x) => x.id), reason: 'Bo is needed elsewhere' });
  await boss('POST', `/crew-requests/${slot}/fill`, { employee_id: c });
  await flush();
  const toSue = sent.filter((m) => m.to === 'sue.home@example.com');
  assert.equal(toSue.length, 1, JSON.stringify(sent.map((m) => m.subject)));
  assert.match(toSue[0].subject, /T-100: 1 filled, 3 approved, 3 not approved/);
  assert.match(toSue[0].text, /Al Alpha \(Carpenter\) – 2030-03-04 to 2030-03-06 \(3 days\)/);
  assert.match(toSue[0].text, /Reason: Bo is needed elsewhere/);
  assert.match(toSue[0].text, /Filled:[\s\S]*Cy Charlie \(Laborer\)/);

  // The manager's own scheduling never emails anyone.
  sent.length = 0;
  await boss('POST', '/assignments', { project_id: job, employee_ids: [c], dates: ['2030-03-11'], planned_hours: 8 });
  await flush();
  assert.equal(sent.filter((m) => /Crew request update/.test(m.subject)).length, 0);
});
