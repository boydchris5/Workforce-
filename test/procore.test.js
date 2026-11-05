'use strict';
// Covers the bug hit in production: a company with many projects tripped
// Procore's rate limit (HTTP 429) and the sync failed outright. This checks
// that server/procore.js backs off and retries instead of throwing.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.PROCORE_CLIENT_ID = 'test-id';
process.env.PROCORE_CLIENT_SECRET = 'test-secret';
process.env.PROCORE_COMPANY_ID = '999';

const procore = require('../server/procore');

const origFetch = global.fetch;
after(() => { global.fetch = origFetch; });

test('retries after a 429, honoring Retry-After, then succeeds', async () => {
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    if (u.includes('/projects') && calls === 2) {
      return new Response('{"message":"You have surpassed the max number of requests for your rate limit."}', {
        status: 429,
        headers: { 'Retry-After': '0.01' },
      });
    }
    return new Response(JSON.stringify([{ id: 1, name: 'Test Project', project_number: '1', active: true }]), { status: 200 });
  };
  const projects = await procore.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Test Project');
  assert.ok(calls >= 3, `expected a token call, a 429, and a retry; got ${calls} calls`);
});

test('gives up after repeated 429s instead of retrying forever', async () => {
  let calls = 0;
  global.fetch = async (url) => {
    calls += 1;
    const u = String(url);
    if (u.includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{"message":"rate limited"}', { status: 429, headers: { 'Retry-After': '0.01' } });
  };
  await assert.rejects(() => procore.listProjects(), /HTTP 429/);
  assert.ok(calls <= 10, `expected a bounded number of retries, got ${calls} calls`);
});
