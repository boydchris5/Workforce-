'use strict';
// Email through Microsoft 365 (Graph), against a simulated Microsoft API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, parseAddress } = require('../server/notify');

const env = { MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 'not-a-real-secret', MAIL_FROM: 'Example Workforce <workforce@example.com>' };

function fakeMicrosoft({ sendStatus = 202 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
    if (sendStatus === 202) return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }), { status: sendStatus });
  };
  return { calls, fetchImpl };
}

test('parses "Name <address>"', () => {
  assert.deepEqual(parseAddress('Example Workforce <workforce@example.com>'), { name: 'Example Workforce', address: 'workforce@example.com' });
  assert.deepEqual(parseAddress('workforce@example.com'), { name: '', address: 'workforce@example.com' });
});

test('Microsoft 365: signs in with the app, sends from the mailbox, reuses the token', async () => {
  const ms = fakeMicrosoft();
  const n = createNotifier(env, ms.fetchImpl);
  assert.equal(n.configured, true); assert.equal(n.method, 'Microsoft 365');
  await n.send({ to: 'a@example.com, b@example.com', subject: 'Hi', text: 'x', html: '<p>x</p>' });
  await n.send({ to: 'a@example.com', subject: 'Again', text: 'y', html: '<p>y</p>' });
  const tokenCalls = ms.calls.filter((c) => c.url.includes('/token'));
  assert.equal(tokenCalls.length, 1, 'token cached');
  const form = new URLSearchParams(tokenCalls[0].opts.body.toString());
  assert.equal(form.get('grant_type'), 'client_credentials'); assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default');
  assert.match(tokenCalls[0].url, /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token$/);
  const send = ms.calls.find((c) => c.url.includes('/sendMail'));
  assert.equal(send.url, 'https://graph.microsoft.com/v1.0/users/workforce%40example.com/sendMail');
  assert.equal(send.opts.headers.Authorization, 'Bearer tok-1');
  const body = JSON.parse(send.opts.body);
  assert.deepEqual(body.message.toRecipients.map((r) => r.emailAddress.address), ['a@example.com', 'b@example.com']);
  assert.equal(body.message.body.contentType, 'HTML'); assert.equal(body.saveToSentItems, false);
});

test('Microsoft 365: a refused mailbox gives a clear error', async () => {
  const ms = fakeMicrosoft({ sendStatus: 403 });
  const n = createNotifier(env, ms.fetchImpl);
  await assert.rejects(n.send({ to: 'a@example.com', subject: 'Hi', text: 'x' }), /refused to send as workforce@example.com/);
});

test('no settings: email is off', () => {
  assert.equal(createNotifier({}).configured, false);
});
