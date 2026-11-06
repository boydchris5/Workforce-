'use strict';
// Email notifications (new crew / trade / time-off requests, time-off decisions).
// Sends through any SMTP account: Microsoft 365 (smtp.office365.com:587),
// SendGrid (smtp.sendgrid.net:587, user "apikey"), Gmail, etc.
// Without SMTP_HOST set, email is simply off and the app shows requests in-app only.
const nodemailer = require('nodemailer');

function createNotifier(env = process.env) {
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

module.exports = { createNotifier, renderEmail };
