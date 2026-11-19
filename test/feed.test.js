'use strict';
// Read-only time-off feed for outside dashboards: secret token, no login.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');

const TOKEN = 'test-feed-token-0123456789';
const conn = db.open(':memory:');
let server; let base; let off;

before(async () => {
  conn.prepare(`INSERT INTO users (username, name, password_hash, role) VALUES ('boss', 'Boss', ?, 'admin')`).run(auth.hashPassword('password1'));
  const add = conn.prepare("INSERT INTO employees (first_name, last_name, employee_type, department, active) VALUES (?, ?, 'staff', ?, ?)");
  const est = Number(add.run('Ann', 'Estimator', 'Estimating', 1).lastInsertRowid);
  const pre = Number(add.run('Pete', 'Precon', 'Pre-Con', 1).lastInsertRowid);
  const acct = Number(add.run('Al', 'Accounts', 'Accounting', 1).lastInsertRowid);
  const ins = conn.prepare("INSERT INTO time_off (employee_id, off_date, reason, hours, note, batch, status, reject_reason) VALUES (?, ?, ?, 8, ?, ?, ?, ?)");
  ins.run(est, '2030-06-03', 'Vacation', 'family trip', 'b1', 'approved', null);
  ins.run(est, '2030-06-04', 'Vacation', 'family trip', 'b1', 'approved', null);
  ins.run(pre, '2030-06-05', 'PTO', 'doctor', 'b2', 'pending', null);
  ins.run(pre, '2030-06-10', 'PTO', null, 'b3', 'rejected', 'busy week');
  ins.run(acct, '2030-06-03', 'PTO', null, 'b4', 'approved', null);
  off = createApp(conn, { feedToken: '' }).listen(0);
  server = createApp(conn, { feedToken: TOKEN }).listen(0);
  await Promise.all([new Promise((r) => server.once('listening', r)), new Promise((r) => off.once('listening', r))]);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); off.close(); });

test('needs the token; off when no token is set', async () => {
  assert.equal((await fetch(`${base}/feed/time-off`)).status, 401);
  assert.equal((await fetch(`${base}/feed/time-off?token=wrong`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/api/feed/time-off?token=x`)).status, 404);
  const r = await fetch(`${base}/feed/time-off?start=2030-06-01&end=2030-06-30`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  // Stray spaces / quotes around the token are forgiven.
  assert.equal((await fetch(`${base}/feed/time-off?token=%20%22${TOKEN}%22%20`)).status, 200);
});

test('approved and pending only, filtered by department, no notes or reasons', async () => {
  const r = await (await fetch(`${base}/feed/time-off?token=${TOKEN}&start=2030-06-01&end=2030-06-30&department=Estimating,pre-con`)).json();
  assert.deepEqual(r.requests.map((x) => [x.name, x.status, x.start_date, x.end_date, x.days]), [
    ['Ann Estimator', 'approved', '2030-06-03', '2030-06-04', 2],
    ['Pete Precon', 'pending', '2030-06-05', '2030-06-05', 1],
  ]);
  assert.equal(r.days.length, 3);
  const text = JSON.stringify(r);
  assert.ok(!/family trip|doctor|busy week|Accounts/.test(text));
  // No department filter: everyone active.
  const all = await (await fetch(`${base}/feed/time-off?token=${TOKEN}&start=2030-06-01&end=2030-06-30`)).json();
  assert.ok(all.requests.some((x) => x.department === 'Accounting'));
});

test('MCP connector: token in the path, read-only get_time_off tool', async () => {
  const rpc = (tok, body) => fetch(`${base}/mcp/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  assert.equal((await rpc('wrong-token-wrong-token', { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/api/mcp/x`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/mcp/${TOKEN}`)).status, 405);
  const init = await (await rpc(TOKEN, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  assert.equal((await rpc(TOKEN, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await (await rpc(TOKEN, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map((t) => t.name), ['get_time_off']);
  const call = await (await rpc(TOKEN, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_time_off', arguments: { start: '2030-06-01', end: '2030-06-30', department: 'Estimating,Pre-Con' } } })).json();
  assert.deepEqual(call.result.structuredContent.requests.map((x) => [x.name, x.status]), [['Ann Estimator', 'approved'], ['Pete Precon', 'pending']]);
  assert.ok(!/family trip|doctor|busy week|Accounts/.test(JSON.stringify(call)));
  const badCall = await (await rpc(TOKEN, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_time_off', arguments: { start: '2030-06-30', end: '2030-06-01' } } })).json();
  assert.equal(badCall.result.isError, true);
});
