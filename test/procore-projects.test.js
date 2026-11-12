'use strict';
// Project sync from Procore, against a simulated Procore API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PROCORE_CLIENT_ID = 'test-id';
process.env.PROCORE_CLIENT_SECRET = 'test-secret';
process.env.PROCORE_COMPANY_ID = '999';

const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');

const conn = db.open(':memory:');
let server; let base;
const origFetch = global.fetch;
let rolesAllowed = true;

const PROCORE_PROJECTS = [
  { id: 1, project_number: '4440', name: 'Plant Expansion', address: '1 Main St', city: 'Du Quoin', state_code: 'IL', zip: '62832', active: true, project_stage: { name: 'Course of Construction' }, start_date: '2026-03-01', completion_date: '2027-06-30' },
  { id: 2, project_number: '4501', name: 'New Clinic', address: '9 Oak Ave', city: 'Carbondale', state_code: 'IL', zip: '62901', active: true, project_stage: { name: 'Course of Construction' }, start_date: null, completion_date: null },
  { id: 3, project_number: '4600', name: 'Future School', active: true, project_stage: { name: 'Bidding' } },
  { id: 4, project_number: '4610', name: 'Maybe Warehouse', active: true, project_stage: { name: 'Pre-Construction' } },
  { id: 5, project_number: '3900', name: 'Old Bank', active: false, project_stage: { name: 'Closeout' } },
  { id: 6, project_number: null, name: 'No Number', active: true, project_stage: { name: 'Course of Construction' } },
  { id: 7, project_number: '4700', name: 'Same Already', active: true, project_stage: { name: 'Warranty' } },
];
const ROLES = {
  1: [{ role: 'Project Manager', name: 'Pat Manager', is_active: true }, { role: 'Superintendent', name: 'Sue Super', is_active: true }],
  2: [{ role: 'Project Manager', name: 'Unknown Person', is_active: true }],
  7: [],
};

