'use strict';
// Estimating: possible bids, the Go / No-Go scorecard, the decision, and who can see it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../server/db');
const auth = require('../server/auth');
const { createApp } = require('../server/app');
const { scoreCard, DEFAULT_SCORECARD } = require('../server/estimating');

const conn = db.open(':memory:');
let server; let base;

before(async () => {
  const add = conn.prepare('INSERT INTO users (username, name, password_hash, role, can_estimate) VALUES (?, ?, ?, ?, ?)');
  add.run('boss', 'Boss', auth.hashPassword('password1'), 'admin', 0);
  add.run('est', 'Andrew Estimator', auth.hashPassword('password1'), 'office', 1);
  add.run('office', 'Office Person', auth.hashPassword('password1'), 'office', 0);
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

const all = (r) => Object.fromEntries(DEFAULT_SCORECARD.questions.map((q) => [q.key, r]));

test('scorecard math: share of points, gates, cut-offs, reason from the biggest loss', () => {
  const cfg = DEFAULT_SCORECARD;
  assert.equal(scoreCard(cfg, all('good')).score, 100);
  assert.equal(scoreCard(cfg, all('good')).suggestion, 'go');
  assert.equal(scoreCard(cfg, all('ok')).score, 50);
  assert.equal(scoreCard(cfg, all('ok')).suggestion, 'review');
  assert.equal(scoreCard(cfg, all('poor')).suggestion, 'no_go');
  // A gate rated Poor suggests No-Go even when everything else is Good.
  const gated = scoreCard(cfg, { ...all('good'), territory: 'poor' });
  assert.equal(gated.suggestion, 'no_go'); assert.equal(gated.gate, 'territory'); assert.equal(gated.reason, 'Territory');
  // No suggestion until every question is rated (unless a gate fails).
  const part = scoreCard(cfg, { capacity: 'good' });
  assert.equal(part.complete, false); assert.equal(part.suggestion, null); assert.equal(part.rated, 1);
  // Reason comes from the question that cost the most points (risk, 20 pts).
  assert.equal(scoreCard(cfg, { ...all('good'), risk: 'poor', capacity: 'ok' }).reason, 'Risk / terms (LDs, schedule)');
});

test('only admins and Estimating logins see it', async () => {
  const office = await login('office');
  assert.equal((await office('GET', '/estimating/bids')).status, 403);
  assert.equal((await office('POST', '/estimating/bids', { project: 'X' })).status, 403);
  const est = await login('est');
  assert.equal((await est('GET', '/estimating/config')).status, 200);
  assert.equal((await est('GET', '/me')).body.user.can_estimate, true);
  assert.equal((await est('PUT', '/estimating/config', { weights: {} })).status, 403);
});

test('possible bid -> scorecard -> Go puts it on the board; No-Go needs a reason; undo', async () => {
  const est = await login('est');
  assert.equal((await est('POST', '/estimating/bids', { owner: 'No name' })).status, 400);
  assert.equal((await est('POST', '/estimating/bids', { project: 'X', sector: 'Made up' })).status, 400);
  const a = await est('POST', '/estimating/bids', { project: 'Carbondale K-8 Roof', bid_date: '2026-12-15', sector: 'Public – K-12', est_value: '1800000', source: 'bids@ invite' });
  assert.equal(a.status, 200); assert.equal(a.body.status, 'Lead'); assert.equal(a.body.est_value, 1800000);
  const id = a.body.id;
  assert.equal((await est('PUT', `/estimating/bids/${id}/scorecard`, { ratings: { territory: 'great' } })).status, 400);
  const sc = await est('PUT', `/estimating/bids/${id}/scorecard`, { ratings: all('good') });
  assert.equal(sc.body.score.score, 100); assert.equal(sc.body.score.suggestion, 'go');
  assert.deepEqual((await est('GET', '/estimating/bids?view=leads')).body.map((b) => b.id), [id]);
  const go = await est('POST', `/estimating/bids/${id}/decision`, { decision: 'go', note: 'Good owner, open week' });
  assert.equal(go.body.status, 'Not started'); assert.equal(go.body.decision, 'go'); assert.equal(go.body.decision_score, 100);
  assert.equal(go.body.decided_by_name, 'Andrew Estimator');
  assert.equal((await est('GET', '/estimating/bids?view=leads')).body.length, 0);
  assert.equal((await est('GET', '/estimating/bids?view=go')).body.length, 1);

  const b = (await est('POST', '/estimating/bids', { project: 'Paducah Clinic' })).body;
  await est('PUT', `/estimating/bids/${b.id}/scorecard`, { ratings: { ...all('good'), territory: 'poor' } });
  // Reason defaults to the suggested one (the gate that failed).
  const ng = await est('POST', `/estimating/bids/${b.id}/decision`, { decision: 'no_go' });
  assert.equal(ng.body.status, 'Passed'); assert.equal(ng.body.decision_reason, 'Territory');
  assert.equal((await est('POST', `/estimating/bids/${b.id}/decision`, { decision: 'no_go', reason: 'Because' })).status, 400);
  const undo = await est('POST', `/estimating/bids/${b.id}/decision`, { decision: 'undecided' });
  assert.equal(undo.body.status, 'Lead'); assert.equal(undo.body.decision, null); assert.equal(undo.body.decided_by, null);
});

test('admin tunes weights and cut-offs; the score stays 0-100', async () => {
  const boss = await login('boss');
  assert.equal((await boss('PUT', '/estimating/config', { weights: all(10), go_at: 50, review_at: 60 })).status, 400);
  const r = await boss('PUT', '/estimating/config', { weights: { ...all(10), risk: 30 }, go_at: 80, review_at: 55 });
  assert.equal(r.status, 200); assert.equal(r.body.go_at, 80);
  assert.equal(r.body.questions.find((q) => q.key === 'risk').weight, 30);
  const b = (await boss('POST', '/estimating/bids', { project: 'Weighted' })).body;
  const s = (await boss('PUT', `/estimating/bids/${b.id}/scorecard`, { ratings: { ...all('good'), risk: 'poor' } })).body.score;
  assert.equal(s.score, 63); // 50 of 80 points
  assert.equal(s.suggestion, 'review');
  assert.equal((await boss('DELETE', `/estimating/bids/${b.id}`)).status, 200);
});

test('Estimating access is a per-login switch in Admin -> Users', async () => {
  const boss = await login('boss');
  const users = (await boss('GET', '/users')).body;
  const office = users.find((u) => u.username === 'office');
  assert.equal(office.can_estimate, 0);
  const put = await boss('PUT', `/users/${office.id}`, { ...office, can_estimate: true });
  assert.equal(put.status, 200);
  const o = await login('office');
  assert.equal((await o('GET', '/estimating/bids')).status, 200);
});
