'use strict';
// Estimating: the FM Bid Board's document store, who can reach it, the live team and time off,
// the import from the Claude bid board, and the Go / No-Go scorecard math.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');
const { scoreCard, DEFAULT_SCORECARD } = require('../server/estimating');

const conn = db.open(':memory:');
let server; let base; let root;

before(async () => {
  const add = conn.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const [u, n, r] of [['boss', 'Boss', 'admin'], ['est', 'Andrew Speraneo', 'office'], ['om', 'Office Manager', 'office_admin'], ['super', 'Super', 'super'], ['field', 'Field', 'viewer']]) add.run(u, n, auth.hashPassword('password1'), r);
  const emp = conn.prepare("INSERT INTO employees (first_name, last_name, employee_type, department, active) VALUES (?, ?, 'staff', ?, 1)");
  const a = Number(emp.run('Andrew', 'Speraneo', 'Estimating').lastInsertRowid);
  emp.run('Adam', 'Macfarlane', 'Pre-Con');
  const acct = Number(emp.run('Al', 'Accounts', 'Accounting').lastInsertRowid);
  const off = conn.prepare("INSERT INTO time_off (employee_id, off_date, reason, hours, status) VALUES (?, ?, 'PTO', ?, ?)");
  const soon = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  off.run(a, soon, 2, 'approved'); off.run(acct, soon, 8, 'approved');
  // A possible bid saved by the first Estimating screen (#43) before the board moved in.
  conn.exec(`CREATE TABLE IF NOT EXISTS est_bids (id INTEGER PRIMARY KEY, project TEXT NOT NULL, owner TEXT, architect TEXT, location TEXT, sector TEXT, delivery TEXT,
    est_value REAL, value_label TEXT, bid_date TEXT, bid_time TEXT, source TEXT, folder_key TEXT, folder_uri TEXT, notes TEXT, status TEXT NOT NULL DEFAULT 'Lead',
    scorecard TEXT, decision TEXT, decision_score INTEGER, decision_reason TEXT, decision_note TEXT, decided_by INTEGER, decided_at TEXT, created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));`);
  conn.prepare("INSERT INTO est_bids (project, est_value, scorecard) VALUES ('Old Lead', 900000, ?)").run(JSON.stringify({ ratings: { territory: 'good' } }));
  server = createApp(conn).listen(0);
  await new Promise((r) => server.once('listening', r));
  root = `http://127.0.0.1:${server.address().port}`;
  base = `${root}/api`;
});
after(() => server.close());

async function login(username) {
  const r = await fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'password1' }) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
}

const all = (r) => Object.fromEntries(DEFAULT_SCORECARD.questions.map((q) => [q.key, r]));

test('scorecard math: share of points, gates, cut-offs, reason from the biggest loss', () => {
  const cfg = DEFAULT_SCORECARD;
  assert.equal(scoreCard(cfg, all('good')).score, 100);
  assert.equal(scoreCard(cfg, all('ok')).suggestion, 'review');
  assert.equal(scoreCard(cfg, all('poor')).suggestion, 'no_go');
  const gated = scoreCard(cfg, { ...all('good'), territory: 'poor' });
  assert.equal(gated.suggestion, 'no_go'); assert.equal(gated.reason, 'Territory');
  assert.equal(scoreCard(cfg, { capacity: 'good' }).suggestion, null);
  assert.equal(scoreCard(cfg, { ...all('good'), risk: 'poor', capacity: 'ok' }).reason, 'Risk / terms (LDs, schedule)');
});

test('office logins only: field and superintendents are kept out', async () => {
  for (const u of ['super', 'field']) {
    const c = await login(u);
    assert.equal((await c('GET', '/estimating/store/bids')).status, 403);
    assert.equal((await c('PUT', '/estimating/store/bids/X', { project: 'X' })).status, 403);
    assert.equal((await c('GET', '/me')).body.user.can_estimate, false);
  }
  for (const u of ['boss', 'est', 'om']) {
    const c = await login(u);
    assert.equal((await c('GET', '/estimating/store/bids')).status, 200);
    assert.equal((await c('GET', '/me')).body.user.can_estimate, true);
  }
});

