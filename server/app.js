'use strict';
const path = require('node:path');
const express = require('express');
const { tx, getSettings } = require('./db');
const auth = require('./auth');
const { isDate, addDays, weekStart, periodStart, weekDates, daysBetween } = require('./dates');
const { costAssignments, rateLookup, sumInto, round2 } = require('./payroll');
const procore = require('./procore');
const { createNotifier, renderEmail } = require('./notify');
const { holidaysForYear, holidayMap } = require('./holidays');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (msg, extra) => new HttpError(400, msg, extra);

// ---- input helpers ---------------------------------------------------------
const str = (v, max = 500) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
const num = (v) => (v === undefined || v === null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);
const int = (v) => { const n = num(v); return n === null || Number.isNaN(n) ? null : Math.trunc(n); };
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
function date(v, field, required = false) {
  if (v === undefined || v === null || v === '') { if (required) throw bad(`${field} is required.`); return null; }
  if (!isDate(v)) throw bad(`${field} must be a date (YYYY-MM-DD).`);
  return v;
}
function hours(v, field = 'Hours') {
  const n = num(v);
  if (n === null) return null;
  if (Number.isNaN(n) || n < 0 || n > 24) throw bad(`${field} must be between 0 and 24.`);
  return n;
}

function toCsv(rows, cols) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(r[c.key])).join(','))].join('\r\n');
}

