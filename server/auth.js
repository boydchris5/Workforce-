'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const COOKIE = 'wf_session';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expires);
  return token;
}

function cookieHeader(token, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_DAYS * 86400 : 0}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionMiddleware(db) {
  const find = db.prepare(`
    SELECT u.id, u.username, u.name, u.role, u.can_view_payroll, u.employee_id
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = null;
    if (token) {
      const u = find.get(token, new Date().toISOString());
      if (u) {
        req.user = { ...u, can_view_payroll: u.role === 'admin' || !!u.can_view_payroll };
        req.sessionToken = token;
      }
    }
    next();
  };
}

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in.' }));
const requireRole = (...roles) => (req, res, next) =>
  req.user && roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have access to this.' });
const requirePayroll = (req, res, next) =>
  req.user && req.user.can_view_payroll ? next() : res.status(403).json({ error: 'Payroll is restricted.' });

module.exports = {
  COOKIE, hashPassword, verifyPassword, createSession, cookieHeader,
  sessionMiddleware, requireAuth, requireRole, requirePayroll,
};
