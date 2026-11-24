'use strict';
const { permsFor } = require('./perms');
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
    SELECT u.id, u.username, u.name, u.role, u.can_view_payroll, u.employee_id, u.office_staff_id, u.can_view_schedule, u.can_estimate, u.permissions, u.perm_template, e.employee_type, e.department
    FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN employees e ON e.id = u.employee_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`);
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    req.user = null;
    if (token) {
      const u = find.get(token, new Date().toISOString());
      if (u) {
        // A login linked to a Project Manager employee requests crew on their own jobs, like a superintendent.
        const isPm = u.role !== 'admin' && u.employee_type === 'project_manager';
        // Per-tool permission grid (saved, or worked out from the role for logins not yet edited).
        const perm = permsFor(u);
        const { permissions: _p, ...rest } = u;
        req.user = { ...rest, perm, is_pm: isPm,
          can_view_payroll: perm.payroll >= 1, can_schedule: perm.schedule >= 2, can_view_schedule: perm.schedule >= 1 ? 1 : 0,
          can_estimate: perm.est_schedule >= 1 || perm.est_gng >= 1 || perm.est_history >= 1 };
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