function createApp(db, opts = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(auth.sessionMiddleware(db));

  const audit = (req, action, entity, entityId, details) =>
    db.prepare('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)')
      .run(req.user ? req.user.id : null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null);

  const api = express.Router();
  const canSchedule = auth.requireRole('admin', 'super');
  const adminOnly = auth.requireRole('admin');
  // The Office Manager adds and edits employees too (office staff live in the same list).
  const canEditPeople = auth.requireRole('admin', 'super', 'office_admin');
  // Everyone but the Workforce Manager and superintendents sees approved field work only
  // and can't edit it (field staff, and office logins allowed to view the schedule).
  const viewOnly = (req) => !['admin', 'super'].includes(req.user.role);
  const today = () => new Date().toISOString().slice(0, 10);

  // ---- email notifications -----------------------------------------------------
  const notifier = opts.notifier || createNotifier();
  const appUrl = (req, hash = '') => `${(process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/${hash}`;
  // Fire-and-forget: a mail problem never blocks or fails the request.
  function sendEmail(to, subject, body) {
    const list = [...new Set(to.filter(Boolean))];
    if (!notifier.configured || !list.length) return;
    const { text, html } = renderEmail(body);
    Promise.resolve().then(() => notifier.send({ to: list.join(', '), subject, text, html }))
      .catch((e) => console.error('Email failed:', e.message));
  }
  const managerEmails = db.prepare(`SELECT email FROM users WHERE role = 'admin' AND active = 1 AND notify_requests = 1
    AND email IS NOT NULL AND email <> ''`);
  function notifyManagers(req, subject, heading, lines, hash = '#/schedule') {
    sendEmail(managerEmails.all().map((r) => r.email), subject, { heading, lines, link: appUrl(req, hash), linkText: 'Review in the Workforce app' });
  }
  const shortDates = (dates) => {
    const d = [...dates].sort();
    return d.length === 1 ? d[0] : `${d[0]} to ${d[d.length - 1]} (${d.length} days)`;
  };

  api.get('/health', (_req, res) => res.json({ ok: true }));

  // ---- auth ------------------------------------------------------------------
  const loginAttempts = new Map();
  api.post('/login', (req, res) => {
    const username = str(req.body.username, 100);
    const password = String(req.body.password || '');
    const key = `${req.ip}|${(username || '').toLowerCase()}`;
    const a = loginAttempts.get(key) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const u = username && db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!u || !auth.verifyPassword(password, u.password_hash)) {
      a.n += 1;
      if (a.n >= 8) { a.until = Date.now() + 5 * 60e3; a.n = 0; }
      loginAttempts.set(key, a);
      throw new HttpError(401, 'Wrong username or password.');
    }
    loginAttempts.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    const token = auth.createSession(db, u.id);
    res.set('Set-Cookie', auth.cookieHeader(token, req.secure || opts.secureCookies));
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.set('Set-Cookie', auth.cookieHeader('', req.secure || opts.secureCookies));
    res.json({ ok: true });
  });

  api.use(auth.requireAuth);

  api.get('/me', (req, res) => {
    const s = getSettings(db);
    res.json({ user: req.user, settings: { company_name: s.company_name, default_hours: Number(s.default_hours), warn_daily_hours: Number(s.warn_daily_hours) || 8, max_daily_hours: Number(s.max_daily_hours) || 12 } });
  });

  api.post('/me/password', (req, res) => {
    const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!auth.verifyPassword(String(req.body.current || ''), u.password_hash)) throw bad('Current password is wrong.');
    const next = String(req.body.next || '');
    if (next.length < 8) throw bad('New password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // ---- skills ----------------------------------------------------------------
  api.get('/skills', (_req, res) => {
    res.json(db.prepare(`SELECT s.id, s.name, COUNT(es.employee_id) AS employee_count
      FROM skills s LEFT JOIN employee_skills es ON es.skill_id = s.id GROUP BY s.id ORDER BY s.name`).all());
  });
  api.post('/skills', canSchedule, (req, res) => {
    const name = str(req.body.name, 100);
    if (!name) throw bad('Skill name is required.');
    db.prepare('INSERT OR IGNORE INTO skills (name) VALUES (?)').run(name);
    res.json(db.prepare('SELECT * FROM skills WHERE name = ?').get(name));
  });
  api.delete('/skills/:id', adminOnly, (req, res) => {
    db.prepare('DELETE FROM skills WHERE id = ?').run(int(req.params.id));
    res.json({ ok: true });
  });

  // ---- employees -------------------------------------------------------------
  const employeeSkills = db.prepare(`SELECT s.id, s.name, es.expires_on FROM employee_skills es
    JOIN skills s ON s.id = es.skill_id WHERE es.employee_id = ? ORDER BY s.name`);

  function listEmployees(includeInactive) {
    const rows = db.prepare(`SELECT * FROM employees ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY last_name, first_name`).all();
    const skills = db.prepare(`SELECT es.employee_id, s.id, s.name, es.expires_on FROM employee_skills es JOIN skills s ON s.id = es.skill_id ORDER BY s.name`).all();
    const byEmp = new Map();
    for (const s of skills) {
      if (!byEmp.has(s.employee_id)) byEmp.set(s.employee_id, []);
      byEmp.get(s.employee_id).push({ id: s.id, name: s.name, expires_on: s.expires_on });
    }
    return rows.map((e) => ({ ...e, skills: byEmp.get(e.id) || [] }));
  }

  api.get('/employees', (req, res) => res.json(listEmployees(req.query.all === '1')));

  api.get('/employees/:id', (req, res) => {
    const e = db.prepare('SELECT * FROM employees WHERE id = ?').get(int(req.params.id));
    if (!e) throw new HttpError(404, 'Employee not found.');
    e.skills = employeeSkills.all(e.id);
    e.recent = db.prepare(`SELECT a.work_date, a.planned_hours, a.actual_hours, a.status, p.job_number, p.name AS project_name
      FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.employee_id = ? ORDER BY a.work_date DESC LIMIT 60`).all(e.id);
    e.time_off = db.prepare("SELECT id, off_date, reason, hours, status, reject_reason FROM time_off WHERE employee_id = ? AND off_date >= ? AND status <> 'rejected' ORDER BY off_date").all(e.id, addDays(today(), -30));
    if (!viewOnly(req) || req.user.role === 'office_admin' || req.user.employee_id === e.id) e.leave = leaveBalance(e.id, Number(req.query.year) || Number(today().slice(0, 4)));
    e.no_shows = db.prepare(`SELECT a.work_date, a.verify_note, p.job_number, p.name AS project_name, u.name AS verified_by_name
      FROM assignments a JOIN projects p ON p.id = a.project_id LEFT JOIN users u ON u.id = a.verified_by
      WHERE a.employee_id = ? AND a.status = 'no_show' ORDER BY a.work_date DESC LIMIT 50`).all(e.id);
    res.json(e);
  });

  // Employee type: union crew, superintendent (salaried, schedulable) or office staff (not on the field schedule).
  // Type drives who can be picked on projects, time-off rules and the field crew list.
  // Classification is for union classifications only (Journeyman, Foreman, Apprentice…).
  const EMPLOYEE_TYPES = ['union', 'general_foreman', 'superintendent', 'project_manager', 'staff'];
  const typeFromClassification = (c) => (/superintendent/i.test(c || '') ? 'superintendent' : /general foreman/i.test(c || '') ? 'general_foreman'
    : /project manager/i.test(c || '') ? 'project_manager' : 'union');
  function readEmployee(b) {
    const e = {
      employee_no: str(b.employee_no, 50), first_name: str(b.first_name, 100), last_name: str(b.last_name, 100),
      phone: str(b.phone, 50), email: str(b.email, 200), trade: str(b.trade, 100), union_local: str(b.union_local, 100),
      classification: str(b.classification, 100), hire_date: date(b.hire_date, 'Hire date'),
      active: b.active === undefined ? 1 : bool(b.active), notes: str(b.notes, 2000),
      employee_type: str(b.employee_type, 20) || typeFromClassification(b.classification), department: str(b.department, 100),
    };
    if (!e.first_name || !e.last_name) throw bad('First and last name are required.');
    if (!EMPLOYEE_TYPES.includes(e.employee_type)) throw bad('Pick a type: Union, General Foreman, Superintendent, Project Manager or Office staff.');
    return e;
  }

  function saveSkills(employeeId, skills) {
    if (!Array.isArray(skills)) return;
    db.prepare('DELETE FROM employee_skills WHERE employee_id = ?').run(employeeId);
    const findOrMake = db.prepare('INSERT OR IGNORE INTO skills (name) VALUES (?)');
    const getId = db.prepare('SELECT id FROM skills WHERE name = ?');
    const link = db.prepare('INSERT OR REPLACE INTO employee_skills (employee_id, skill_id, expires_on) VALUES (?, ?, ?)');
    for (const s of skills) {
      const name = str(typeof s === 'string' ? s : s.name, 100);
      if (!name) continue;
      findOrMake.run(name);
      link.run(employeeId, getId.get(name).id, typeof s === 'object' ? date(s.expires_on, 'Skill expiration') : null);
    }
  }

  api.post('/employees', canEditPeople, (req, res) => {
    const e = readEmployee(req.body);
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO employees (employee_no, first_name, last_name, phone, email, trade, union_local, classification, hire_date, active, notes, employee_type, department)
        VALUES (:employee_no, :first_name, :last_name, :phone, :email, :trade, :union_local, :classification, :hire_date, :active, :notes, :employee_type, :department)`).run(e);
      const id = Number(r.lastInsertRowid);
      saveSkills(id, req.body.skills);
      return id;
    });
    audit(req, 'create', 'employee', id, { name: `${e.first_name} ${e.last_name}` });
    res.json({ id });
  });

  api.put('/employees/:id', canEditPeople, (req, res) => {
    const id = int(req.params.id);
    const e = readEmployee(req.body);
    tx(db, () => {
      const r = db.prepare(`UPDATE employees SET employee_no=:employee_no, first_name=:first_name, last_name=:last_name, phone=:phone, email=:email,
        trade=:trade, union_local=:union_local, classification=:classification, hire_date=:hire_date, active=:active, notes=:notes,
        employee_type=:employee_type, department=:department WHERE id=:id`).run({ ...e, id });
      if (!r.changes) throw new HttpError(404, 'Employee not found.');
      saveSkills(id, req.body.skills);
    });
    audit(req, 'update', 'employee', id, { name: `${e.first_name} ${e.last_name}` });
    res.json({ id });
  });

  // ---- employee import (CSV rows parsed in the browser) ---------------------------
  // Rows are matched to existing employees by employee # (then by first + last
  // name), so re-importing an updated list updates people instead of duplicating
  // them. Blank cells never erase existing data. Rows whose trade or
  // classification is in `skip` (e.g. Clerical) are left out.
  const IMPORT_FIELDS = {
    employee_no: ['employeeno', 'employee', 'empno', 'employeenumber', 'empid', 'id'],
    first_name: ['firstname', 'first'],
    last_name: ['lastname', 'last'],
    phone: ['phone', 'cellphone', 'cell', 'mobile', 'phoneno'],
    email: ['email', 'emailaddress'],
    trade: ['trade', 'uniontrade', 'craft'],
    union_local: ['unionlocal', 'union', 'local', 'uniondescription'],
    classification: ['classification', 'class', 'tradedescription', 'position', 'title'],
    hire_date: ['hiredate', 'hired', 'startdate'],
    active: ['active', 'status'],
    skills: ['skills', 'certifications', 'certs', 'skillscertifications'],
    notes: ['notes', 'note', 'comments'],
  };
  const fieldFor = (() => {
    const m = new Map();
    for (const [f, aliases] of Object.entries(IMPORT_FIELDS)) for (const a of aliases) m.set(a, f);
    return (h) => m.get(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')) || null;
  })();
  function importDate(v) {
    const t = str(v, 20);
    if (!t) return null;
    if (isDate(t)) return t;
    const mdy = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (mdy) {
      const y = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
      const iso = `${y}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
      if (isDate(iso)) return iso;
    }
    throw new Error(`"${t}" is not a date (use M/D/YYYY or YYYY-MM-DD)`);
  }
  function importActive(v) {
    const t = String(v ?? '').trim().toLowerCase();
    if (!t) return null;
    if (['yes', 'y', 'true', '1', 'active', 'full'].includes(t)) return 1;
    if (['no', 'n', 'false', '0', 'inactive', 'terminated', 'laid off'].includes(t)) return 0;
    throw new Error(`"${v}" is not Yes/No for Active`);
  }

  api.post('/employees/import', adminOnly, (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw bad('The file has no rows.');
    if (rows.length > 5000) throw bad('Import at most 5,000 rows at a time.');
    const skip = (Array.isArray(req.body.skip) ? req.body.skip : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    const commit = req.body.commit === true;

    const byNo = db.prepare('SELECT * FROM employees WHERE employee_no = ? COLLATE NOCASE');
    const byName = db.prepare('SELECT * FROM employees WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE');
    const results = []; const seen = new Set();
    rows.forEach((raw, idx) => {
      const line = idx + 2; // header is line 1
      const r = {};
      for (const [k, v] of Object.entries(raw || {})) { const f = fieldFor(k); if (f && r[f] === undefined) r[f] = v; }
      try {
        const rec = {
          employee_no: str(r.employee_no, 50), first_name: str(r.first_name, 100), last_name: str(r.last_name, 100),
          phone: str(r.phone, 50), email: str(r.email, 200), trade: str(r.trade, 100), union_local: str(r.union_local, 100),
          classification: str(r.classification, 100), hire_date: importDate(r.hire_date), active: importActive(r.active),
          notes: str(r.notes, 2000),
          skills: String(r.skills ?? '').split(/[;|]/).map((x) => x.trim()).filter(Boolean).slice(0, 50),
        };
        const name = `${rec.first_name || ''} ${rec.last_name || ''}`.trim();
        if (skip.length && [rec.trade, rec.classification].some((v) => v && skip.includes(v.toLowerCase()))) {
          return results.push({ line, action: 'skip', name, reason: `${rec.classification || rec.trade} is excluded` });
        }
        if (!rec.first_name || !rec.last_name) throw new Error('First and last name are required');
        const key = (rec.employee_no || name).toLowerCase();
        if (seen.has(key)) throw new Error(`Duplicate of an earlier row (${rec.employee_no || name})`);
        seen.add(key);
        const existing = (rec.employee_no && byNo.get(rec.employee_no)) || byName.get(rec.first_name, rec.last_name);
        results.push({ line, action: existing ? 'update' : 'create', name, employee_no: rec.employee_no, existing_id: existing?.id, rec,
          classification: rec.classification, trade: rec.trade });
      } catch (e) {
        results.push({ line, action: 'error', name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), reason: e.message });
      }
    });

    const summary = { create: 0, update: 0, skip: 0, error: 0 };
    for (const x of results) summary[x.action] += 1;
    if (commit) {
      if (summary.error) throw bad(`Fix the ${summary.error} row(s) with errors first.`, { results: results.map(({ rec, ...x }) => x), summary });
      const cols = ['employee_no', 'first_name', 'last_name', 'phone', 'email', 'trade', 'union_local', 'classification', 'hire_date', 'notes'];
      const addSkill = db.prepare('INSERT OR IGNORE INTO skills (name) VALUES (?)');
      const skillId = db.prepare('SELECT id FROM skills WHERE name = ?');
      const link = db.prepare('INSERT OR IGNORE INTO employee_skills (employee_id, skill_id) VALUES (?, ?)');
      tx(db, () => {
        for (const x of results) {
          if (x.action !== 'create' && x.action !== 'update') continue;
          const rec = x.rec; let id = x.existing_id;
          if (x.action === 'create') {
            id = Number(db.prepare(`INSERT INTO employees (${cols.join(', ')}, active, employee_type) VALUES (${cols.map(() => '?').join(', ')}, ?, ?)`)
              .run(...cols.map((c) => rec[c]), rec.active ?? 1, typeFromClassification(rec.classification)).lastInsertRowid);
          } else {
            const sets = cols.filter((c) => rec[c] !== null);
            const vals = sets.map((c) => rec[c]);
            if (rec.active !== null) { sets.push('active'); vals.push(rec.active); }
            if (sets.length) db.prepare(`UPDATE employees SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
          }
          for (const sk of rec.skills) { addSkill.run(sk); link.run(id, skillId.get(sk).id); }
        }
      });
      audit(req, 'import', 'employee', null, summary);
    }
    res.json({ committed: commit, summary, results: results.map(({ rec, existing_id, ...x }) => x) });
  });

  api.delete('/employees/:id', adminOnly, (req, res) => {
    const id = int(req.params.id);
    const used = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE employee_id = ?').get(id).n;
    if (used) {
      // Keep history: deactivate instead of deleting.
      db.prepare('UPDATE employees SET active = 0 WHERE id = ?').run(id);
      audit(req, 'deactivate', 'employee', id);
      return res.json({ ok: true, deactivated: true });
    }
    db.prepare('DELETE FROM employees WHERE id = ?').run(id);
    audit(req, 'delete', 'employee', id);
    res.json({ ok: true });
  });

  // ---- projects --------------------------------------------------------------
  // Superintendent and project manager are employee records (picked by classification).
  const leadNames = `TRIM(se.first_name || ' ' || se.last_name) AS superintendent_name, TRIM(pm.first_name || ' ' || pm.last_name) AS project_manager_name`;
  const leadJoins = 'LEFT JOIN employees se ON se.id = p.superintendent_employee_id LEFT JOIN employees pm ON pm.id = p.project_manager_employee_id';

  // Hours to date = hours used before the job came into the app (starting_hours)
  // + approved scheduled/verified hours. Total budget = budget + change orders.
  const coHours = '(SELECT COALESCE(SUM(c.hours), 0) FROM project_change_orders c WHERE c.project_id = p.id)';

  api.get('/projects', (req, res) => {
    const where = req.query.all === '1' ? '' : "WHERE p.status IN ('planned','active','on_hold')";
    res.json(db.prepare(`SELECT p.*, ${leadNames}, ${coHours} AS co_hours,
        CASE WHEN p.budget_hours IS NULL AND ${coHours} = 0 THEN NULL ELSE COALESCE(p.budget_hours, 0) + ${coHours} END AS total_budget_hours,
        p.starting_hours + (SELECT COALESCE(SUM(CASE WHEN a.status='no_show' THEN 0 ELSE COALESCE(a.actual_hours, a.planned_hours) END),0) FROM assignments a WHERE a.project_id = p.id AND a.approval_status = 'approved') AS hours_to_date,
        (SELECT COALESCE(SUM(a.actual_hours),0) FROM assignments a WHERE a.project_id = p.id AND a.status <> 'scheduled' AND a.approval_status = 'approved') AS verified_hours
      FROM projects p ${leadJoins} ${where}
      ORDER BY p.job_number`).all());
  });

  function readProject(b) {
    const p = {
      job_number: str(b.job_number, 50), name: str(b.name, 200), customer: str(b.customer, 200), address: str(b.address, 300),
      superintendent_employee_id: int(b.superintendent_employee_id), project_manager_employee_id: int(b.project_manager_employee_id),
      status: str(b.status, 20) || 'active',
      start_date: date(b.start_date, 'Start date'), end_date: date(b.end_date, 'End date'),
      budget_hours: num(b.budget_hours), starting_hours: num(b.starting_hours) ?? 0, color: str(b.color, 20), notes: str(b.notes, 2000),
    };
    if (!p.job_number || !p.name) throw bad('Job number and project name are required.');
    if (!['planned', 'active', 'on_hold', 'complete'].includes(p.status)) throw bad('Invalid status.');
    if (Number.isNaN(p.budget_hours)) throw bad('Budget hours must be a number.');
    if (Number.isNaN(p.starting_hours) || p.starting_hours < 0) throw bad('Starting hours must be zero or more.');
    if (p.color && !/^#[0-9a-fA-F]{6}$/.test(p.color)) p.color = null;
    return p;
  }

  const uniqueMsg = (e, msg) => { if (/UNIQUE/.test(e.message)) throw bad(msg); throw e; };

  api.post('/projects', canSchedule, (req, res) => {
    const p = readProject(req.body);
    let r;
    try {
      r = db.prepare(`INSERT INTO projects (job_number, name, customer, address, superintendent_employee_id, project_manager_employee_id, status, start_date, end_date, budget_hours, starting_hours, color, notes)
        VALUES (:job_number, :name, :customer, :address, :superintendent_employee_id, :project_manager_employee_id, :status, :start_date, :end_date, :budget_hours, :starting_hours, :color, :notes)`).run(p);
    } catch (e) { uniqueMsg(e, 'That job number already exists.'); }
    const id = Number(r.lastInsertRowid);
    audit(req, 'create', 'project', id, { job_number: p.job_number });
    res.json({ id });
  });

  api.put('/projects/:id', canSchedule, (req, res) => {
    const id = int(req.params.id);
    const p = readProject(req.body);
    let r;
    try {
      r = db.prepare(`UPDATE projects SET job_number=:job_number, name=:name, customer=:customer, address=:address, superintendent_employee_id=:superintendent_employee_id, project_manager_employee_id=:project_manager_employee_id,
        status=:status, start_date=:start_date, end_date=:end_date, budget_hours=:budget_hours, starting_hours=:starting_hours, color=:color, notes=:notes WHERE id=:id`).run({ ...p, id });
    } catch (e) { uniqueMsg(e, 'That job number already exists.'); }
    if (!r.changes) throw new HttpError(404, 'Project not found.');
    audit(req, 'update', 'project', id, { job_number: p.job_number });
    res.json({ id });
  });

  api.delete('/projects/:id', adminOnly, (req, res) => {
    const id = int(req.params.id);
    const used = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE project_id = ?').get(id).n;
    if (used) throw bad('This project has schedule history. Mark it Complete instead of deleting it.');
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    audit(req, 'delete', 'project', id);
    res.json({ ok: true });
  });

  // ---- project import (CSV rows parsed in the browser) ------------------------------
  // Matched to existing projects by job number. Blank cells never erase data.
  // Superintendent / project manager are matched to employees by name.
  const PROJECT_FIELDS = {
    job_number: ['jobnumber', 'projectnumber', 'job', 'jobno', 'number', 'projectno'],
    name: ['projectname', 'name', 'project', 'jobname'],
    customer: ['customer', 'owner', 'client', 'gc', 'generalcontractor'],
    address: ['address', 'siteaddress', 'address1', 'street'],
    city: ['city'], state: ['state'], zip: ['zip', 'zipcode', 'postalcode'],
    status: ['status', 'stage', 'projectstatus'],
    start_date: ['startdate', 'start'], end_date: ['enddate', 'end', 'completiondate', 'finishdate'],
    budget_hours: ['budgethours', 'budget', 'totalhours', 'estimatedhours', 'contracthours', 'laborhours'],
    starting_hours: ['startinghours', 'hoursused', 'hourstodate', 'priorhours', 'usedhours'],
    change_order_hours: ['changeorderhours', 'cohours', 'changeorders'],
    superintendent: ['superintendent', 'super', 'foreman', 'superintendentforeman'],
    project_manager: ['projectmanager', 'pm', 'manager'],
    notes: ['notes', 'note', 'comments', 'type'],
  };
  const projectField = (() => {
    const m = new Map();
    for (const [f, aliases] of Object.entries(PROJECT_FIELDS)) for (const a of aliases) m.set(a, f);
    return (h) => m.get(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')) || null;
  })();
  function importStatus(v) {
    const t = String(v ?? '').trim().toLowerCase();
    if (!t) return null;
    // Check pre-construction before the general "construction" match.
    if (/pre-?\s?construction|planned|bidding|awarded|not started/.test(t)) return 'planned';
    if (/course of construction|^active$|in progress|construction|warranty/.test(t)) return 'active';
    if (/hold/.test(t)) return 'on_hold';
    if (/complete|closed|finished/.test(t)) return 'complete';
    throw new Error(`"${v}" is not a status (use Active, Planned, On hold or Complete)`);
  }
  function importHours(v, label) {
    const t = String(v ?? '').replace(/,/g, '').trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(`${label} "${v}" is not a number`);
    return n;
  }
  const employeeByName = (name) => {
    const t = str(name, 200);
    if (!t) return { id: null, missing: false };
    const [first, last] = t.includes(',') ? t.split(',').map((x) => x.trim()).reverse() : [t.split(/\s+/).slice(0, -1).join(' '), t.split(/\s+/).slice(-1)[0]];
    const e = db.prepare('SELECT id FROM employees WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE').get(first || '', last || '');
    return { id: e?.id ?? null, missing: !e };
  };

  api.post('/projects/import', adminOnly, (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) throw bad('The file has no rows.');
    if (rows.length > 2000) throw bad('Import at most 2,000 projects at a time.');
    const commit = req.body.commit === true;
    const byJob = db.prepare('SELECT * FROM projects WHERE job_number = ? COLLATE NOCASE');
    const results = []; const seen = new Set();
    rows.forEach((raw, idx) => {
      const line = idx + 2;
      const r = {};
      for (const [k, v] of Object.entries(raw || {})) { const f = projectField(k); if (f && r[f] === undefined) r[f] = v; }
      try {
        const street = str(r.address, 200);
        const cityLine = [str(r.city, 100), [str(r.state, 50), str(r.zip, 20)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
        const sup = employeeByName(r.superintendent); const pm = employeeByName(r.project_manager);
        const rec = {
          job_number: str(r.job_number, 50), name: str(r.name, 200), customer: str(r.customer, 200),
          address: [street, (street || str(r.city)) ? cityLine : ''].filter(Boolean).join(', ') || null,
          status: importStatus(r.status), start_date: importDate(r.start_date), end_date: importDate(r.end_date),
          budget_hours: importHours(r.budget_hours, 'Budget hours'), starting_hours: importHours(r.starting_hours, 'Starting hours'),
          change_order_hours: importHours(r.change_order_hours, 'Change order hours'),
          superintendent_employee_id: sup.id, project_manager_employee_id: pm.id, notes: str(r.notes, 2000),
        };
        if (!rec.job_number || !rec.name) throw new Error('Job number and project name are required');
        if (rec.starting_hours !== null && rec.starting_hours < 0) throw new Error('Starting hours must be zero or more');
        if (seen.has(rec.job_number.toLowerCase())) throw new Error(`Job number ${rec.job_number} appears more than once`);
        seen.add(rec.job_number.toLowerCase());
        const warn = [sup.missing && `Superintendent "${r.superintendent}" is not an employee – left blank`, pm.missing && `Project manager "${r.project_manager}" is not an employee – left blank`].filter(Boolean);
        const existing = byJob.get(rec.job_number);
        results.push({ line, action: existing ? 'update' : 'create', name: rec.name, job_number: rec.job_number, status: rec.status, existing_id: existing?.id, rec, reason: warn.join('; ') });
      } catch (e) {
        results.push({ line, action: 'error', name: str(r.name) || '', job_number: str(r.job_number) || '', reason: e.message });
      }
    });
    const summary = { create: 0, update: 0, skip: 0, error: 0 };
    for (const x of results) summary[x.action] += 1;
    if (commit) {
      if (summary.error) throw bad(`Fix the ${summary.error} row(s) with errors first.`, { results: results.map(({ rec, existing_id, ...x }) => x), summary });
      const cols = ['job_number', 'name', 'customer', 'address', 'status', 'start_date', 'end_date', 'budget_hours', 'starting_hours', 'superintendent_employee_id', 'project_manager_employee_id', 'notes'];
      const setCo = (pid, hours) => {
        // One "Imported" change order per project; re-importing replaces it.
        db.prepare("DELETE FROM project_change_orders WHERE project_id = ? AND co_number = 'IMPORT'").run(pid);
        if (hours) db.prepare("INSERT INTO project_change_orders (project_id, co_number, description, hours, created_by) VALUES (?, 'IMPORT', 'Change order hours from import', ?, ?)").run(pid, hours, req.user.id);
      };
      tx(db, () => {
        for (const x of results) {
          const rec = x.rec;
          if (x.action === 'create') {
            const vals = cols.map((c) => (c === 'status' ? rec.status || 'active' : c === 'starting_hours' ? rec.starting_hours ?? 0 : rec[c]));
            const id = Number(db.prepare(`INSERT INTO projects (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
            if (rec.change_order_hours !== null) setCo(id, rec.change_order_hours);
          } else if (x.action === 'update') {
            const sets = cols.filter((c) => rec[c] !== null);
            if (sets.length) db.prepare(`UPDATE projects SET ${sets.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((c) => rec[c]), x.existing_id);
            if (rec.change_order_hours !== null) setCo(x.existing_id, rec.change_order_hours);
          }
        }
      });
      audit(req, 'import', 'project', null, summary);
    }
    res.json({ committed: commit, summary, results: results.map(({ rec, existing_id, ...x }) => x) });
  });

  // ---- project sync from Procore -------------------------------------------------------
  // Pulls job information from Procore, matched by job number (Procore "Project Number").
  // Procore wins for the fields it provides; blank Procore fields never erase app data.
  // Budget hours, starting hours, change orders, color and notes stay app-only.
  // Bidding / Pre-Construction projects are skipped; inactive or closed-out projects are
  // only used to mark an existing app project Complete.
  api.post('/projects/procore-sync', adminOnly, async (req, res) => {
    if (!procore.configured()) throw bad('Procore is not set up on this server (PROCORE_CLIENT_ID / PROCORE_CLIENT_SECRET are not set in Render).');
    const commit = req.body.commit === true;
    const skipStage = (st) => /bidding|pre-?\s?construction/i.test(st || '');
    const closed = (p) => !p.active || /close ?out|post-?construction|complete|closed|archived/i.test(p.stage || '');
    let pulled;
    try {
      pulled = await procore.pullProjects({ wantRoles: (p) => p.active && !skipStage(p.stage) && !closed(p) && !!p.job_number });
    } catch (e) {
      throw new HttpError(502, `Could not reach Procore: ${e.message}`);
    }
    const byJob = db.prepare(`SELECT p.*, ${leadNames} FROM projects p ${leadJoins} WHERE p.job_number = ? COLLATE NOCASE`);
    const empName = (id) => { const e = id && db.prepare('SELECT first_name, last_name FROM employees WHERE id = ?').get(id); return e ? `${e.first_name} ${e.last_name}` : ''; };
    const LABEL = { name: 'Name', address: 'Address', status: 'Status', start_date: 'Start date', end_date: 'End date', project_manager_employee_id: 'Project manager', superintendent_employee_id: 'Superintendent' };
    const results = []; const seen = new Set();
    for (const p of pulled.projects) {
      const base = { job_number: p.job_number || '', name: p.name || '', stage: p.stage || (p.active ? 'Active' : 'Inactive') };
      if (!p.job_number) { results.push({ ...base, action: 'skip', reason: 'No project number in Procore' }); continue; }
      if (seen.has(p.job_number.toLowerCase())) { results.push({ ...base, action: 'skip', reason: 'Project number used twice in Procore' }); continue; }
      seen.add(p.job_number.toLowerCase());
      const existing = byJob.get(p.job_number);
      if (skipStage(p.stage)) { results.push({ ...base, action: 'skip', reason: `${p.stage} – skipped until awarded` }); continue; }
      if (closed(p)) {
        if (existing && existing.status !== 'complete') {
          results.push({ ...base, action: 'update', existing_id: existing.id, rec: { status: 'complete' }, changes: [{ field: 'Status', from: existing.status, to: 'complete' }] });
        } else results.push({ ...base, action: 'skip', reason: existing ? 'Closed in Procore – already Complete' : 'Inactive / closed in Procore' });
        continue;
      }
      let status = 'active';
      try { status = importStatus(p.stage) || 'active'; } catch { status = 'active'; }
      const cityLine = [p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      const address = [p.address, cityLine].filter(Boolean).join(', ') || null;
      const rec = { name: str(p.name, 200), address: str(address, 300), status, start_date: isDate(p.start_date) ? p.start_date : null, end_date: isDate(p.end_date) ? p.end_date : null };
      const warn = [];
      for (const [field, who, label] of [['project_manager_employee_id', p.project_manager, 'Project manager'], ['superintendent_employee_id', p.superintendent, 'Superintendent']]) {
        if (!who) continue;
        const m = employeeByName(who);
        if (m.id) rec[field] = m.id; else warn.push(`${label} "${who}" isn't in Employees – left as is`);
      }
      // Blank Procore values never erase app data.
      for (const k of Object.keys(rec)) if (rec[k] === null || rec[k] === undefined || rec[k] === '') delete rec[k];
      if (!existing) {
        if (!rec.name) { results.push({ ...base, action: 'skip', reason: 'No project name in Procore' }); continue; }
        results.push({ ...base, action: 'create', rec, changes: Object.entries(rec).map(([k, v]) => ({ field: LABEL[k], from: '', to: k.endsWith('_employee_id') ? empName(v) : v })), reason: warn.join('; ') });
        continue;
      }
      const changes = [];
      for (const [k, v] of Object.entries(rec)) {
        if (String(existing[k] ?? '') === String(v)) { delete rec[k]; continue; }
        changes.push({ field: LABEL[k], from: k.endsWith('_employee_id') ? empName(existing[k]) : existing[k] ?? '', to: k.endsWith('_employee_id') ? empName(v) : v });
      }
      results.push({ ...base, action: changes.length ? 'update' : 'same', existing_id: existing.id, rec, changes, reason: warn.join('; ') });
    }
    const summary = { create: 0, update: 0, same: 0, skip: 0 };
    for (const x of results) summary[x.action] += 1;
    if (commit) {
      tx(db, () => {
        for (const x of results) {
          if (x.action === 'create') {
            const cols = Object.keys(x.rec);
            db.prepare(`INSERT INTO projects (job_number, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(x.job_number, ...cols.map((c) => x.rec[c]));
          } else if (x.action === 'update') {
            const cols = Object.keys(x.rec);
            if (cols.length) db.prepare(`UPDATE projects SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => x.rec[c]), x.existing_id);
          }
        }
      });
      audit(req, 'procore_sync', 'project', null, { ...summary, changes: results.filter((x) => x.action === 'update' || x.action === 'create').map((x) => ({ job: x.job_number, changes: x.changes.map((c) => c.field) })) });
    }
    res.json({
      committed: commit, summary,
      roles_unavailable: pulled.rolesUnavailable ? 'Procore didn\'t allow reading project roles, so project managers and superintendents were left as they are. In the Procore Developer Portal, give the app read access to the project Directory.' : null,
      results: results.map(({ rec, existing_id, ...x }) => x),
    });
  });

  // ---- change orders ---------------------------------------------------------------
  api.get('/projects/:id/change-orders', (req, res) => {
    res.json(db.prepare(`SELECT c.*, u.name AS created_by_name FROM project_change_orders c LEFT JOIN users u ON u.id = c.created_by
      WHERE c.project_id = ? ORDER BY COALESCE(c.co_date, c.created_at), c.id`).all(int(req.params.id)));
  });
  api.post('/projects/:id/change-orders', canSchedule, (req, res) => {
    const pid = int(req.params.id);
    assertCanEdit(req, pid);
    const h = num(req.body.hours);
    if (h === null || Number.isNaN(h)) throw bad('Change order hours must be a number (use a negative number for a deduct).');
    const r = db.prepare('INSERT INTO project_change_orders (project_id, co_number, description, hours, co_date, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(pid, str(req.body.co_number, 50), str(req.body.description, 500), h, date(req.body.co_date, 'Date'), req.user.id);
    audit(req, 'create', 'change_order', pid, { co_number: str(req.body.co_number, 50), hours: h });
    res.json({ id: Number(r.lastInsertRowid) });
  });
  api.delete('/change-orders/:id', canSchedule, (req, res) => {
    const c = db.prepare('SELECT * FROM project_change_orders WHERE id = ?').get(int(req.params.id));
    if (!c) throw new HttpError(404, 'Change order not found.');
    assertCanEdit(req, c.project_id);
    db.prepare('DELETE FROM project_change_orders WHERE id = ?').run(c.id);
    audit(req, 'delete', 'change_order', c.project_id, { co_number: c.co_number, hours: c.hours });
    res.json({ ok: true });
  });

  // ---- weekly schedule ---------------------------------------------------------
  const assignmentSelect = `SELECT a.*, e.first_name, e.last_name, e.trade, e.classification,
      p.job_number, p.name AS project_name, p.color, p.superintendent_employee_id,
      cu.name AS requested_by_name, au.name AS approved_by_name
    FROM assignments a JOIN employees e ON e.id = a.employee_id JOIN projects p ON p.id = a.project_id
    LEFT JOIN users cu ON cu.id = a.created_by LEFT JOIN users au ON au.id = a.approved_by`;

  const slotSelect = `SELECT s.*, p.job_number, p.name AS project_name, p.color, p.superintendent_employee_id,
      cu.name AS requested_by_name, du.name AS decided_by_name
    FROM crew_request_slots s JOIN projects p ON p.id = s.project_id
    LEFT JOIN users cu ON cu.id = s.created_by LEFT JOIN users du ON du.id = s.decided_by`;

  // Approval workflow: superintendents request crew on the projects they run
  // (pending); the workforce manager (admin) approves or rejects with a reason.
  // Admin-entered work is approved immediately. Rejected rows stay for the
  // record but never count as booked, scheduled, or paid.
  const projectRow = db.prepare('SELECT id, job_number, name, superintendent_employee_id FROM projects WHERE id = ?');
  function assertCanEdit(req, projectId) {
    if (req.user.role === 'admin') return;
    const p = projectRow.get(projectId);
    if (!p) throw bad('Project not found.');
    if (!req.user.employee_id) throw new HttpError(403, 'Your login is not linked to an employee record, so you have no projects to request crew for. Ask the workforce manager.');
    if (p.superintendent_employee_id !== req.user.employee_id) {
      throw new HttpError(403, `You can only request crew on your own projects. ${p.job_number} is run by another superintendent.`);
    }
  }
  const approvalFor = (req) => (req.user.role === 'admin'
    ? { approval_status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString() }
    : { approval_status: 'pending', approved_by: null, approved_at: null });

  api.get('/schedule', (req, res) => {
    const start = weekStart(date(req.query.start, 'start') || new Date().toISOString().slice(0, 10));
    const days = weekDates(start);
    const end = days[6];
    const approvedOnly = viewOnly(req);
    const assignments = db.prepare(`${assignmentSelect} WHERE a.work_date BETWEEN ? AND ? ${approvedOnly ? "AND a.approval_status = 'approved'" : ''}
      ORDER BY e.last_name, e.first_name, a.id`).all(start, end);
    const timeOff = db.prepare(`SELECT t.*, e.first_name, e.last_name FROM time_off t JOIN employees e ON e.id = t.employee_id
      WHERE t.off_date BETWEEN ? AND ? AND t.status = 'approved'`).all(start, end);
    const projectIds = new Set(assignments.map((a) => a.project_id));
    const projects = db.prepare(`SELECT p.*, ${leadNames},
        CASE WHEN p.budget_hours IS NULL AND ${coHours} = 0 THEN NULL ELSE COALESCE(p.budget_hours, 0) + ${coHours} END AS total_budget_hours,
        p.starting_hours + (SELECT COALESCE(SUM(CASE WHEN a.status='no_show' THEN 0 ELSE COALESCE(a.actual_hours, a.planned_hours) END),0) FROM assignments a WHERE a.project_id = p.id AND a.work_date <= ? AND a.approval_status = 'approved') AS hours_through_week
      FROM projects p ${leadJoins} ORDER BY p.job_number`).all(end)
      .filter((p) => projectIds.has(p.id) || ['active', 'planned'].includes(p.status));

    // Running totals
    const byProject = {}; const byDay = {}; const byEmployee = {};
    let totalHours = 0;
    const peopleByDay = {}; const personDay = {};
    for (const d of days) { byDay[d] = { headcount: 0, hours: 0 }; peopleByDay[d] = new Set(); }
    const approval = { pending: 0, rejected: 0, approved: 0 };
    for (const a of assignments) {
      approval[a.approval_status] = (approval[a.approval_status] || 0) + 1;
      if (a.approval_status === 'rejected') continue; // freed up; shown only so the super sees the reason
      const h = a.planned_hours;
      totalHours += h;
      const p = (byProject[a.project_id] ||= { hours: 0, people: new Set(), days: {} });
      p.hours += h; p.people.add(a.employee_id);
      const pd = (p.days[a.work_date] ||= { headcount: 0, hours: 0 });
      pd.headcount += 1; pd.hours += h;
      byDay[a.work_date].hours += h; peopleByDay[a.work_date].add(a.employee_id);
      byDay[a.work_date].headcount = peopleByDay[a.work_date].size;
      byEmployee[a.employee_id] = (byEmployee[a.employee_id] || 0) + h;
      const k = `${a.employee_id}|${a.work_date}`; personDay[k] = (personDay[k] || 0) + h;
    }
    for (const p of Object.values(byProject)) { p.headcount = p.people.size; delete p.people; }
    // People scheduled over the daily warning threshold (allowed, but flagged).
    const warnAt = Number(getSettings(db).warn_daily_hours) || 8;
    const overDay = Object.entries(personDay).filter(([, h]) => h > warnAt)
      .map(([k, h]) => { const [eid, d] = k.split('|'); return { employee_id: Number(eid), work_date: d, hours: h }; });

    // Trade requests not yet filled (and recent rejections, so supers see why).
    const slots = viewOnly(req) ? [] : db.prepare(`${slotSelect} WHERE s.work_date BETWEEN ? AND ? AND s.status IN ('open','rejected')
      ORDER BY s.work_date, s.trade, s.id`).all(start, end);
    res.json({
      start, end, days, projects, assignments, time_off: timeOff, slots, holidays: holidayMap(start, end),
      totals: { approval, open_slots: slots.filter((x) => x.status === 'open').length,
        time_off_pending: req.user.role === 'admin' ? db.prepare("SELECT COUNT(DISTINCT COALESCE(batch, id)) AS n FROM time_off WHERE status = 'pending'").get().n : 0, hours: totalHours, assignments: assignments.length - approval.rejected, people: Object.keys(byEmployee).length, by_project: byProject, by_day: byDay, by_employee: byEmployee, over_day: overDay, warn_daily_hours: warnAt },
    });
  });

  api.get('/my-schedule', (req, res) => {
    if (!req.user.employee_id) return res.json({ linked: false, assignments: [] });
    const from = weekStart(new Date().toISOString().slice(0, 10));
    res.json({
      linked: true,
      assignments: db.prepare(`${assignmentSelect} WHERE a.employee_id = ? AND a.work_date >= ? AND a.approval_status = 'approved' ORDER BY a.work_date, a.id LIMIT 60`).all(req.user.employee_id, addDays(from, -7)),
      time_off: db.prepare('SELECT * FROM time_off WHERE employee_id = ? AND off_date >= ? ORDER BY off_date').all(req.user.employee_id, addDays(from, -60)),
      leave: leaveBalance(req.user.employee_id, int(req.query.year) || Number(today().slice(0, 4))),
      reasons: REASONS[typeOf(empRow.get(req.user.employee_id))],
    });
  });

  // ---- assignments (double-booking protected) -------------------------------------
  const findBookings = db.prepare(`SELECT a.id, a.project_id, a.planned_hours, p.job_number, p.name AS project_name
    FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.employee_id = ? AND a.work_date = ? AND a.approval_status <> 'rejected' ORDER BY a.id`);
  const findOff = db.prepare("SELECT reason FROM time_off WHERE employee_id = ? AND off_date = ? AND status = 'approved'");
  const empName = db.prepare("SELECT first_name || ' ' || last_name AS name, active FROM employees WHERE id = ?");
  const dayHours = db.prepare("SELECT COALESCE(SUM(planned_hours), 0) AS h FROM assignments WHERE employee_id = ? AND work_date = ? AND approval_status <> 'rejected'");
  // A rejected row for the same person/job/day is replaced when they're requested again.
  const clearRejected = db.prepare("DELETE FROM assignments WHERE employee_id = ? AND project_id = ? AND work_date = ? AND approval_status = 'rejected'");

  // A person can split a day across jobs. It is a double booking when they are
  // off that day, already on the same job that day, or the day's total hours
  // would pass the hard daily limit.
  function conflictFor(employeeId, workDate, { projectId, hours = 0 }, ignoreId) {
    const off = findOff.get(employeeId, workDate);
    if (off) return { type: 'time_off', message: `is off${off.reason ? ` (${off.reason})` : ''}` };
    const others = findBookings.all(employeeId, workDate).filter((b) => b.id !== ignoreId);
    const same = others.find((b) => b.project_id === projectId);
    if (same) return { type: 'booked', message: `is already scheduled on ${same.job_number} – ${same.project_name}`, project_id: same.project_id };
    const cap = Number(getSettings(db).max_daily_hours) || 24;
    const total = others.reduce((sum, b) => sum + b.planned_hours, 0) + hours;
    if (others.length && total > cap) {
      return { type: 'over_cap', message: `would have ${total} hrs (daily limit ${cap}) – already on ${others.map((b) => `${b.job_number} (${b.planned_hours} h)`).join(', ')}` };
    }
    return null;
  }

  // Scheduling over the warning threshold (default 8 h/day) is allowed but reported.
  function overWarnings(pairs) {
    const warn = Number(getSettings(db).warn_daily_hours) || 8;
    const seen = new Set(); const out = [];
    for (const [eid, d] of pairs) {
      const key = `${eid}|${d}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const h = dayHours.get(eid, d).h;
      if (h > warn) out.push({ employee_id: eid, work_date: d, hours: h, message: `${empName.get(eid)?.name} is scheduled ${h} hrs on ${d} (over ${warn})` });
    }
    // Scheduling on a union holiday is allowed but called out.
    const days = [...new Set(pairs.map(([, d]) => d))].sort();
    if (days.length) {
      const hol = holidayMap(days[0], days[days.length - 1]);
      for (const d of days) if (hol[d]) out.push({ type: 'holiday', work_date: d, message: `${d} is ${hol[d]} (union holiday)` });
    }
    return out;
  }

  api.post('/assignments', canSchedule, (req, res) => {
    const b = req.body;
    const projectId = int(b.project_id);
    const project = projectRow.get(projectId);
    if (!project) throw bad('Pick a project.');
    assertCanEdit(req, projectId);
    const appr = approvalFor(req);
    const employeeIds = [...new Set((Array.isArray(b.employee_ids) ? b.employee_ids : [b.employee_id]).map(int).filter(Boolean))];
    const dates = [...new Set((Array.isArray(b.dates) ? b.dates : [b.work_date]))].map((d) => date(d, 'Date', true));
    if (!employeeIds.length) throw bad('Pick at least one employee.');
    if (!dates.length) throw bad('Pick at least one day.');
    if (employeeIds.length * dates.length > 1000) throw bad('Too many assignments in one request.');
    const settings = getSettings(db);
    const planned = hours(b.planned_hours) ?? Number(settings.default_hours);
    const task = str(b.task, 500);

    const created = []; const conflicts = [];
    const ins = db.prepare(`INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, task, created_by, approval_status, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const touched = [];
    tx(db, () => {
      for (const eid of employeeIds) {
        const emp = empName.get(eid);
        if (!emp) { conflicts.push({ employee_id: eid, message: 'Employee not found' }); continue; }
        for (const d of dates) {
          const c = conflictFor(eid, d, { projectId, hours: planned });
          if (c) { conflicts.push({ employee_id: eid, work_date: d, name: emp.name, ...c, message: `${emp.name} ${c.message} on ${d}` }); continue; }
          try {
            clearRejected.run(eid, projectId, d);
            const r = ins.run(eid, projectId, d, planned, task, req.user.id, appr.approval_status, appr.approved_by, appr.approved_at);
            created.push(Number(r.lastInsertRowid));
            touched.push([eid, d]);
          } catch (e) {
            if (/UNIQUE/.test(e.message)) conflicts.push({ employee_id: eid, work_date: d, name: emp.name, type: 'booked', message: `${emp.name} is already scheduled on ${project.job_number} on ${d}` });
            else throw e;
          }
        }
      }
    });
    if (created.length) audit(req, appr.approval_status === 'pending' ? 'request' : 'schedule', 'assignment', null, { project: project.job_number, count: created.length, dates });
    if (created.length && appr.approval_status === 'pending') {
      const names = [...new Set(touched.map(([eid]) => empName.get(eid)?.name))];
      notifyManagers(req, `Crew request: ${project.job_number} – ${req.user.name}`, `${req.user.name} requested crew on ${project.job_number} ${project.name}`, [
        `People: ${names.join(', ')}`, `Days: ${shortDates(new Set(touched.map(([, d]) => d)))}`, `Hours per day: ${planned}`, ...(task ? [`Notes: ${task}`] : []),
      ]);
    }
    res.status(created.length ? 200 : 409).json({ created, approval_status: appr.approval_status, conflicts, warnings: overWarnings(touched), error: created.length ? undefined : conflicts[0]?.message });
  });

  api.put('/assignments/:id', canSchedule, (req, res) => {
    const id = int(req.params.id);
    const cur = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Assignment not found.');
    const b = req.body;
    const next = {
      id,
      employee_id: b.employee_id !== undefined ? int(b.employee_id) : cur.employee_id,
      project_id: b.project_id !== undefined ? int(b.project_id) : cur.project_id,
      work_date: b.work_date !== undefined ? date(b.work_date, 'Date', true) : cur.work_date,
      planned_hours: b.planned_hours !== undefined ? hours(b.planned_hours) ?? cur.planned_hours : cur.planned_hours,
      task: b.task !== undefined ? str(b.task, 500) : cur.task,
    };
    if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(next.project_id)) throw bad('Project not found.');
    assertCanEdit(req, cur.project_id);
    if (next.project_id !== cur.project_id) assertCanEdit(req, next.project_id);
    // A superintendent's change (or resubmitting a rejection) goes back to the manager for approval.
    const changed = ['employee_id', 'project_id', 'work_date', 'planned_hours', 'task'].some((k) => next[k] !== cur[k]);
    const appr = req.user.role === 'admin'
      ? { approval_status: cur.approval_status === 'rejected' ? 'rejected' : 'approved', approved_by: cur.approved_by ?? req.user.id, approved_at: cur.approved_at ?? new Date().toISOString(), reject_reason: cur.reject_reason }
      : changed || cur.approval_status === 'rejected' ? { approval_status: 'pending', approved_by: null, approved_at: null, reject_reason: null }
        : { approval_status: cur.approval_status, approved_by: cur.approved_by, approved_at: cur.approved_at, reject_reason: cur.reject_reason };
    Object.assign(next, appr);
    const c = conflictFor(next.employee_id, next.work_date, { projectId: next.project_id, hours: next.planned_hours }, id);
    if (c) throw new HttpError(409, `${empName.get(next.employee_id)?.name || 'Employee'} ${c.message} on ${next.work_date}.`);
    try {
      if (next.approval_status !== 'rejected') clearRejected.run(next.employee_id, next.project_id, next.work_date);
      db.prepare(`UPDATE assignments SET employee_id=:employee_id, project_id=:project_id, work_date=:work_date, planned_hours=:planned_hours,
        task=:task, approval_status=:approval_status, approved_by=:approved_by, approved_at=:approved_at, reject_reason=:reject_reason,
        updated_at=datetime('now') WHERE id=:id`).run(next);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That person is already scheduled on that job that day.');
      throw e;
    }
    audit(req, 'update', 'assignment', id, { from: { project_id: cur.project_id, date: cur.work_date }, to: { project_id: next.project_id, date: next.work_date } });
    res.json({ id, approval_status: next.approval_status, warnings: overWarnings([[next.employee_id, next.work_date]]) });
  });

  api.delete('/assignments/:id', canSchedule, (req, res) => {
    const id = int(req.params.id);
    const cur = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Assignment not found.');
    assertCanEdit(req, cur.project_id);
    // If this person filled a trade request, the request goes back to open.
    db.prepare("UPDATE crew_request_slots SET status = 'open', assignment_id = NULL, decided_by = NULL, decided_at = NULL WHERE assignment_id = ?").run(id);
    db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
    audit(req, 'delete', 'assignment', id, { employee_id: cur.employee_id, project_id: cur.project_id, date: cur.work_date });
    res.json({ ok: true });
  });

  // Copy one week's schedule into another week (skips anyone who would be double booked).
  api.post('/assignments/copy-week', canSchedule, (req, res) => {
    const from = weekStart(date(req.body.from, 'From week', true));
    const to = weekStart(date(req.body.to, 'To week', true));
    if (from === to) throw bad('Pick a different target week.');
    const projectId = int(req.body.project_id);
    if (projectId) assertCanEdit(req, projectId);
    else if (req.user.role !== 'admin') throw bad('Pick one of your projects to copy.');
    const offset = daysBetween(from, to);
    const appr = approvalFor(req);
    const src = db.prepare(`SELECT * FROM assignments WHERE work_date BETWEEN ? AND ? AND approval_status <> 'rejected' ${projectId ? 'AND project_id = ?' : ''} ORDER BY work_date, id`)
      .all(...[from, addDays(from, 6), ...(projectId ? [projectId] : [])]);
    const created = []; const conflicts = [];
    const ins = db.prepare(`INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, task, created_by, approval_status, approved_by, approved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const touched = [];
    tx(db, () => {
      for (const a of src) {
        const d = addDays(a.work_date, offset);
        const c = conflictFor(a.employee_id, d, { projectId: a.project_id, hours: a.planned_hours });
        if (c) { conflicts.push({ employee_id: a.employee_id, work_date: d, message: `${empName.get(a.employee_id)?.name} ${c.message} on ${d}` }); continue; }
        if (!empName.get(a.employee_id)?.active) continue;
        clearRejected.run(a.employee_id, a.project_id, d);
        created.push(Number(ins.run(a.employee_id, a.project_id, d, a.planned_hours, a.task, req.user.id, appr.approval_status, appr.approved_by, appr.approved_at).lastInsertRowid));
        touched.push([a.employee_id, d]);
      }
    });
    audit(req, 'copy_week', 'assignment', null, { from, to, project_id: projectId, created: created.length });
    res.json({ created, approval_status: appr.approval_status, conflicts, warnings: overWarnings(touched) });
  });

  // ---- approvals -------------------------------------------------------------------
  // Pending requests (manager: all; superintendent: own projects) plus recent rejections.
  api.get('/requests', canSchedule, (req, res) => {
    const mine = req.user.role === 'admin' ? '' : 'AND p.superintendent_employee_id = ?';
    const args = req.user.role === 'admin' ? [] : [req.user.employee_id ?? -1];
    const since = addDays(new Date().toISOString().slice(0, 10), -14);
    res.json({
      pending: db.prepare(`${assignmentSelect} WHERE a.approval_status = 'pending' ${mine} ORDER BY a.work_date, p.job_number, e.last_name`).all(...args),
      rejected: db.prepare(`${assignmentSelect} WHERE a.approval_status = 'rejected' AND a.work_date >= ? ${mine} ORDER BY a.work_date, p.job_number`).all(since, ...args),
      open_slots: db.prepare(`${slotSelect} WHERE s.status = 'open' ${mine} ORDER BY s.work_date, p.job_number, s.trade, s.id`).all(...args),
      rejected_slots: db.prepare(`${slotSelect} WHERE s.status = 'rejected' AND s.work_date >= ? ${mine} ORDER BY s.work_date, p.job_number`).all(since, ...args),
      // Each pending day carries the person's balance for that year, so the manager can decide at a glance.
      time_off: req.user.role === 'admin' ? db.prepare(`${timeOffSelect} WHERE t.status = 'pending' ORDER BY t.off_date, e.last_name`).all()
        .map((r) => { const kb = leaveBalance(r.employee_id, Number(r.off_date.slice(0, 4)))?.kinds[reasonKind(r.reason)]; return { ...r, counts: !!kb, pto_left: kb ? kb.left : null }; }) : [],
    });
  });

  // ---- trade requests ("2 carpenters Tuesday"), filled with names by the manager ----
  api.post('/crew-requests', canSchedule, (req, res) => {
    const b = req.body;
    const projectId = int(b.project_id);
    if (!projectRow.get(projectId)) throw bad('Pick a project.');
    assertCanEdit(req, projectId);
    const trade = str(b.trade, 100);
    if (!trade) throw bad('Pick a trade (e.g. Carpenter, Laborer, Operator).');
    const qty = int(b.quantity) ?? 1;
    if (qty < 1 || qty > 30) throw bad('How many must be between 1 and 30.');
    const dates = [...new Set(Array.isArray(b.dates) ? b.dates : [b.work_date])].map((d) => date(d, 'Date', true));
    if (!dates.length) throw bad('Pick at least one day.');
    const planned = hours(b.planned_hours) ?? Number(getSettings(db).default_hours);
    const ins = db.prepare('INSERT INTO crew_request_slots (project_id, work_date, trade, planned_hours, task, created_by) VALUES (?, ?, ?, ?, ?, ?)');
    const created = tx(db, () => dates.flatMap((d) => Array.from({ length: qty }, () => Number(ins.run(projectId, d, trade, planned, str(b.task, 500), req.user.id).lastInsertRowid))));
    audit(req, 'request_trade', 'crew_request', null, { project_id: projectId, trade, quantity: qty, dates });
    const proj = projectRow.get(projectId);
    notifyManagers(req, `Trade request: ${qty} × ${trade} on ${proj.job_number} – ${req.user.name}`, `${req.user.name} needs ${qty} × ${trade} on ${proj.job_number} ${proj.name}`, [
      `Days: ${shortDates(dates)}`, `Hours per day: ${planned}`, ...(str(b.task, 500) ? [`Notes: ${str(b.task, 500)}`] : []), 'Fill in the names from Requests on the Schedule page.',
    ]);
    res.json({ created });
  });

  // Manager puts a named employee on a trade request: creates the (approved) schedule entry.
  api.post('/crew-requests/:id/fill', adminOnly, (req, res) => {
    const slot = db.prepare('SELECT * FROM crew_request_slots WHERE id = ?').get(int(req.params.id));
    if (!slot) throw new HttpError(404, 'Request not found.');
    if (slot.status !== 'open') throw bad('That request is no longer open.');
    const eid = int(req.body.employee_id);
    const emp = empName.get(eid);
    if (!emp) throw bad('Pick an employee.');
    const hrs = hours(req.body.planned_hours) ?? slot.planned_hours;
    const c = conflictFor(eid, slot.work_date, { projectId: slot.project_id, hours: hrs });
    if (c) throw new HttpError(409, `${emp.name} ${c.message} on ${slot.work_date}.`);
    const id = tx(db, () => {
      clearRejected.run(eid, slot.project_id, slot.work_date);
      const aid = Number(db.prepare(`INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, task, created_by, approval_status, approved_by, approved_at)
        VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'))`).run(eid, slot.project_id, slot.work_date, hrs, slot.task, slot.created_by ?? req.user.id, req.user.id).lastInsertRowid);
      db.prepare("UPDATE crew_request_slots SET status = 'filled', assignment_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(aid, req.user.id, slot.id);
      return aid;
    });
    audit(req, 'fill_trade', 'crew_request', slot.id, { employee_id: eid, trade: slot.trade, date: slot.work_date });
    res.json({ assignment_id: id, warnings: overWarnings([[eid, slot.work_date]]) });
  });

  api.post('/crew-requests/reject', adminOnly, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    const reason = str(req.body.reason, 300);
    if (!ids.length) throw bad('Nothing selected.');
    if (!reason) throw bad('Give a reason for the rejection so the superintendent knows why.');
    let rejected = 0;
    tx(db, () => { for (const id of ids) rejected += db.prepare(`UPDATE crew_request_slots SET status = 'rejected', reject_reason = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ? AND status = 'open'`).run(reason, req.user.id, id).changes; });
    audit(req, 'reject_trade', 'crew_request', null, { count: rejected, reason });
    res.json({ rejected });
  });

  // The requesting superintendent (or the manager) withdraws an open or rejected request.
  api.delete('/crew-requests/:id', canSchedule, (req, res) => {
    const slot = db.prepare('SELECT * FROM crew_request_slots WHERE id = ?').get(int(req.params.id));
    if (!slot) throw new HttpError(404, 'Request not found.');
    assertCanEdit(req, slot.project_id);
    if (slot.status === 'filled') throw bad('That request was already filled. Remove the person from the schedule instead.');
    db.prepare('DELETE FROM crew_request_slots WHERE id = ?').run(slot.id);
    audit(req, 'cancel_trade', 'crew_request', slot.id, { trade: slot.trade, date: slot.work_date });
    res.json({ ok: true });
  });

  api.post('/assignments/approve', adminOnly, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    if (!ids.length) throw bad('Nothing selected.');
    const conflicts = []; let approved = 0; const touched = [];
    tx(db, () => {
      for (const id of ids) {
        const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
        if (!a || a.approval_status === 'approved') continue;
        if (a.approval_status === 'rejected') {
          // Re-approving a rejection must not double book.
          const c = conflictFor(a.employee_id, a.work_date, { projectId: a.project_id, hours: a.planned_hours }, a.id);
          if (c) { conflicts.push(`${empName.get(a.employee_id)?.name} ${c.message} on ${a.work_date}`); continue; }
        }
        db.prepare("UPDATE assignments SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now'), reject_reason = NULL, updated_at = datetime('now') WHERE id = ?")
          .run(req.user.id, id);
        approved += 1; touched.push([a.employee_id, a.work_date]);
      }
    });
    audit(req, 'approve', 'assignment', null, { count: approved });
    res.json({ approved, conflicts, warnings: overWarnings(touched) });
  });

  api.post('/assignments/reject', adminOnly, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    const reason = str(req.body.reason, 300);
    if (!ids.length) throw bad('Nothing selected.');
    if (!reason) throw bad('Give a reason for the rejection so the superintendent knows why.');
    let rejected = 0;
    tx(db, () => {
      for (const id of ids) {
        rejected += db.prepare(`UPDATE assignments SET approval_status = 'rejected', reject_reason = ?, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status = 'scheduled'`).run(reason, req.user.id, id).changes;
      }
    });
    audit(req, 'reject', 'assignment', null, { count: rejected, reason });
    res.json({ rejected });
  });

  // ---- time off (one record for everyone) --------------------------------------------
  // Union crew, superintendents and office staff all use the time_off table: one row per
  // day, approved / pending / rejected, with the days of one request sharing a batch id.
  // Approved days block scheduling and show on the schedule and the Time Off calendar.
  const timeOffSelect = `SELECT t.*, e.first_name, e.last_name, e.trade, e.employee_type, e.department, cu.name AS requested_by_name, du.name AS decided_by_name
    FROM time_off t JOIN employees e ON e.id = t.employee_id LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users du ON du.id = t.decided_by`;
  const leaveApprover = auth.requireRole('admin', 'office_admin');
  const empRow = db.prepare('SELECT * FROM employees WHERE id = ?');
  // Reasons each kind of employee can pick. Only PTO and Vacation use up allowance hours.
  const UNION_REASONS = ['Vacation', 'Sick / medical', 'Family leave', 'Jury duty', 'Union business', 'Training', 'Bereavement', 'Unpaid', 'Laid off', 'Other'];
  // Project managers follow the office staff rules; general foremen the union crew rules.
  const REASONS = { staff: ['PTO', 'Vacation', 'Other'], project_manager: ['PTO', 'Vacation', 'Other'], superintendent: ['PTO', 'Other'], union: UNION_REASONS, general_foreman: UNION_REASONS };
  const LEAVE_KINDS = { staff: ['pto', 'vacation'], project_manager: ['pto', 'vacation'], superintendent: ['pto'], union: [], general_foreman: [] };
  const isOffice = (type) => type === 'staff' || type === 'project_manager';
  const reasonKind = (reason) => { const r = String(reason || '').trim().toLowerCase(); return /^pto\b/.test(r) ? 'pto' : /^vacation\b/.test(r) ? 'vacation' : null; };
  const typeOf = (e) => (e && REASONS[e.employee_type] ? e.employee_type : 'union');
  const defaultAllowance = (type, kind) => Number(getSettings(db)[`${isOffice(type) ? 'staff' : 'super'}_${kind}_default_hours`]) || 0;

  // Days in a request: a date range (optionally weekdays only, skipping union holidays) or a list of dates.
  function offDates(b) {
    let dates;
    if (b.from) {
      const from = date(b.from, 'From', true); const to = date(b.to || b.from, 'To', true);
      if (to < from) throw bad('The end date is before the start date.');
      if (daysBetween(from, to) > 366) throw bad('Enter at most one year of time off at a time.');
      const hol = holidayMap(from, to);
      dates = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const dow = new Date(d + 'T00:00:00Z').getUTCDay();
        if (b.weekdays_only && (dow === 0 || dow === 6 || hol[d])) continue;
        dates.push(d);
      }
      if (!dates.length) throw bad('That range has no work days (weekends and holidays are skipped).');
    } else {
      dates = (Array.isArray(b.dates) ? b.dates : [b.off_date]).map((d) => date(d, 'Date', true));
    }
    return dates;
  }
  const offHours = (b) => hours(b.hours, 'Hours per day') ?? Number(getSettings(db).default_hours) ?? 8;

  // Yearly balance per kind (PTO, Vacation) for one employee; null for union crew.
  function leaveBalance(eid, year) {
    const e = empRow.get(eid); const type = typeOf(e);
    const kinds = LEAVE_KINDS[type];
    if (!kinds.length) return null;
    const def = Number(getSettings(db).default_hours) || 8; const t = today();
    const out = { year, employee_type: type, kinds: {} };
    for (const k of kinds) {
      const own = db.prepare('SELECT hours, note FROM leave_allowances WHERE employee_id = ? AND year = ? AND kind = ?').get(eid, year, k);
      out.kinds[k] = { allowance: own ? own.hours : defaultAllowance(type, k), custom: !!own, note: own?.note || null, used: 0, scheduled: 0, pending: 0 };
    }
    for (const r of db.prepare(`SELECT off_date, reason, hours, status FROM time_off WHERE employee_id = ? AND off_date BETWEEN ? AND ? AND status IN ('approved','pending')`)
      .all(eid, `${year}-01-01`, `${year}-12-31`)) {
      const b = out.kinds[reasonKind(r.reason)]; if (!b) continue;
      const h = r.hours ?? def;
      if (r.status === 'pending') b.pending += h; else if (r.off_date <= t) b.used += h; else b.scheduled += h;
    }
    for (const b of Object.values(out.kinds)) b.left = round2(b.allowance - b.used - b.scheduled);
    return out;
  }
  // Group a list of day rows into requests (same batch, or consecutive manager-entered days).
  function groupOff(rows) {
    const out = [];
    for (const r of [...rows].sort((a, b) => a.employee_id - b.employee_id || a.off_date.localeCompare(b.off_date))) {
      const key = r.batch || null; const last = out[out.length - 1];
      const same = last && last.employee_id === r.employee_id && last.status === r.status && last.reason === r.reason
        && (key ? last.batch === key : !last.batch && r.off_date <= addDays(last.end_date, 3));
      if (same) { last.end_date = r.off_date; last.ids.push(r.id); last.days += 1; last.hours += r.hours ?? 8; }
      else out.push({ ...r, start_date: r.off_date, end_date: r.off_date, ids: [r.id], days: 1, hours: r.hours ?? 8 });
    }
    return out;
  }
  // Who hears about a new request: office staff -> Office Manager; superintendents -> both;
  // union crew -> Workforce Manager.
  const emailsFor = (roles) => db.prepare(`SELECT email FROM users WHERE role IN (${roles.map(() => '?').join(',')}) AND active = 1 AND notify_requests = 1
    AND email IS NOT NULL AND email <> ''`).all(...roles).map((r) => r.email);
  function requestRecipients(type) {
    const om = emailsFor(['office_admin']); const wm = emailsFor(['admin']);
    if (isOffice(type)) return om.length ? om : wm;
    if (type === 'superintendent') return [...wm, ...om];
    return wm;
  }

  // Manager (or a superintendent, or the Office Manager for staff) enters time off: approved right away.
  api.post('/time-off', auth.requireRole('admin', 'super', 'office_admin'), (req, res) => {
    const eid = int(req.body.employee_id);
    const emp = empRow.get(eid);
    if (!emp) throw bad('Pick an employee.');
    if (req.user.role === 'office_admin' && !isOffice(emp.employee_type)) throw new HttpError(403, 'The Office Manager enters time off for office staff only.');
    const dates = offDates(req.body);
    const reason = str(req.body.reason, 200); const h = offHours(req.body);
    const conflicts = []; let added = 0;
    const batch = req.body.from ? require('node:crypto').randomUUID() : null;
    const up = db.prepare(`INSERT INTO time_off (employee_id, off_date, reason, hours, note, batch, created_by, status, created_at, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', datetime('now'), ?, datetime('now'))
      ON CONFLICT (employee_id, off_date) DO UPDATE SET status = 'approved', reason = excluded.reason, hours = excluded.hours, note = excluded.note,
        decided_by = excluded.decided_by, decided_at = excluded.decided_at, reject_reason = NULL WHERE time_off.status <> 'approved'`);
    tx(db, () => {
      for (const d of dates) {
        const booked = findBookings.all(eid, d);
        if (booked.length) { conflicts.push(`${d}: scheduled on ${booked.map((x) => x.job_number).join(', ')}. Remove that first.`); continue; }
        added += up.run(eid, d, reason, h, str(req.body.note, 500), batch, req.user.id, req.user.id).changes;
      }
    });
    audit(req, 'create', 'time_off', eid, { from: dates[0], to: dates[dates.length - 1], days: added, reason });
    res.json({ added, conflicts });
  });

  // Anyone whose login is linked to their employee record requests their own time off.
  api.post('/time-off/request', (req, res) => {
    const eid = req.user.employee_id;
    if (!eid) throw bad('Your login is not linked to an employee record. Ask the Workforce Manager.');
    const emp = empRow.get(eid); const type = typeOf(emp);
    const dates = offDates(req.body);
    if (dates.length > 60) throw bad('Request at most 60 days at a time.');
    if (dates[0] < today()) throw bad('Time off must be today or later.');
    const reason = str(req.body.reason, 200);
    if (!reason) throw bad('Pick a type of time off.');
    if (!REASONS[type].some((x) => x.toLowerCase() === reason.toLowerCase())) throw bad(`Pick one of: ${REASONS[type].join(', ')}.`);
    const h = offHours(req.body); const note = str(req.body.note, 500);
    const batch = require('node:crypto').randomUUID();
    const skipped = []; const added = []; const notes = [];
    const existing = db.prepare('SELECT status FROM time_off WHERE employee_id = ? AND off_date = ?');
    const ins = db.prepare(`INSERT INTO time_off (employee_id, off_date, reason, hours, note, batch, created_by, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
      ON CONFLICT (employee_id, off_date) DO UPDATE SET status = 'pending', reason = excluded.reason, hours = excluded.hours, note = excluded.note,
        batch = excluded.batch, created_by = excluded.created_by, created_at = excluded.created_at, decided_by = NULL, decided_at = NULL, reject_reason = NULL
      WHERE time_off.status = 'rejected'`);
    tx(db, () => {
      for (const d of dates) {
        const cur = existing.get(eid, d);
        if (cur && cur.status !== 'rejected') { skipped.push(`${d}: already ${cur.status === 'approved' ? 'approved' : 'requested'}`); continue; }
        ins.run(eid, d, reason, h, note, batch, req.user.id);
        added.push(d);
        const booked = findBookings.all(eid, d);
        if (booked.length) notes.push(`${d}: currently scheduled on ${booked.map((x) => x.job_number).join(', ')}`);
      }
    });
    if (!added.length) throw bad(`Nothing requested – ${skipped.join('; ')}.`);
    audit(req, 'request', 'time_off', eid, { from: added[0], to: added[added.length - 1], days: added.length, reason });
    const bal = leaveBalance(eid, Number(added[0].slice(0, 4)));
    const kb = bal?.kinds[reasonKind(reason)];
    const name = `${emp.first_name} ${emp.last_name}`;
    sendEmail(requestRecipients(type), `Time-off request: ${name}`, {
      heading: `${name} requested time off`,
      lines: [`Days: ${shortDates(added)} · ${h} h per day`, `Type: ${reason}`, ...(note ? [`Note: ${note}`] : []),
        kb ? `${reason} balance before this request: ${kb.left} h left of ${kb.allowance} h (${added.length * h} h requested)` : 'This type does not use allowance hours.',
        ...(notes.length ? ['Heads up – ' + notes.join('; ')] : [])],
      link: appUrl(req, isOffice(type) ? '#/timeoff' : '#/schedule'), linkText: 'Review in the Workforce app',
    });
    res.json({ added: added.length, skipped, notes, balance: bal });
  });

  // Approve or reject (a reason is required to reject). Workforce Manager or Office Manager.
  api.post('/time-off/decide', leaveApprover, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    const approve = req.body.action === 'approve';
    if (!ids.length) throw bad('Pick at least one request.');
    const reason = str(req.body.reason, 300);
    if (!approve && !reason) throw bad('A reason is required to reject.');
    const rows = db.prepare(`${timeOffSelect} WHERE t.id IN (${ids.map(() => '?').join(',')}) AND t.status = 'pending'`).all(...ids);
    const done = []; const conflicts = [];
    tx(db, () => {
      for (const r of rows) {
        if (approve) {
          const booked = findBookings.all(r.employee_id, r.off_date);
          if (booked.length) { conflicts.push(`${r.first_name} ${r.last_name} ${r.off_date}: scheduled on ${booked.map((x) => x.job_number).join(', ')} – move them first`); continue; }
        }
        db.prepare(`UPDATE time_off SET status = ?, decided_by = ?, decided_at = datetime('now'), reject_reason = ? WHERE id = ?`)
          .run(approve ? 'approved' : 'rejected', req.user.id, approve ? null : reason, r.id);
        done.push(r);
      }
    });
    audit(req, approve ? 'approve' : 'reject', 'time_off', null, { count: done.length, reason });
    const byEmp = new Map();
    for (const r of done) (byEmp.get(r.employee_id) || byEmp.set(r.employee_id, []).get(r.employee_id)).push(r);
    for (const [eid, list] of byEmp) {
      const to = [empRow.get(eid)?.email, ...db.prepare("SELECT email FROM users WHERE employee_id = ? AND active = 1 AND email IS NOT NULL AND email <> ''").all(eid).map((u) => u.email)];
      sendEmail(to, `Time off ${approve ? 'approved' : 'not approved'}: ${shortDates(list.map((x) => x.off_date))}`, {
        heading: `Your time off was ${approve ? 'approved' : 'not approved'}`,
        lines: [`Days: ${shortDates(list.map((x) => x.off_date))}`, ...(approve ? [] : [`Reason: ${reason}`]), `By: ${req.user.name}`],
        link: appUrl(req, '#/timeoff'), linkText: 'See Time Off', footer: 'Sent by the Fager-McGee Workforce app.',
      });
    }
    res.json({ [approve ? 'approved' : 'rejected']: done.length, conflicts });
  });

  // Managers remove any time off (the Office Manager: office staff); an employee can cancel
  // their own pending request or approved days still ahead.
  api.delete('/time-off/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM time_off WHERE id = ?').get(int(req.params.id));
    if (!row) return res.json({ ok: true });
    const own = row.employee_id === req.user.employee_id && (row.status !== 'approved' || row.off_date > today());
    const om = req.user.role === 'office_admin' && isOffice(empRow.get(row.employee_id)?.employee_type);
    if (!['admin', 'super'].includes(req.user.role) && !own && !om) throw new HttpError(403, 'You can only cancel your own requests.');
    db.prepare('DELETE FROM time_off WHERE id = ?').run(row.id);
    audit(req, 'delete', 'time_off', row.id, { employee_id: row.employee_id, off_date: row.off_date, status: row.status });
    res.json({ ok: true });
  });

  // My own time off: requests (grouped) and balances, for anyone linked to an employee record.
  api.get('/leave/mine', (req, res) => {
    const eid = req.user.employee_id;
    if (!eid) return res.json({ linked: false });
    const year = int(req.query.year) || Number(today().slice(0, 4));
    const e = empRow.get(eid);
    res.json({
      linked: true, employee_type: typeOf(e), reasons: REASONS[typeOf(e)],
      balance: leaveBalance(eid, year),
      requests: groupOff(db.prepare(`${timeOffSelect} WHERE t.employee_id = ? AND (t.off_date >= ? OR t.status = 'pending') ORDER BY t.off_date`).all(eid, addDays(today(), -120))).reverse(),
    });
  });
  // Reasons offered for a given employee (manager entry).
  api.get('/leave/reasons', (_req, res) => res.json(REASONS));

  // Who's out: approved time off for everyone, open to every login (no notes or reasons for rejections).
  api.get('/leave/calendar', (req, res) => {
    const start = date(req.query.start, 'start', true); const end = date(req.query.end, 'end', true);
    if (daysBetween(start, end) > 62) throw bad('Pick at most two months.');
    const rows = db.prepare(`SELECT t.id, t.employee_id, t.off_date, t.reason, e.first_name, e.last_name, e.employee_type, e.department, e.trade
      FROM time_off t JOIN employees e ON e.id = t.employee_id WHERE t.status = 'approved' AND t.off_date BETWEEN ? AND ? ORDER BY e.last_name, e.first_name`).all(start, end);
    res.json({ days: rows, holidays: holidayMap(start, end) });
  });

  // Approver queue: pending requests (and the last 60 days of decisions), each with the balance it draws on.
  api.get('/leave/requests', leaveApprover, (req, res) => {
    const groups = groupOff(db.prepare(`${timeOffSelect} WHERE t.batch IS NOT NULL AND (t.status = 'pending' OR (t.decided_at >= ? AND t.status IN ('approved','rejected')))`)
      .all(addDays(today(), -60)));
    for (const g of groups) {
      const kb = leaveBalance(g.employee_id, Number(g.start_date.slice(0, 4)))?.kinds[reasonKind(g.reason)];
      g.balance_left = kb ? kb.left : null;
    }
    // Approved time off still ahead (requested or entered by a manager), so it can be edited or removed.
    const upcoming = groupOff(db.prepare(`${timeOffSelect} WHERE t.status = 'approved' AND t.off_date >= ?`).all(today()))
      .sort((a, b) => a.start_date.localeCompare(b.start_date));
    res.json({
      pending: groups.filter((g) => g.status === 'pending'),
      upcoming,
      decided: groups.filter((g) => g.status !== 'pending').sort((a, b) => (b.decided_at || '').localeCompare(a.decided_at || '')),
    });
  });

  // ---- approver edits / deletes a whole request ----------------------------------------
  // `ids` are the day rows of one request (one employee). The Office Manager: office staff only.
  function requestRows(req) {
    const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean))];
    if (!ids.length) throw bad('Pick a request.');
    const rows = db.prepare(`${timeOffSelect} WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.off_date`).all(...ids);
    if (!rows.length) throw new HttpError(404, 'That time off no longer exists.');
    if (new Set(rows.map((r) => r.employee_id)).size > 1) throw bad('Edit one person\'s request at a time.');
    if (req.user.role === 'office_admin' && !isOffice(rows[0].employee_type)) throw new HttpError(403, 'The Office Manager edits office staff time off only.');
    return rows;
  }
  const spanText = (rows) => shortDates(rows.map((r) => r.off_date));
  const personEmails = (eid) => [empRow.get(eid)?.email, ...db.prepare("SELECT email FROM users WHERE employee_id = ? AND active = 1 AND email IS NOT NULL AND email <> ''").all(eid).map((u) => u.email)];

  api.put('/time-off/request', leaveApprover, (req, res) => {
    const rows = requestRows(req); const first = rows[0];
    const type = typeOf(empRow.get(first.employee_id));
    const dates = offDates(req.body);
    if (dates.length > 366) throw bad('Too many days.');
    const reason = str(req.body.reason, 200) || first.reason;
    if (!REASONS[type].some((x) => x.toLowerCase() === String(reason).toLowerCase())) throw bad(`Pick one of: ${REASONS[type].join(', ')}.`);
    const h = offHours(req.body); const note = req.body.note !== undefined ? str(req.body.note, 500) : first.note;
    const status = first.status === 'rejected' ? 'pending' : first.status;
    const batch = first.batch || require('node:crypto').randomUUID();
    const conflicts = []; const kept = [];
    const ins = db.prepare(`INSERT INTO time_off (employee_id, off_date, reason, hours, note, batch, created_by, status, created_at, decided_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const other = db.prepare('SELECT status FROM time_off WHERE employee_id = ? AND off_date = ?');
    tx(db, () => {
      db.prepare(`DELETE FROM time_off WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
      for (const d of dates) {
        if (other.get(first.employee_id, d)) { conflicts.push(`${d}: already has other time off`); continue; }
        if (status === 'approved') {
          const booked = findBookings.all(first.employee_id, d);
          if (booked.length) { conflicts.push(`${d}: scheduled on ${booked.map((x) => x.job_number).join(', ')} – move them first`); continue; }
        }
        ins.run(first.employee_id, d, reason, h, note, batch, first.created_by, status, first.created_at || new Date().toISOString(),
          status === 'approved' ? req.user.id : null, status === 'approved' ? new Date().toISOString() : null);
        kept.push(d);
      }
      if (!kept.length) throw bad(`Nothing saved – ${conflicts.join('; ') || 'no days in that range'}. The original time off is unchanged.`, { conflicts });
    });
    audit(req, 'edit', 'time_off', first.employee_id, { was: spanText(rows), now: shortDates(kept), reason, hours: h });
    sendEmail(personEmails(first.employee_id), `Your time off was changed: ${shortDates(kept)}`, {
      heading: 'Your time off was changed',
      lines: [`Was: ${spanText(rows)} (${first.reason || ''})`, `Now: ${shortDates(kept)} · ${reason} · ${h} h per day`, `Status: ${status === 'approved' ? 'Approved' : 'Waiting for approval'}`, `By: ${req.user.name}`],
      link: appUrl(req, '#/timeoff'), linkText: 'See Time Off', footer: 'Sent by the Fager-McGee Workforce app.',
    });
    res.json({ saved: kept.length, conflicts, ids: db.prepare('SELECT id FROM time_off WHERE employee_id = ? AND batch = ?').all(first.employee_id, batch).map((r) => r.id) });
  });

  api.post('/time-off/remove', leaveApprover, (req, res) => {
    const rows = requestRows(req); const first = rows[0];
    db.prepare(`DELETE FROM time_off WHERE id IN (${rows.map(() => '?').join(',')})`).run(...rows.map((r) => r.id));
    const why = str(req.body.reason, 300);
    audit(req, 'delete', 'time_off', first.employee_id, { dates: spanText(rows), status: first.status, reason: why });
    sendEmail(personEmails(first.employee_id), `Your time off was removed: ${spanText(rows)}`, {
      heading: 'Your time off was removed',
      lines: [`Days: ${spanText(rows)} (${first.reason || ''})`, ...(why ? [`Reason: ${why}`] : []), `By: ${req.user.name}`],
      link: appUrl(req, '#/timeoff'), linkText: 'See Time Off', footer: 'Sent by the Fager-McGee Workforce app.',
    });
    res.json({ removed: rows.length });
  });

  // Balances for everyone who has allowances (superintendents and office staff).
  api.get('/leave/balances', auth.requireRole('admin', 'super', 'office_admin'), (req, res) => {
    const year = int(req.query.year) || Number(today().slice(0, 4));
    const s = getSettings(db);
    res.json({
      year,
      defaults: { staff_pto: Number(s.staff_pto_default_hours) || 0, staff_vacation: Number(s.staff_vacation_default_hours) || 0, super_pto: Number(s.super_pto_default_hours) || 0 },
      employees: db.prepare("SELECT * FROM employees WHERE active = 1 AND employee_type IN ('staff','project_manager','superintendent') ORDER BY employee_type, last_name, first_name").all()
        .map((e) => ({ id: e.id, first_name: e.first_name, last_name: e.last_name, employee_type: e.employee_type, department: e.department, trade: e.trade, ...leaveBalance(e.id, year) })),
    });
  });
  // Set one person's allowance for a year and kind (blank hours = back to the company default).
  api.put('/leave/allowance/:employee_id', leaveApprover, (req, res) => {
    const eid = int(req.params.employee_id); const e = empRow.get(eid);
    if (!e) throw new HttpError(404, 'Employee not found.');
    const year = int(req.body.year); const kind = str(req.body.kind, 20);
    if (!year || year < 2000 || year > 2100) throw bad('Pick a year.');
    if (!LEAVE_KINDS[typeOf(e)].includes(kind)) throw bad(`${e.first_name} ${e.last_name} doesn't get ${kind === 'vacation' ? 'Vacation' : 'PTO'} hours.`);
    const h = num(req.body.hours);
    if (h === null) db.prepare('DELETE FROM leave_allowances WHERE employee_id = ? AND year = ? AND kind = ?').run(eid, year, kind);
    else {
      if (Number.isNaN(h) || h < 0 || h > 2000) throw bad('Allowance must be between 0 and 2000 hours.');
      db.prepare(`INSERT INTO leave_allowances (employee_id, year, kind, hours, note, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (employee_id, year, kind) DO UPDATE SET hours = excluded.hours, note = excluded.note, updated_by = excluded.updated_by, updated_at = datetime('now')`)
        .run(eid, year, kind, h, str(req.body.note, 200), req.user.id);
    }
    audit(req, 'update', 'leave_allowance', eid, { year, kind, hours: h });
    res.json(leaveBalance(eid, year));
  });

  // Union holidays for a year (observed dates).
  api.get('/holidays', (req, res) => res.json(holidaysForYear(int(req.query.year) || Number(today().slice(0, 4)))));

  // ---- hour verification -----------------------------------------------------------
  // Verify Hours works on the payroll week (settings.payroll_week_start, e.g. Wed–Tue).
  const payrollStart = (d) => periodStart(d || new Date().toISOString().slice(0, 10), Number(getSettings(db).payroll_week_start ?? 1));

  api.get('/verification', canSchedule, (req, res) => {
    const start = payrollStart(date(req.query.start, 'start'));
    const end = addDays(start, 6);
    const projectId = int(req.query.project_id);
    const rows = db.prepare(`${assignmentSelect} LEFT JOIN users v ON v.id = a.verified_by
      WHERE a.work_date BETWEEN ? AND ? AND a.approval_status = 'approved' ${projectId ? 'AND a.project_id = ?' : ''}
      ORDER BY a.work_date, p.job_number, e.last_name`).all(...[start, end, ...(projectId ? [projectId] : [])]);
    const verifierNames = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    // Time card lines (cost codes) behind each person/day/job.
    const lines = db.prepare(`SELECT * FROM timecard_entries WHERE work_date BETWEEN ? AND ? ORDER BY work_date, id`).all(start, end);
    const byKey = new Map();
    for (const l of lines) {
      if (!l.employee_id || !l.project_id) continue;
      const k = `${l.employee_id}|${l.project_id}|${l.work_date}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ cost_code: l.cost_code, cost_code_name: l.cost_code_name, description: l.description, hours: l.hours, time_type: l.time_type });
    }
    const hasImport = lines.length > 0;
    const summary = { planned: 0, actual: 0, timecard: 0, verified_count: 0, pending_count: 0, no_show_count: 0, variance: 0,
      matched: 0, variances: 0, unscheduled: 0, no_timecard: 0, unmatched: 0 };
    for (const r of rows) {
      r.verified_by_name = verifierNames.get(r.verified_by) || null;
      r.timecard_lines = byKey.get(`${r.employee_id}|${r.project_id}|${r.work_date}`) || [];
      // How this row compares with the time card.
      r.recon = r.source === 'timecard' ? 'unscheduled'
        : r.timecard_hours === null ? (hasImport ? 'no_timecard' : 'not_imported')
          : r.timecard_hours === r.planned_hours ? 'matched' : 'variance';
      if (r.recon === 'matched') summary.matched += 1;
      if (r.recon === 'variance') summary.variances += 1;
      if (r.recon === 'unscheduled') summary.unscheduled += 1;
      if (r.recon === 'no_timecard') summary.no_timecard += 1;
      summary.planned += r.planned_hours;
      summary.timecard += r.timecard_hours ?? 0;
      if (r.status === 'scheduled') summary.pending_count += 1;
      else {
        summary.verified_count += 1;
        if (r.status === 'no_show') summary.no_show_count += 1;
        summary.actual += r.status === 'no_show' ? 0 : r.actual_hours ?? 0;
      }
    }
    const unmatched = lines.filter((l) => !l.employee_id || !l.project_id).map((l) => ({
      ...l, reason: [!l.employee_id && `Employee #${l.employee_no || '?'} ${l.employee_name || ''} is not in Employees`, !l.project_id && `Job ${l.job_number || '?'} is not in Projects`].filter(Boolean).join('; '),
    }));
    summary.unmatched = unmatched.length;
    summary.timecard = round2(summary.timecard + 0);
    const verifiedPlanned = rows.filter((r) => r.status !== 'scheduled').reduce((x, r) => x + r.planned_hours, 0);
    summary.variance = round2(summary.actual - verifiedPlanned);
    const imports = db.prepare(`SELECT i.*, u.name AS imported_by_name FROM timecard_imports i LEFT JOIN users u ON u.id = i.imported_by
      WHERE i.period_end >= ? AND i.period_start <= ? ORDER BY i.id DESC`).all(start, end);
    res.json({ start, end, rows, summary, unmatched, imports });
  });

  // ---- time card import (Procore "timecards" CSV, parsed in the browser) ----------
  const TC_FIELDS = {
    work_date: ['date', 'workdate'], employee_name: ['employeename', 'employee', 'name'], employee_no: ['employeeid', 'employeeno', 'employeenumber', 'empid'],
    project_name: ['projectname'], job_number: ['projectnumber', 'jobnumber', 'job'], description: ['description', 'notes'],
    cost_code: ['costcodelongnumber', 'costcode', 'costcodenumber'], cost_code_name: ['costcodename'], cost_code_long: ['costcodelongname'],
    billable: ['billable'], hours: ['hours', 'totalhours'], time_type: ['formattedtimetype', 'timetype', 'type'],
  };
  const tcField = (() => {
    const m = new Map();
    for (const [f, aliases] of Object.entries(TC_FIELDS)) for (const a of aliases) m.set(a, f);
    return (h) => m.get(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')) || null;
  })();
  const empByNo = db.prepare('SELECT id FROM employees WHERE employee_no = ? COLLATE NOCASE');
  const empByFullName = db.prepare("SELECT id FROM employees WHERE (first_name || ' ' || last_name) = ? COLLATE NOCASE");
  const projByJob = db.prepare('SELECT id FROM projects WHERE job_number = ? COLLATE NOCASE');
  const matchEmployee = (no, name) => (no && empByNo.get(no)?.id) || (name && empByFullName.get(name)?.id) || null;
  const matchProject = (job) => (job && projByJob.get(job)?.id) || null;

  // Write time card totals onto the schedule for a date range: scheduled days get
  // their actual hours; days worked but not scheduled get an "unscheduled" entry.
  function reconcileTimecards(req, from, to) {
    const groups = db.prepare(`SELECT employee_id, project_id, work_date, SUM(hours) AS hours FROM timecard_entries
      WHERE work_date BETWEEN ? AND ? AND employee_id IS NOT NULL AND project_id IS NOT NULL GROUP BY 1, 2, 3`).all(from, to);
    const key = (g) => `${g.employee_id}|${g.project_id}|${g.work_date}`;
    const totals = new Map(groups.map((g) => [key(g), round2(g.hours)]));
    const existing = db.prepare('SELECT * FROM assignments WHERE work_date BETWEEN ? AND ?').all(from, to);
    const seen = new Set(); const out = { matched: 0, variances: 0, unscheduled: 0, cleared: 0 };
    const upd = db.prepare(`UPDATE assignments SET timecard_hours = ?, actual_hours = ?, status = ?, verified_by = ?, verified_at = datetime('now'),
      verify_note = ?, approval_status = 'approved', updated_at = datetime('now') WHERE id = ?`);
    for (const a of existing) {
      const k = key(a); const tc = totals.get(k);
      if (tc !== undefined) {
        seen.add(k);
        const st = a.source === 'timecard' ? 'adjusted' : tc === a.planned_hours ? 'verified' : 'adjusted';
        upd.run(tc, tc, st, req.user.id, 'From time card', a.id);
        if (a.source === 'timecard') out.unscheduled += 1; else if (tc === a.planned_hours) out.matched += 1; else out.variances += 1;
      } else if (a.source === 'timecard') {
        db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id); out.cleared += 1;
      } else if (a.timecard_hours !== null) {
        // Was on an earlier import of this range but not on this one: back to unverified.
        db.prepare(`UPDATE assignments SET timecard_hours = NULL, actual_hours = NULL, status = 'scheduled', verified_by = NULL, verified_at = NULL,
          verify_note = NULL WHERE id = ? AND verify_note = 'From time card'`).run(a.id);
        db.prepare('UPDATE assignments SET timecard_hours = NULL WHERE id = ?').run(a.id);
        out.cleared += 1;
      }
    }
    const ins = db.prepare(`INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, actual_hours, timecard_hours, status, source,
      approval_status, approved_by, approved_at, verified_by, verified_at, verify_note, created_by)
      VALUES (?, ?, ?, 0, ?, ?, 'adjusted', 'timecard', 'approved', ?, datetime('now'), ?, datetime('now'), 'Not scheduled – from time card', ?)`);
    for (const g of groups) {
      if (seen.has(key(g)) || !(g.hours > 0)) continue;
      ins.run(g.employee_id, g.project_id, g.work_date, round2(g.hours), round2(g.hours), req.user.id, req.user.id, req.user.id);
      out.unscheduled += 1;
    }
    return out;
  }

  // Shared by the manual CSV import and the Procore API sync: given already-parsed
  // row objects (keyed by canonical field name or any TC_FIELDS alias), preview or
  // commit them. `filename` is only used for the audit trail / timecard_imports log.
  function importTimecardRows(req, rows, commit, filename) {
    if (!rows.length) throw bad('No time card rows to import.');
    if (rows.length > 20000) throw bad('That file is too large (over 20,000 lines).');
    const lines = []; const errors = [];
    rows.forEach((raw, idx) => {
      const r = {};
      for (const [k, v] of Object.entries(raw || {})) { const f = tcField(k); if (f && r[f] === undefined) r[f] = v; }
      try {
        const d = importDate(r.work_date);
        if (!d) throw new Error('Missing date');
        const h = importHours(r.hours, 'Hours');
        if (h === null) throw new Error('Missing hours');
        if (h < 0 || h > 24) throw new Error(`Hours ${h} must be between 0 and 24`);
        const no = str(r.employee_no, 50); const name = str(r.employee_name, 200); const job = str(r.job_number, 50);
        const longName = str(r.cost_code_long, 200);
        lines.push({
          work_date: d, employee_no: no, employee_name: name, employee_id: matchEmployee(no, name),
          job_number: job, project_name: str(r.project_name, 200), project_id: matchProject(job),
          cost_code: str(r.cost_code, 50) || (longName ? longName.split(' - ')[0] : null), cost_code_name: str(r.cost_code_name, 200) || longName,
          description: str(r.description, 1000), time_type: str(r.time_type, 50), billable: str(r.billable, 20), hours: h,
        });
      } catch (e) { errors.push({ line: idx + 2, reason: e.message }); }
    });
    if (!lines.length) throw bad('No time card lines could be read.', { errors });
    const from = lines.reduce((m, l) => (l.work_date < m ? l.work_date : m), lines[0].work_date);
    const to = lines.reduce((m, l) => (l.work_date > m ? l.work_date : m), lines[0].work_date);
    // Preview: compare totals with the approved schedule.
    const totals = new Map();
    for (const l of lines) {
      if (!l.employee_id || !l.project_id) continue;
      const k = `${l.employee_id}|${l.project_id}|${l.work_date}`;
      totals.set(k, round2((totals.get(k) || 0) + l.hours));
    }
    const sched = db.prepare(`SELECT employee_id, project_id, work_date, planned_hours FROM assignments
      WHERE work_date BETWEEN ? AND ? AND source = 'schedule' AND approval_status <> 'rejected'`).all(from, to);
    const schedMap = new Map(sched.map((a) => [`${a.employee_id}|${a.project_id}|${a.work_date}`, a.planned_hours]));
    let matched = 0, variances = 0, unscheduled = 0;
    for (const [k, h] of totals) {
      if (!schedMap.has(k)) { if (h > 0) unscheduled += 1; } else if (schedMap.get(k) === h) matched += 1; else variances += 1;
    }
    const noTimecard = [...schedMap.keys()].filter((k) => !totals.has(k)).length;
    const unmatched = lines.filter((l) => !l.employee_id || !l.project_id);
    const preview = {
      period: { from, to }, lines: lines.length, total_hours: round2(lines.reduce((x, l) => x + l.hours, 0)),
      people: new Set(lines.map((l) => l.employee_no || l.employee_name)).size,
      matched, variances, unscheduled, no_timecard: noTimecard, errors,
      unmatched: [...new Map(unmatched.map((l) => [`${l.employee_id ? '' : l.employee_no}|${l.project_id ? '' : l.job_number}`,
        { employee: l.employee_id ? null : `#${l.employee_no || '?'} ${l.employee_name || ''}`.trim(), job: l.project_id ? null : `${l.job_number || '?'} ${l.project_name || ''}`.trim() }])).values()],
      unmatched_lines: unmatched.length,
      replaces: db.prepare('SELECT COUNT(*) AS n FROM timecard_entries WHERE work_date BETWEEN ? AND ?').get(from, to).n,
    };
    if (!commit) return { committed: false, preview };
    const result = tx(db, () => {
      // Re-importing a period replaces the time card lines for those dates.
      db.prepare('DELETE FROM timecard_entries WHERE work_date BETWEEN ? AND ?').run(from, to);
      const imp = Number(db.prepare('INSERT INTO timecard_imports (filename, period_start, period_end, line_count, total_hours, imported_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(str(filename, 200), from, to, lines.length, preview.total_hours, req.user.id).lastInsertRowid);
      const ins = db.prepare(`INSERT INTO timecard_entries (import_id, work_date, employee_id, employee_no, employee_name, project_id, job_number, project_name,
        cost_code, cost_code_name, description, time_type, billable, hours) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const l of lines) ins.run(imp, l.work_date, l.employee_id, l.employee_no, l.employee_name, l.project_id, l.job_number, l.project_name,
        l.cost_code, l.cost_code_name, l.description, l.time_type, l.billable, l.hours);
      return reconcileTimecards(req, from, to);
    });
    audit(req, 'import', 'timecards', null, { from, to, lines: lines.length, ...result });
    return { committed: true, preview, result };
  }

  api.post('/timecards/import', adminOnly, (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    const commit = req.body.commit === true;
    res.json(importTimecardRows(req, rows, commit, str(req.body.filename, 200)));
  });

  // Same import, but the rows come straight from the Procore API instead of a
  // hand-uploaded CSV. Requires PROCORE_CLIENT_ID / PROCORE_CLIENT_SECRET to be
  // set on the server, and a DMSA configured for the Procore app (see
  // procore-sync/README.md).
  api.post('/timecards/procore-sync', adminOnly, async (req, res) => {
    if (!procore.configured()) {
      throw bad('Procore is not configured on this server (PROCORE_CLIENT_ID / PROCORE_CLIENT_SECRET are not set).');
    }
    const start = date(req.body.start_date, 'Start date', true);
    const end = date(req.body.end_date, 'End date', true);
    const projectId = int(req.body.project_id);
    const commit = req.body.commit === true;
    let rows;
    try {
      ({ rows } = await procore.pullTimecardRows({ start_date: start, end_date: end, project_id: projectId }));
    } catch (e) {
      throw new HttpError(502, `Could not reach Procore: ${e.message}`);
    }
    if (!rows.length) return res.json({ committed: false, preview: null, no_data: true, period: { from: start, to: end } });
    const filename = `procore-sync_${start}_to_${end}.json`;
    res.json(importTimecardRows(req, rows, commit, filename));
  });

  // After adding a missing employee or job, link the leftover time card lines.
  api.post('/timecards/rematch', adminOnly, (req, res) => {
    const from = date(req.body.from, 'From', true); const to = date(req.body.to, 'To', true);
    const left = db.prepare('SELECT * FROM timecard_entries WHERE work_date BETWEEN ? AND ? AND (employee_id IS NULL OR project_id IS NULL)').all(from, to);
    let linked = 0;
    const result = tx(db, () => {
      for (const l of left) {
        const eid = l.employee_id || matchEmployee(l.employee_no, l.employee_name);
        const pid = l.project_id || matchProject(l.job_number);
        if (eid !== l.employee_id || pid !== l.project_id) {
          db.prepare('UPDATE timecard_entries SET employee_id = ?, project_id = ? WHERE id = ?').run(eid, pid, l.id);
          if (eid && pid) linked += 1;
        }
      }
      return reconcileTimecards(req, from, to);
    });
    audit(req, 'rematch', 'timecards', null, { from, to, linked });
    res.json({ linked, still_unmatched: left.length - linked, result });
  });

  function applyVerify(req, id, b) {
    const cur = db.prepare('SELECT * FROM assignments WHERE id = ?').get(id);
    if (!cur) throw new HttpError(404, 'Assignment not found.');
    const status = str(b.status, 20) || 'verified';
    if (!['verified', 'no_show', 'scheduled'].includes(status)) throw bad('Invalid status.');
    let actual = null; let finalStatus = status;
    if (status === 'verified') {
      actual = hours(b.actual_hours, 'Actual hours') ?? cur.planned_hours;
      if (actual !== cur.planned_hours) finalStatus = 'adjusted';
    } else if (status === 'no_show') {
      actual = 0;
      if (!str(b.note)) throw bad('Give a reason for the no-show (e.g. Sick – excused).');
    }
    const reset = status === 'scheduled';
    // A hand-entered number differs from an imported time card total: say so.
    const note = str(b.note, 500) || (status === 'verified' && cur.timecard_hours !== null && actual !== cur.timecard_hours ? `Adjusted by hand (time card ${cur.timecard_hours} h)` : null);
    db.prepare(`UPDATE assignments SET actual_hours = ?, status = ?, verified_by = ?, verified_at = ${reset ? 'NULL' : "datetime('now')"},
      verify_note = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(actual, finalStatus, reset ? null : req.user.id, note, id);
    return { id, status: finalStatus, actual_hours: actual };
  }

  api.post('/assignments/:id/verify', canSchedule, (req, res) => {
    const out = applyVerify(req, int(req.params.id), req.body);
    audit(req, 'verify', 'assignment', out.id, out);
    res.json(out);
  });

  // Verify many at once: "everyone worked their scheduled hours".
  api.post('/verification/bulk', canSchedule, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(int).filter(Boolean);
    if (!ids.length) throw bad('Nothing selected.');
    const out = tx(db, () => ids.map((id) => {
      const cur = db.prepare('SELECT status FROM assignments WHERE id = ?').get(id);
      return cur && cur.status === 'scheduled' ? applyVerify(req, id, { status: 'verified' }) : null;
    }).filter(Boolean));
    audit(req, 'verify_bulk', 'assignment', null, { count: out.length });
    res.json({ verified: out.length });
  });

  // ---- records / history -------------------------------------------------------------
  function recordQuery(q) {
    const where = []; const args = [];
    if (q.from) { where.push('a.work_date >= ?'); args.push(date(q.from, 'From')); }
    if (q.to) { where.push('a.work_date <= ?'); args.push(date(q.to, 'To')); }
    if (int(q.employee_id)) { where.push('a.employee_id = ?'); args.push(int(q.employee_id)); }
    if (int(q.project_id)) { where.push('a.project_id = ?'); args.push(int(q.project_id)); }
    if (str(q.trade)) { where.push('e.trade = ?'); args.push(str(q.trade)); }
    if (str(q.status)) { where.push('a.status = ?'); args.push(str(q.status)); }
    if (str(q.approval)) { where.push('a.approval_status = ?'); args.push(str(q.approval)); }
    return db.prepare(`${assignmentSelect} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.work_date DESC, p.job_number, e.last_name LIMIT 20000`).all(...args);
  }

  api.get('/records', (req, res) => {
    const rows = recordQuery(req.query);
    if (req.query.format === 'csv') {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', 'attachment; filename="workforce-records.csv"');
      return res.send(toCsv(rows, [
        { key: 'work_date', label: 'Date' }, { key: 'job_number', label: 'Job #' }, { key: 'project_name', label: 'Project' },
        { key: 'last_name', label: 'Last' }, { key: 'first_name', label: 'First' }, { key: 'trade', label: 'Trade' },
        { key: 'classification', label: 'Classification' }, { key: 'planned_hours', label: 'Planned Hrs' },
        { key: 'actual_hours', label: 'Actual Hrs' }, { key: 'status', label: 'Status' }, { key: 'approval_status', label: 'Approval' }, { key: 'verify_note', label: 'Verification / No-show Note' }, { key: 'reject_reason', label: 'Rejection Reason' }, { key: 'task', label: 'Task' },
      ]));
    }
    const summary = { rows: rows.length, planned: 0, actual: 0, by_project: {}, by_trade: {} };
    for (const r of rows) {
      if (r.approval_status === 'rejected') continue; // kept in the list for the record, not in hour totals
      const h = r.status === 'no_show' ? 0 : r.actual_hours ?? r.planned_hours;
      summary.planned += r.planned_hours;
      summary.actual += r.actual_hours ?? 0;
      const pk = `${r.job_number} – ${r.project_name}`;
      summary.by_project[pk] = round2((summary.by_project[pk] || 0) + h);
      const tk = r.trade || 'Unassigned';
      summary.by_trade[tk] = round2((summary.by_trade[tk] || 0) + h);
    }
    res.json({ rows: rows.slice(0, 2000), truncated: rows.length > 2000, summary });
  });

  // ---- payroll forecast (private) ------------------------------------------------------
  const allRates = () => db.prepare('SELECT * FROM employee_pay_rates').all();

  // Current rate (as of today) plus the full dated history for each active employee.
  api.get('/payroll/rates', auth.requirePayroll, (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const history = db.prepare(`SELECT r.*, u.name AS created_by_name FROM employee_pay_rates r LEFT JOIN users u ON u.id = r.created_by
      ORDER BY r.employee_id, r.effective_date DESC`).all();
    const byEmp = new Map();
    for (const h of history) { if (!byEmp.has(h.employee_id)) byEmp.set(h.employee_id, []); byEmp.get(h.employee_id).push(h); }
    const rateFor = rateLookup(history);
    res.json(db.prepare(`SELECT id AS employee_id, first_name, last_name, trade, union_local, classification FROM employees
      WHERE active = 1 ORDER BY last_name, first_name`).all().map((e) => {
      const list = byEmp.get(e.employee_id) || [];
      return { ...e, current: rateFor(e.employee_id, today), upcoming: list.filter((r) => r.effective_date > today).reverse(), history: list };
    }));
  });

  // Add a rate effective on a date (replaces any rate already on that exact date).
  api.post('/payroll/rates/:employeeId', auth.requirePayroll, (req, res) => {
    const eid = int(req.params.employeeId);
    if (!empName.get(eid)) throw new HttpError(404, 'Employee not found.');
    const eff = date(req.body.effective_date, 'Effective date', true);
    const base = num(req.body.base_rate) ?? 0; const fringe = num(req.body.fringe_rate) ?? 0; const burden = num(req.body.burden_pct);
    if ([base, fringe, burden].some((n) => Number.isNaN(n) || (n !== null && n < 0))) throw bad('Rates must be positive numbers.');
    db.prepare(`INSERT INTO employee_pay_rates (employee_id, effective_date, base_rate, fringe_rate, burden_pct, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, effective_date) DO UPDATE SET base_rate=excluded.base_rate, fringe_rate=excluded.fringe_rate,
        burden_pct=excluded.burden_pct, note=excluded.note, created_by=excluded.created_by, created_at=datetime('now')`)
      .run(eid, eff, base, fringe, burden, str(req.body.note, 200), req.user.id);
    audit(req, 'set_rate', 'pay_rate', eid, { effective_date: eff });
    res.json({ ok: true });
  });

  // Remove a rate entered by mistake.
  api.delete('/payroll/rates/entry/:id', auth.requirePayroll, (req, res) => {
    const r = db.prepare('SELECT employee_id, effective_date FROM employee_pay_rates WHERE id = ?').get(int(req.params.id));
    if (!r) throw new HttpError(404, 'Rate not found.');
    db.prepare('DELETE FROM employee_pay_rates WHERE id = ?').run(int(req.params.id));
    audit(req, 'delete_rate', 'pay_rate', r.employee_id, { effective_date: r.effective_date });
    res.json({ ok: true });
  });

  api.get('/payroll/forecast', auth.requirePayroll, (req, res) => {
    const settings0 = getSettings(db);
    const payDow = Number(settings0.payroll_week_start ?? 1);
    const start = periodStart(date(req.query.start, 'start') || new Date().toISOString().slice(0, 10), payDow);
    const weeks = Math.min(Math.max(int(req.query.weeks) || 4, 1), 26);
    const end = addDays(start, weeks * 7 - 1);
    const settings = getSettings(db);
    // Payroll counts approved work only; pending requests are reported separately.
    const rows = db.prepare(`${assignmentSelect} WHERE a.work_date BETWEEN ? AND ? AND a.approval_status = 'approved'`).all(start, end);
    const pendingReq = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(planned_hours), 0) AS h FROM assignments WHERE work_date BETWEEN ? AND ? AND approval_status = 'pending'`).get(start, end);
    const costed = costAssignments(rows, rateLookup(allRates()), settings);

    const byWeek = new Map(); const byProject = new Map(); const byEmployee = new Map(); const byTrade = new Map(); const grid = new Map();
    const grand = sumInto(new Map(), 'all', {}, { hours: 0, reg_hours: 0, ot_hours: 0, wages: 0, burden: 0, fringe: 0, total: 0 });
    const missing = new Set();
    for (const c of costed) {
      const wk = periodStart(c.work_date, payDow);
      sumInto(byWeek, wk, { week: wk }, c);
      sumInto(byProject, c.project_id, { project_id: c.project_id, job_number: c.job_number, project_name: c.project_name }, c);
      sumInto(byEmployee, c.employee_id, { employee_id: c.employee_id, name: `${c.last_name}, ${c.first_name}`, trade: c.trade }, c);
      sumInto(byTrade, c.trade || 'Unassigned', { trade: c.trade || 'Unassigned' }, c);
      sumInto(grid, `${c.project_id}|${wk}`, { project_id: c.project_id, week: wk }, c);
      for (const f of ['hours', 'reg_hours', 'ot_hours', 'wages', 'burden', 'fringe', 'total']) grand[f] = round2(grand[f] + c[f]);
      if (c.missing_rate) missing.add(`${c.first_name} ${c.last_name}`);
    }
    const weeksList = Array.from({ length: weeks }, (_, i) => addDays(start, i * 7));
    res.json({
      start, end, weeks: weeksList,
      settings: { ot_threshold_hours: Number(settings.ot_threshold_hours), ot_multiplier: Number(settings.ot_multiplier), default_burden_pct: Number(settings.default_burden_pct), payroll_week_start: payDow },
      totals: grand,
      by_week: weeksList.map((w) => byWeek.get(w) || { week: w, hours: 0, reg_hours: 0, ot_hours: 0, wages: 0, burden: 0, fringe: 0, total: 0 }),
      by_project: [...byProject.values()].sort((a, b) => b.total - a.total),
      by_employee: [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name)),
      by_trade: [...byTrade.values()].sort((a, b) => b.total - a.total),
      project_week: [...grid.values()],
      missing_rates: [...missing].sort(),
      pending_requests: { count: pendingReq.n, hours: pendingReq.h },
    });
  });

  // ---- users & settings (admin) -----------------------------------------------------
  api.get('/users', canSchedule, (req, res) => {
    const cols = req.user.role === 'admin' ? 'u.id, u.username, u.name, u.role, u.can_view_payroll, u.employee_id, u.office_staff_id, u.active, u.created_at, u.email, u.notify_requests, u.can_view_schedule' : 'u.id, u.name, u.role';
    res.json(db.prepare(`SELECT ${cols} FROM users u WHERE u.active = 1 OR ? ORDER BY u.name`).all(req.user.role === 'admin' ? 1 : 0));
  });

  const USER_ROLES = ['admin', 'super', 'viewer', 'office', 'office_admin'];
  function readUser(b, isNew) {
    const u = {
      username: str(b.username, 100), name: str(b.name, 200), role: str(b.role, 20) || 'viewer',
      can_view_payroll: bool(b.can_view_payroll), employee_id: int(b.employee_id), office_staff_id: null,
      active: b.active === undefined ? 1 : bool(b.active),
      email: str(b.email, 200), notify_requests: b.notify_requests === undefined ? 1 : bool(b.notify_requests),
      can_view_schedule: bool(b.can_view_schedule),
    };
    if (!u.username || !u.name) throw bad('Username and name are required.');
    if (!USER_ROLES.includes(u.role)) throw bad('Invalid role.');
    if (u.email && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(u.email)) throw bad('That email address does not look right.');
    const pw = b.password ? String(b.password) : '';
    if ((isNew || pw) && pw.length < 8) throw bad('Password must be at least 8 characters.');
    return { u, pw };
  }

  api.post('/users', adminOnly, (req, res) => {
    const { u, pw } = readUser(req.body, true);
    let r;
    try {
      r = db.prepare(`INSERT INTO users (username, name, password_hash, role, can_view_payroll, employee_id, office_staff_id, active, email, notify_requests, can_view_schedule)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(u.username, u.name, auth.hashPassword(pw), u.role, u.can_view_payroll, u.employee_id, u.office_staff_id, u.active, u.email, u.notify_requests, u.can_view_schedule);
    } catch (e) { uniqueMsg(e, 'That username is taken.'); }
    audit(req, 'create', 'user', Number(r.lastInsertRowid), { username: u.username, role: u.role });
    res.json({ id: Number(r.lastInsertRowid) });
  });

  api.put('/users/:id', adminOnly, (req, res) => {
    const id = int(req.params.id);
    const { u, pw } = readUser(req.body, false);
    if (id === req.user.id && (u.role !== 'admin' || !u.active)) throw bad('You cannot remove your own admin access.');
    try {
      db.prepare(`UPDATE users SET username=?, name=?, role=?, can_view_payroll=?, employee_id=?, office_staff_id=?, active=?, email=?, notify_requests=?, can_view_schedule=? WHERE id=?`)
        .run(u.username, u.name, u.role, u.can_view_payroll, u.employee_id, u.office_staff_id, u.active, u.email, u.notify_requests, u.can_view_schedule, id);
    } catch (e) { uniqueMsg(e, 'That username is taken.'); }
    if (pw) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(pw), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
    if (!u.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    audit(req, 'update', 'user', id, { role: u.role, payroll: u.can_view_payroll, active: u.active, password_reset: !!pw });
    res.json({ id });
  });

  api.get('/settings', adminOnly, (_req, res) => res.json(getSettings(db)));
  api.put('/settings', adminOnly, (req, res) => {
    const allowed = ['company_name', 'ot_threshold_hours', 'ot_multiplier', 'default_burden_pct', 'default_hours', 'max_daily_hours', 'warn_daily_hours', 'payroll_week_start', 'staff_pto_default_hours', 'staff_vacation_default_hours', 'super_pto_default_hours'];
    const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== null && String(req.body[k]).trim() !== '') up.run(String(req.body[k]).trim().slice(0, 200), k);
    audit(req, 'update', 'settings', null, req.body);
    res.json(getSettings(db));
  });

  // Email status (is SMTP set up in the server's environment?) and a test message.
  api.get('/notify/status', adminOnly, (_req, res) => {
    res.json({ configured: notifier.configured, from: notifier.from, recipients: managerEmails.all().map((r) => r.email) });
  });
  api.post('/notify/test', adminOnly, async (req, res) => {
    if (!notifier.configured) throw bad('Email is not set up yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM in Render → Environment.');
    const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
    if (!me.email) throw bad('Add your email address to your user first (Admin → Users).');
    const { text, html } = renderEmail({ heading: 'Test email from the Workforce app', lines: ['Email notifications are working.'], link: appUrl(req, '#/admin') });
    try { await notifier.send({ to: me.email, subject: 'Workforce app – test email', text, html }); } catch (e) { throw bad(`Email failed: ${e.message}`); }
    res.json({ sent_to: me.email });
  });

  api.get('/audit', adminOnly, (req, res) => {
    res.json(db.prepare(`SELECT l.*, u.name AS user_name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`)
      .all(Math.min(int(req.query.limit) || 300, 2000)));
  });

  // Full database snapshot for off-site backup.
  api.get('/backup', adminOnly, (req, res) => {
    const file = path.join(require('node:os').tmpdir(), `wf-backup-${Date.now()}.db`);
    db.prepare('VACUUM INTO ?').run(file);
    audit(req, 'backup', 'database', null);
    res.download(file, `workforce-backup-${new Date().toISOString().slice(0, 10)}.db`, () => require('node:fs').rm(file, { force: true }, () => {}));
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  // Browsers must re-check the app's files on every load (a cheap 304 when
  // unchanged) so a new deploy shows up immediately instead of after a cache delay.
  const noCache = (res) => res.set('Cache-Control', 'no-cache');
  app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: noCache }));
  app.get(/^\/(?!api\/).*/, (_req, res) => { noCache(res); res.sendFile(path.join(__dirname, '..', 'public', 'index.html')); });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong.' : err.message, ...(err.extra || {}) });
  });

  return app;
}

module.exports = { createApp };
