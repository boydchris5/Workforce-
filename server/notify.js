'use strict';
// Email notifications (new crew / trade / time-off requests, time-off decisions).
// Two ways to send:
//  1. Microsoft 365 through Microsoft Graph (recommended): an Entra app registration with the
//     Mail.Send application permission, limited to one mailbox. Set MS_TENANT_ID, MS_CLIENT_ID,
//     MS_CLIENT_SECRET and MAIL_FROM (the mailbox, e.g. workforce@fager-mcgee.com). No passwords,
//     no SMTP ports (which Render's free plan blocks).
//  2. Any SMTP account (SendGrid, a mail host, ...): SMTP_HOST / PORT / USER / PASS.
// With neither set, email is off and the app shows requests in-app only.
const nodemailer = require('nodemailer');

// "Fager-McGee Workforce <workforce@fager-mcgee.com>" -> { name, address }
function parseAddress(s) {
  const m = String(s || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim() } : { name: '', address: String(s || '').trim() };
}

function graphNotifier(env, fetchImpl) {
  const from = parseAddress(env.MAIL_FROM);
  if (!from.address) throw new Error('MAIL_FROM must be set to the sending mailbox (e.g. workforce@fager-mcgee.com).');
  const base = (env.MS_GRAPH_URL || 'https://graph.microsoft.com').replace(/\/$/, '');
  const login = (env.MS_LOGIN_URL || 'https://login.microsoftonline.com').replace(/\/$/, '');
  let token = null; let expires = 0;
  async function getToken() {
    if (token && Date.now() < expires - 60_000) return token;
    const r = await fetchImpl(`${login}/${encodeURIComponent(env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: `${base}/.default`, grant_type: 'client_credentials' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`Microsoft sign-in failed: ${j.error_description || j.error || r.status}`.split('\r\n')[0]);
    token = j.access_token; expires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return token;
  }
  return {
    configured: true,
    method: 'Microsoft 365',
    from: env.MAIL_FROM,
    send: async ({ to, subject, text, html }) => {
      const recipients = (Array.isArray(to) ? to : String(to).split(',')).map((x) => x.trim()).filter(Boolean)
        .map((address) => ({ emailAddress: { address } }));
      const message = {
        subject,
        body: html ? { contentType: 'HTML', content: html } : { contentType: 'Text', content: text || '' },
        toRecipients: recipients,
        ...(from.name ? { from: { emailAddress: { address: from.address, name: from.name } } } : {}),
      };
      const r = await fetchImpl(`${base}/v1.0/users/${encodeURIComponent(from.address)}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, saveToSentItems: false }),
      });
      if (r.status !== 202 && !r.ok) {
        const j = await r.json().catch(() => ({}));
        const msg = j.error?.message || `HTTP ${r.status}`;
        if (r.status === 403) throw new Error(`Microsoft 365 refused to send as ${from.address} (${msg}). Check the app's Mail.Send permission and that it is allowed for this mailbox.`);
        throw new Error(`Microsoft 365 send failed: ${msg}`);
      }
      return { sent: true };
    },
  };
}

function createNotifier(env = process.env, fetchImpl = (...a) => fetch(...a)) {
  if (env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) return graphNotifier(env, fetchImpl);
  if (!env.SMTP_HOST) {
    return { configured: false, from: null, send: async () => ({ skipped: true }) };
  }
  const port = Number(env.SMTP_PORT) || 587;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465, // 587 upgrades with STARTTLS
    requireTLS: port !== 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const from = env.MAIL_FROM || env.SMTP_USER;
  return {
    configured: true,
    method: 'SMTP',
    from,
    send: ({ to, subject, text, html }) => transport.sendMail({ from, to, subject, text, html }),
  };
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A short, branded message: a heading, a few lines and a button back to the app.
function renderEmail({ heading, lines, link, linkText = 'Open the Workforce app', footer = 'You get these because you approve requests in the Workforce app. Turn them off under Admin → Users.' }) {
  const text = [heading, '', ...lines, '', link ? `${linkText}: ${link}` : ''].join('\n').trim();
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#2D2D2D;max-width:560px">
  <div style="border-top:4px solid #F15A22;padding:16px 0 4px"><b style="font-size:13px;letter-spacing:1px;color:#F15A22">FAGER-McGEE WORKFORCE</b></div>
  <h2 style="margin:8px 0 12px;font-size:18px">${escHtml(heading)}</h2>
  ${lines.map((l) => `<p style="margin:0 0 8px">${escHtml(l)}</p>`).join('')}
  ${link ? `<p style="margin:16px 0"><a href="${escHtml(link)}" style="background:#F15A22;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:bold">${escHtml(linkText)}</a></p>` : ''}
  <p style="font-size:11px;color:#888;margin-top:24px">${escHtml(footer)}</p>
</div>`;
  return { text, html };
}

module.exports = { createNotifier, renderEmail, parseAddress };