before(async () => {
  conn.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES ('boss', 'Boss', ?, 'admin'), ('sup', 'Sup', ?, 'super')`).run(auth.hashPassword('password1'), auth.hashPassword('password1'));
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('127.0.0.1')) return origFetch(url, opts);
    if (u.includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    const parsed = new URL(u);
    if (parsed.pathname.endsWith('/project_roles')) {
      if (!rolesAllowed) return new Response('{"errors":"forbidden"}', { status: 403 });
      return new Response(JSON.stringify(Number(parsed.searchParams.get('page') || 1) > 1 ? [] : ROLES[parsed.searchParams.get('project_id')] || []), { status: 200 });
    }
    if (parsed.pathname.endsWith('/projects')) return new Response(JSON.stringify(Number(parsed.searchParams.get('page') || 1) > 1 ? [] : PROCORE_PROJECTS), { status: 200 });
    return new Response('[]', { status: 200 });
  };
  server = createApp(conn).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); global.fetch = origFetch; });

async function login(username) {
  const r = await origFetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await origFetch(base + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
}

test('preview, then apply: Procore wins, blanks never erase, bidding/pre-con skipped', async () => {
  const boss = await login('boss'); const sup = await login('sup');
  const pm = (await boss('POST', '/employees', { first_name: 'Pat', last_name: 'Manager', classification: 'Project Manager' })).body.id;
  const su = (await boss('POST', '/employees', { first_name: 'Sue', last_name: 'Super', classification: 'Superintendent' })).body.id;
  // Existing app projects: 4440 has an old name and app-only budget hours; 4501 has dates Procore lacks; 3900 is active; 4700 already matches.
  const p4440 = (await boss('POST', '/projects', { job_number: '4440', name: 'Old Name', budget_hours: 9414, starting_hours: 3275.5 })).body.id;
  (await boss('POST', '/projects', { job_number: '4501', name: 'New Clinic', address: '9 Oak Ave, Carbondale, IL 62901', start_date: '2026-01-05' }));
  (await boss('POST', '/projects', { job_number: '3900', name: 'Old Bank' }));
  (await boss('POST', '/projects', { job_number: '4700', name: 'Same Already', status: 'active' }));

  assert.equal((await sup('POST', '/projects/procore-sync', {})).status, 403);
  const prev = (await boss('POST', '/projects/procore-sync', {})).body;
  assert.equal(prev.committed, false);
  const by = Object.fromEntries(prev.results.filter((x) => x.job_number).map((x) => [x.job_number, x]));
  assert.equal(by['4440'].action, 'update');
  assert.deepEqual(by['4440'].changes.map((c) => c.field).sort(), ['Address', 'End date', 'Name', 'Project manager', 'Start date', 'Superintendent']);
  assert.equal(by['4501'].action, 'same'); // Procore's blank dates don't erase the app's start date
  assert.match(by['4501'].reason, /Unknown Person.*isn't in Employees/);
  assert.equal(by['4600'].action, 'skip'); assert.match(by['4600'].reason, /Bidding/);
  assert.equal(by['4610'].action, 'skip');
  assert.equal(by['3900'].action, 'update'); assert.deepEqual(by['3900'].changes, [{ field: 'Status', from: 'active', to: 'complete' }]);
  assert.equal(by['4700'].action, 'same');
  assert.ok(prev.results.some((x) => x.action === 'skip' && /No project number/.test(x.reason)));
  // Nothing saved yet.
  assert.equal((await boss('GET', '/projects')).body.find((p) => p.id === p4440).name, 'Old Name');

  const done = (await boss('POST', '/projects/procore-sync', { commit: true })).body;
  assert.equal(done.committed, true);
  const projects = (await boss('GET', '/projects?all=1')).body;
  const p = projects.find((x) => x.id === p4440);
  assert.equal(p.name, 'Plant Expansion');
  assert.equal(p.address, '1 Main St, Du Quoin, IL 62832');
  assert.equal(p.project_manager_employee_id, pm); assert.equal(p.superintendent_employee_id, su);
  assert.equal(p.budget_hours, 9414); assert.equal(p.starting_hours, 3275.5); // app-only fields untouched
  assert.equal(projects.find((x) => x.job_number === '3900').status, 'complete');
  assert.equal(projects.find((x) => x.job_number === '4501').start_date, '2026-01-05');
  assert.ok(!projects.some((x) => x.job_number === '4600' || x.job_number === '4610'));
  // Running again finds nothing new to do.
  const again = (await boss('POST', '/projects/procore-sync', {})).body;
  assert.equal(again.summary.create + again.summary.update, 0);
});

test('new Procore projects are added; if roles can\'t be read, PM/super are left alone with a note', async () => {
  const boss = await login('boss');
  PROCORE_PROJECTS.push({ id: 8, project_number: '4800', name: 'Brand New Job', active: true, project_stage: { name: 'Course of Construction' }, start_date: '2026-12-01' });
  rolesAllowed = false;
  const prev = (await boss('POST', '/projects/procore-sync', {})).body;
  assert.match(prev.roles_unavailable, /project managers and superintendents were left as they are/);
  const add = prev.results.find((x) => x.job_number === '4800');
  assert.equal(add.action, 'create');
  await boss('POST', '/projects/procore-sync', { commit: true });
  const p = (await boss('GET', '/projects')).body.find((x) => x.job_number === '4800');
  assert.equal(p.name, 'Brand New Job'); assert.equal(p.status, 'active'); assert.equal(p.start_date, '2026-12-01');
  // Existing PM on 4440 kept even though roles couldn't be read.
  assert.ok((await boss('GET', '/projects')).body.find((x) => x.job_number === '4440').project_manager_employee_id);
});

test('Procore names with the company in parentheses and nicknames still match employees', async () => {
  const boss = await login('boss');
  rolesAllowed = true;
  const rob = (await boss('POST', '/employees', { first_name: 'Robert', last_name: 'Testerly', employee_type: 'superintendent' })).body.id;
  const mat = (await boss('POST', '/employees', { first_name: 'Matthew', last_name: 'Sampleton', employee_type: 'project_manager' })).body.id;
  PROCORE_PROJECTS.push({ id: 9, project_number: 'T555', name: 'Nickname Job', active: true, project_stage: { name: 'Course of Construction' } });
  ROLES[9] = [
    { role: 'Superintendent', name: 'Bobby Testerly (Example Builders, Inc.)', is_active: true },
    { role: 'Project Manager', name: 'Matt Sampleton (Example Builders, Inc.)', is_active: true },
  ];
  const prev = (await boss('POST', '/projects/procore-sync', {})).body;
  assert.ok(prev.procore_count >= 9);
  assert.ok(prev.procore_jobs.includes('T555'));
  const row = prev.results.find((x) => x.job_number === 'T555');
  assert.equal(row.action, 'create');
  assert.equal(row.reason, '');
  await boss('POST', '/projects/procore-sync', { commit: true });
  const p = (await boss('GET', '/projects')).body.find((x) => x.job_number === 'T555');
  assert.equal(p.superintendent_employee_id, rob);
  assert.equal(p.project_manager_employee_id, mat);
});