test('the board page is served and may be framed by the app (only by the app)', async () => {
  const r = await fetch(`${root}/estimating/board.html`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(await r.text(), /FM Bid Board/);
  for (const f of ['jspdf.umd.min.js', 'jspdf.plugin.autotable.min.js']) {
    const v = await fetch(`${root}/vendor/${f}`);
    assert.equal(v.status, 200); assert.match(v.headers.get('content-type'), /javascript/);
  }
  assert.equal((await fetch(`${root}/`)).headers.get('x-frame-options'), 'DENY');
});

test('document store: set, update, add, list, delete; unknown paths refused', async () => {
  const est = await login('est');
  assert.equal((await est('PUT', '/estimating/store/bids/261210-1', { project: 'Carbondale K-8 Roof', status: 'Lead', bid_date: '2026-12-10', team: [] })).status, 200);
  assert.equal((await est('PATCH', '/estimating/store/bids/261210-1', { scorecard: { ratings: all('good') }, team: ['Andrew Speraneo'] })).status, 200);
  const one = (await est('GET', '/estimating/store/bids/261210-1')).body;
  assert.equal(one.data.project, 'Carbondale K-8 Roof'); assert.deepEqual(one.data.team, ['Andrew Speraneo']); assert.equal(one.data.scorecard.ratings.odds, 'good');
  const ev = await est('POST', '/estimating/store/deadlines', { bid_id: '261210-1', kind: 'Pre-bid', date: '2026-12-01', attendees: [] });
  assert.equal(ev.status, 200); assert.ok(ev.body.id);
  assert.equal((await est('GET', '/estimating/store/deadlines')).body.length, 1);
  assert.equal((await est('PATCH', '/estimating/store/bids/NOPE', { a: 1 })).status, 404);
  assert.equal((await est('PUT', '/estimating/store/users/1', { a: 1 })).status, 404);
  assert.equal((await est('PUT', '/estimating/store/config/anything', { a: 1 })).status, 404);
  assert.equal((await est('PUT', '/estimating/store/bids/bad%20id', { a: 1 })).status, 400);
  assert.equal((await est('PUT', '/estimating/store/bids/X', [1, 2])).status, 400);
  assert.equal((await est('PUT', '/estimating/store/config/competitors', { names: ['Samron'] })).status, 200);
  assert.deepEqual((await est('GET', '/estimating/store/config/competitors')).body.data.names, ['Samron']);
  assert.equal((await est('GET', '/estimating/store/config/sync')).body.data, null);
  assert.equal((await est('DELETE', `/estimating/store/deadlines/${ev.body.id}`)).status, 200);
  assert.equal((await est('GET', '/estimating/store/deadlines')).body.length, 0);
});

test('team and time off come from the app: Estimating and Pre-Con only', async () => {
  const est = await login('est');
  const team = (await est('GET', '/estimating/store/config/team')).body.data.estimators.map((e) => e.name);
  assert.deepEqual(team.sort(), ['Adam Macfarlane', 'Andrew Speraneo']);
  const off = (await est('GET', '/estimating/store/timeoff/current')).body.data;
  assert.deepEqual(off.days.map((d) => [d.name, d.hours]), [['Andrew Speraneo', 2]]);
  // Writing time off from the board is ignored; it always comes from the app.
  assert.equal((await est('PUT', '/estimating/store/timeoff/current', { days: [] })).status, 200);
  assert.equal((await est('GET', '/estimating/store/timeoff/current')).body.data.days.length, 1);
});

test('possible bids from the first Estimating screen moved onto the board', async () => {
  const est = await login('est');
  const old = (await est('GET', '/estimating/store/bids')).body.find((d) => d.data.project === 'Old Lead');
  assert.ok(old); assert.equal(old.data.status, 'Lead'); assert.equal(old.data.scorecard.ratings.territory, 'good');
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM est_bids').get().n, 0);
});

test('admin imports the Claude bid board export; running it twice is safe', async () => {
  const est = await login('est'); const boss = await login('boss');
  const docs = { docs: [
    { coll: 'bids', id: '261117-1', data: { project: 'Carruthers Cafeteria', status: 'In progress', team: ['Andrew Speraneo'] } },
    { coll: 'deadlines', id: 'd1', data: { bid_id: '261117-1', kind: 'Pre-bid', date: '2026-11-05', attendees: ['Andrew Speraneo'] } },
    { coll: 'config', id: 'team', data: { estimators: [{ name: 'Andrew Speraneo' }, { name: 'Adam Macfarlane' }, { name: 'Chris Boyd' }] } },
    { coll: 'timeoff', id: 'current', data: { days: [] } },
  ] };
  assert.equal((await est('POST', '/estimating/import', docs)).status, 403);
  const r = await boss('POST', '/estimating/import', docs);
  assert.equal(r.status, 200); assert.deepEqual(r.body.imported, { bids: 1, deadlines: 1, config: 1 });
  assert.equal((await boss('POST', '/estimating/import', docs)).status, 200);
  assert.equal((await est('GET', '/estimating/store/bids')).body.filter((d) => d.id === '261117-1').length, 1);
  // Saved order wins (badge colours stay put); department members not on the list are added after.
  assert.deepEqual((await est('GET', '/estimating/store/config/team')).body.data.estimators.map((e) => e.name), ['Andrew Speraneo', 'Adam Macfarlane', 'Chris Boyd']);
  assert.equal((await boss('POST', '/estimating/import', { docs: [{ coll: 'users', id: '1', data: {} }] })).status, 404);
});

test('admin tunes scorecard weights and cut-offs', async () => {
  const boss = await login('boss'); const est = await login('est');
  assert.equal((await est('PUT', '/estimating/config', { weights: all(10), go_at: 80, review_at: 50 })).status, 403);
  assert.equal((await boss('PUT', '/estimating/config', { weights: all(10), go_at: 50, review_at: 60 })).status, 400);
  const r = await boss('PUT', '/estimating/config', { weights: { ...all(10), risk: 30 }, go_at: 80, review_at: 55 });
  assert.equal(r.status, 200); assert.equal(r.body.questions.find((q) => q.key === 'risk').weight, 30);
  assert.equal((await est('GET', '/estimating/config')).body.scorecard.go_at, 80);
});
