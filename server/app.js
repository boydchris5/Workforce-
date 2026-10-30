'use strict';
const path = require('node:path');
const express = require('express');
const { tx, getSettings } = require('./db');
const auth = require('./auth');
const { isDate, addDays, weekStart, weekDates, daysBetween } = require('./dates');
const { costAssignments, rateLookup, sumInto, round2 } = require('./payroll');

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
    res.json({ user: req.user, settings: { company_name: s.company_name, default_hours: Number(s.default_hours), warn_daily_hours: Number(s.warn_daily_hours) || 8 } });
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
    res.json(e);
  });

  function readEmployee(b) {
    const e = {
      employee_no: str(b.employee_no, 50), first_name: str(b.first_name, 100), last_name: str(b.last_name, 100),
      phone: str(b.phone, 50), email: str(b.email, 200), trade: str(b.trade, 100), union_local: str(b.union_local, 100),
      classification: str(b.classification, 100), hire_date: date(b.hire_date, 'Hire date'),
      active: b.active === undefined ? 1 : bool(b.active), notes: str(b.notes, 2000),
    };
    if (!e.first_name || !e.last_name) throw bad('First and last name are required.');
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

  api.post('/employees', canSchedule, (req, res) => {
    const e = readEmployee(req.body);
    const id = tx(db, () => {
      const r = db.prepare(`INSERT INTO employees (employee_no, first_name, last_name, phone, email, trade, union_local, classification, hire_date, active, notes)
        VALUES (:employee_no, :first_name, :last_name, :phone, :email, :trade, :union_local, :classification, :hire_date, :active, :notes)`).run(e);
      const id = Number(r.lastInsertRowid);
      saveSkills(id, req.body.skills);
      return id;
    });
    audit(req, 'create', 'employee', id, { name: `${e.first_name} ${e.last_name}` });
    res.json({ id });
  });

  api.put('/employees/:id', canSchedule, (req, res) => {
    const id = int(req.params.id);
    const e = readEmployee(req.body);
    tx(db, () => {
      const r = db.prepare(`UPDATE employees SET employee_no=:employee_no, first_name=:first_name, last_name=:last_name, phone=:phone, email=:email,
        trade=:trade, union_local=:union_local, classification=:classification, hire_date=:hire_date, active=:active, notes=:notes WHERE id=:id`).run({ ...e, id });
      if (!r.changes) throw new HttpError(404, 'Employee not found.');
      saveSkills(id, req.body.skills);
    });
    audit(req, 'update', 'employee', id, { name: `${e.first_name} ${e.last_name}` });
    res.json({ id });
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

  api.get('/projects', (req, res) => {
    const where = req.query.all === '1' ? '' : "WHERE p.status IN ('planned','active','on_hold')";
    res.json(db.prepare(`SELECT p.*, ${leadNames},
        (SELECT COALESCE(SUM(CASE WHEN a.status='no_show' THEN 0 ELSE COALESCE(a.actual_hours, a.planned_hours) END),0) FROM assignments a WHERE a.project_id = p.id AND a.approval_status = 'approved') AS hours_to_date,
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
      budget_hours: num(b.budget_hours), color: str(b.color, 20), notes: str(b.notes, 2000),
    };
    if (!p.job_number || !p.name) throw bad('Job number and project name are required.');
    if (!['planned', 'active', 'on_hold', 'complete'].includes(p.status)) throw bad('Invalid status.');
    if (Number.isNaN(p.budget_hours)) throw bad('Budget hours must be a number.');
    if (p.color && !/^#[0-9a-fA-F]{6}$/.test(p.color)) p.color = null;
    return p;
  }

  const uniqueMsg = (e, msg) => { if (/UNIQUE/.test(e.message)) throw bad(msg); throw e; };

  api.post('/projects', canSchedule, (req, res) => {
    const p = readProject(req.body);
    let r;
    try {
      r = db.prepare(`INSERT INTO projects (job_number, name, customer, address, superintendent_employee_id, project_manager_employee_id, status, start_date, end_date, budget_hours, color, notes)
        VALUES (:job_number, :name, :customer, :address, :superintendent_employee_id, :project_manager_employee_id, :status, :start_date, :end_date, :budget_hours, :color, :notes)`).run(p);
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
        status=:status, start_date=:start_date, end_date=:end_date, budget_hours=:budget_hours, color=:color, notes=:notes WHERE id=:id`).run({ ...p, id });
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

  // ---- weekly schedule ---------------------------------------------------------
  const assignmentSelect = `SELECT a.*, e.first_name, e.last_name, e.trade, e.classification,
      p.job_number, p.name AS project_name, p.color, p.superintendent_employee_id,
      cu.name AS requested_by_name, au.name AS approved_by_name
    FROM assignments a JOIN employees e ON e.id = a.employee_id JOIN projects p ON p.id = a.project_id
    LEFT JOIN users cu ON cu.id = a.created_by LEFT JOIN users au ON au.id = a.approved_by`;

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
    const approvedOnly = req.user.role === 'viewer';
    const assignments = db.prepare(`${assignmentSelect} WHERE a.work_date BETWEEN ? AND ? ${approvedOnly ? "AND a.approval_status = 'approved'" : ''}
      ORDER BY e.last_name, e.first_name, a.id`).all(start, end);
    const timeOff = db.prepare(`SELECT t.*, e.first_name, e.last_name FROM time_off t JOIN employees e ON e.id = t.employee_id
      WHERE t.off_date BETWEEN ? AND ?`).all(start, end);
    const projectIds = new Set(assignments.map((a) => a.project_id));
    const projects = db.prepare(`SELECT p.*, ${leadNames},
        (SELECT COALESCE(SUM(CASE WHEN a.status='no_show' THEN 0 ELSE COALESCE(a.actual_hours, a.planned_hours) END),0) FROM assignments a WHERE a.project_id = p.id AND a.work_date <= ? AND a.approval_status = 'approved') AS hours_through_week
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

    res.json({
      start, end, days, projects, assignments, time_off: timeOff,
      totals: { approval, hours: totalHours, assignments: assignments.length - approval.rejected, people: Object.keys(byEmployee).length, by_project: byProject, by_day: byDay, by_employee: byEmployee, over_day: overDay, warn_daily_hours: warnAt },
    });
  });

  api.get('/my-schedule', (req, res) => {
    if (!req.user.employee_id) return res.json({ linked: false, assignments: [] });
    const from = weekStart(new Date().toISOString().slice(0, 10));
    res.json({
      linked: true,
      assignments: db.prepare(`${assignmentSelect} WHERE a.employee_id = ? AND a.work_date >= ? AND a.approval_status = 'approved' ORDER BY a.work_date, a.id LIMIT 60`).all(req.user.employee_id, addDays(from, -7)),
      time_off: db.prepare('SELECT * FROM time_off WHERE employee_id = ? AND off_date >= ? ORDER BY off_date').all(req.user.employee_id, from),
    });
  });

  // ---- assignments (double-booking protected) -------------------------------------
  const findBookings = db.prepare(`SELECT a.id, a.project_id, a.planned_hours, p.job_number, p.name AS project_name
    FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.employee_id = ? AND a.work_date = ? AND a.approval_status <> 'rejected' ORDER BY a.id`);
  const findOff = db.prepare('SELECT reason FROM time_off WHERE employee_id = ? AND off_date = ?');
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
    });
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

  // ---- time off --------------------------------------------------------------------
  api.post('/time-off', canSchedule, (req, res) => {
    const eid = int(req.body.employee_id);
    if (!empName.get(eid)) throw bad('Pick an employee.');
    const dates = (Array.isArray(req.body.dates) ? req.body.dates : [req.body.off_date]).map((d) => date(d, 'Date', true));
    const reason = str(req.body.reason, 200);
    const conflicts = []; let added = 0;
    tx(db, () => {
      for (const d of dates) {
        const booked = findBookings.all(eid, d);
        if (booked.length) { conflicts.push(`${d}: scheduled on ${booked.map((b) => b.job_number).join(', ')}. Remove that first.`); continue; }
        added += db.prepare('INSERT OR IGNORE INTO time_off (employee_id, off_date, reason, created_by) VALUES (?, ?, ?, ?)').run(eid, d, reason, req.user.id).changes;
      }
    });
    audit(req, 'create', 'time_off', eid, { dates, reason });
    res.json({ added, conflicts });
  });
  api.delete('/time-off/:id', canSchedule, (req, res) => {
    db.prepare('DELETE FROM time_off WHERE id = ?').run(int(req.params.id));
    audit(req, 'delete', 'time_off', int(req.params.id));
    res.json({ ok: true });
  });

  // ---- hour verification -----------------------------------------------------------
  api.get('/verification', canSchedule, (req, res) => {
    const start = weekStart(date(req.query.start, 'start') || new Date().toISOString().slice(0, 10));
    const end = addDays(start, 6);
    const projectId = int(req.query.project_id);
    const rows = db.prepare(`${assignmentSelect} LEFT JOIN users v ON v.id = a.verified_by
      WHERE a.work_date BETWEEN ? AND ? AND a.approval_status = 'approved' ${projectId ? 'AND a.project_id = ?' : ''}
      ORDER BY p.job_number, a.work_date, e.last_name`).all(...[start, end, ...(projectId ? [projectId] : [])]);
    const verifierNames = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
    const summary = { planned: 0, actual: 0, verified_count: 0, pending_count: 0, no_show_count: 0, variance: 0 };
    for (const r of rows) {
      r.verified_by_name = verifierNames.get(r.verified_by) || null;
      summary.planned += r.planned_hours;
      if (r.status === 'scheduled') summary.pending_count += 1;
      else {
        summary.verified_count += 1;
        if (r.status === 'no_show') summary.no_show_count += 1;
        summary.actual += r.status === 'no_show' ? 0 : r.actual_hours ?? 0;
      }
    }
    const verifiedPlanned = rows.filter((r) => r.status !== 'scheduled').reduce((s, r) => s + r.planned_hours, 0);
    summary.variance = round2(summary.actual - verifiedPlanned);
    res.json({ start, end, rows, summary });
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
    } else if (status === 'no_show') actual = 0;
    const reset = status === 'scheduled';
    db.prepare(`UPDATE assignments SET actual_hours = ?, status = ?, verified_by = ?, verified_at = ${reset ? 'NULL' : "datetime('now')"},
      verify_note = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(actual, finalStatus, reset ? null : req.user.id, str(b.note, 500), id);
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
        { key: 'actual_hours', label: 'Actual Hrs' }, { key: 'status', label: 'Status' }, { key: 'approval_status', label: 'Approval' }, { key: 'reject_reason', label: 'Rejection Reason' }, { key: 'task', label: 'Task' },
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
    const start = weekStart(date(req.query.start, 'start') || new Date().toISOString().slice(0, 10));
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
      const wk = weekStart(c.work_date);
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
      settings: { ot_threshold_hours: Number(settings.ot_threshold_hours), ot_multiplier: Number(settings.ot_multiplier), default_burden_pct: Number(settings.default_burden_pct) },
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
    const cols = req.user.role === 'admin' ? 'u.id, u.username, u.name, u.role, u.can_view_payroll, u.employee_id, u.active, u.created_at' : 'u.id, u.name, u.role';
    res.json(db.prepare(`SELECT ${cols} FROM users u WHERE u.active = 1 OR ? ORDER BY u.name`).all(req.user.role === 'admin' ? 1 : 0));
  });

  function readUser(b, isNew) {
    const u = {
      username: str(b.username, 100), name: str(b.name, 200), role: str(b.role, 20) || 'viewer',
      can_view_payroll: bool(b.can_view_payroll), employee_id: int(b.employee_id), active: b.active === undefined ? 1 : bool(b.active),
    };
    if (!u.username || !u.name) throw bad('Username and name are required.');
    if (!['admin', 'super', 'viewer'].includes(u.role)) throw bad('Invalid role.');
    const pw = b.password ? String(b.password) : '';
    if ((isNew || pw) && pw.length < 8) throw bad('Password must be at least 8 characters.');
    return { u, pw };
  }

  api.post('/users', adminOnly, (req, res) => {
    const { u, pw } = readUser(req.body, true);
    let r;
    try {
      r = db.prepare(`INSERT INTO users (username, name, password_hash, role, can_view_payroll, employee_id, active)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(u.username, u.name, auth.hashPassword(pw), u.role, u.can_view_payroll, u.employee_id, u.active);
    } catch (e) { uniqueMsg(e, 'That username is taken.'); }
    audit(req, 'create', 'user', Number(r.lastInsertRowid), { username: u.username, role: u.role });
    res.json({ id: Number(r.lastInsertRowid) });
  });

  api.put('/users/:id', adminOnly, (req, res) => {
    const id = int(req.params.id);
    const { u, pw } = readUser(req.body, false);
    if (id === req.user.id && (u.role !== 'admin' || !u.active)) throw bad('You cannot remove your own admin access.');
    try {
      db.prepare(`UPDATE users SET username=?, name=?, role=?, can_view_payroll=?, employee_id=?, active=? WHERE id=?`)
        .run(u.username, u.name, u.role, u.can_view_payroll, u.employee_id, u.active, id);
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
    const allowed = ['company_name', 'ot_threshold_hours', 'ot_multiplier', 'default_burden_pct', 'default_hours', 'max_daily_hours', 'warn_daily_hours'];
    const up = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
    for (const k of allowed) if (req.body[k] !== undefined && req.body[k] !== null && String(req.body[k]).trim() !== '') up.run(String(req.body[k]).trim().slice(0, 200), k);
    audit(req, 'update', 'settings', null, req.body);
    res.json(getSettings(db));
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
