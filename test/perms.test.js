'use strict';
// Per-user permission grids (Procore style).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const perms = require('../server/perms');
const { createApp } = require('../server/app');

const conn = db.open(':memory:');
let server; let base;
before(async () => {
  const add = conn.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const [u, r] of [['boss', 'admin'], ['om', 'office_admin'], ['field', 'viewer'], ['clerk', 'office'], ['sup', 'super']]) add.run(u, u, auth.hashPassword('password1'), r);
  server = createApp(conn).listen(0);
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
const idOf = (u) => conn.prepare('SELECT id FROM users WHERE username = ?').get(u).id;

test('logins without a saved grid keep the access their role had', () => {
  assert.equal(perms.legacy({ role: 'admin' }).admin, 3);
  assert.deepEqual(perms.legacy({ role: 'viewer' }), { ...perms.legacy({ role: 'viewer' }), schedule: 1, timeoff: 1, admin: 0, est_schedule: 0 });
  const pm = perms.legacy({ role: 'office', employee_type: 'project_manager' });
  assert.equal(pm.schedule, 2); assert.equal(pm.projects, 3);
  const om = perms.legacy({ role: 'office_admin' });
  assert.equal(om.timeoff, 3); assert.equal(om.verify, 3); assert.equal(om.admin, 0);
  assert.equal(perms.normalize({ records: 3, admin: 2 }).records, 1); // levels a tool doesn't have are dropped
  assert.equal(perms.suggestTemplate({ role: 'office', employee_type: 'staff', department: 'Estimating' }), 'estimator');
});

test('the grid decides access: a field login given Read only on the bid board can view it but not change it', async () => {
  const boss = await login('boss');
  let f = await login('field');
  assert.equal((await f('GET', '/estimating/store/bids')).status, 403);
  const r = await boss('PUT', `/permissions/${idOf('field')}`, { template: 'field', perm: { ...perms.TEMPLATES.field.perm, est_schedule: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  f = await login('field');
  assert.equal((await f('GET', '/me')).body.user.perm.est_schedule, 1);
  assert.equal((await f('GET', '/estimating/store/bids')).status, 200);
  assert.equal((await f('PUT', '/estimating/store/bids/X-1', { project: 'Nope' })).status, 403);
  // Taking Schedule away hides the schedule.
  await boss('PUT', `/permissions/${idOf('field')}`, { perm: { ...perms.TEMPLATES.field.perm, schedule: 0 } });
  f = await login('field');
  assert.equal((await f('GET', '/schedule')).status, 403);
});

test('the Office Manager manages permissions but never Admin / Payroll, her own login or the Workforce Manager', async () => {
  const om = await login('om');
  const list = (await om('GET', '/permissions')).body;
  assert.deepEqual(list.locked, ['admin', 'payroll']);
  // She can make the clerk an estimator...
  const r = await om('PUT', `/permissions/${idOf('clerk')}`, { template: 'estimator', perm: { ...perms.TEMPLATES.estimator.perm, admin: 3, payroll: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.perm.est_gng, 2);
  assert.equal(r.body.perm.admin, 0); assert.equal(r.body.perm.payroll, 0); // locked rows unchanged
  // ...but not herself or the Workforce Manager.
  assert.equal((await om('PUT', `/permissions/${idOf('om')}`, { perm: { admin: 3 } })).status, 403);
  assert.equal((await om('PUT', `/permissions/${idOf('boss')}`, { perm: {} })).status, 403);
  // Field logins can't open permissions at all.
  assert.equal((await (await login('sup'))('GET', '/permissions')).status, 403);
});

test('templates can be edited, added and deleted; "update everyone" only touches logins still on the template', async () => {
  const boss = await login('boss');
  // Two logins on the Field template; one later changed by hand (becomes Custom).
  await boss('PUT', `/permissions/${idOf('field')}`, { template: 'field' });
  await boss('PUT', `/permissions/${idOf('sup')}`, { template: 'field' });
  await boss('PUT', `/permissions/${idOf('sup')}`, { perm: { ...perms.TEMPLATES.field.perm, verify: 2 }, template: null });
  let list = (await boss('GET', '/permissions')).body;
  assert.equal(list.templates.field.users, 1);
  // Give Field read-only Go / No-Go, applied to everyone using it.
  const r = await boss('PUT', '/permissions/templates/field', { label: 'Field', perm: { ...perms.TEMPLATES.field.perm, est_gng: 1 }, apply: 'all' });
  assert.equal(r.body.updated, 1);
  list = (await boss('GET', '/permissions')).body;
  assert.equal(list.users.find((u) => u.username === 'field').perm.est_gng, 1);
  assert.equal(list.users.find((u) => u.username === 'sup').perm.est_gng, 0); // Custom: left alone
  // A new template can be assigned to a login.
  const nt = await boss('POST', '/permissions/templates', { label: 'Senior Estimator', perm: { est_schedule: 3, est_gng: 3, est_history: 2, timeoff: 1 } });
  assert.equal(nt.body.key, 'senior_estimator');
  assert.equal((await boss('PUT', `/permissions/${idOf('clerk')}`, { template: 'senior_estimator' })).body.perm.est_gng, 3);
  // Deleting it keeps the clerk's access; they just show as Custom.
  assert.equal((await boss('DELETE', '/permissions/templates/senior_estimator')).status, 200);
  const clerk = (await boss('GET', '/permissions')).body.users.find((u) => u.username === 'clerk');
  assert.equal(clerk.template, null); assert.equal(clerk.perm.est_gng, 3);
  // The Office Manager can't raise Admin / Payroll in a template.
  const om = await login('om');
  await om('PUT', '/permissions/templates/field', { label: 'Field', perm: { ...perms.TEMPLATES.field.perm, admin: 3, payroll: 3 } });
  const f = (await boss('GET', '/permissions')).body.templates.field;
  assert.equal(f.perm.admin, 0); assert.equal(f.perm.payroll, 0);
});
