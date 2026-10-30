'use strict';
// Loads demo data so the app can be tried out. Usage: npm run seed
// Refuses to run against a database that already has employees.
const path = require('node:path');
const db = require('./db');
const auth = require('./auth');
const { weekStart, addDays } = require('./dates');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'workforce.db');
const conn = db.open(DB_FILE);
if (conn.prepare('SELECT COUNT(*) AS n FROM employees').get().n) {
  console.error('Database already has employees – seed skipped.');
  process.exit(1);
}

const pw = process.env.DEMO_PASSWORD || 'changeme123';
const user = (username, name, role, payroll = 0) => {
  conn.prepare('INSERT OR IGNORE INTO users (username, name, password_hash, role, can_view_payroll) VALUES (?, ?, ?, ?, ?)')
    .run(username, name, auth.hashPassword(pw), role, payroll);
  return conn.prepare('SELECT id FROM users WHERE username = ?').get(username).id;
};

db.tx(conn, () => {
  user('admin', 'Workforce Manager', 'admin', 1);
  const s1 = user('mjones', 'Mike Jones', 'super');
  const s2 = user('tgarcia', 'Tony Garcia', 'super');

  const projects = [
    ['24-101', 'Riverside Elementary Addition', 'USD 259', '1200 River Rd', s1, 6500, '#F15A22'],
    ['24-115', 'Hwy 54 Bridge Rehab', 'KDOT', 'US-54 & K-96', s2, 9200, '#2D2D2D'],
    ['25-007', 'Medical Office Building', 'Ascension', '8800 E 21st St N', s1, 4800, '#F7935F'],
    ['25-012', 'Water Treatment Plant Clarifier', 'City', '2201 N Hydraulic', s2, 7200, '#6B6B6B'],
  ];
  const pid = projects.map((p) => Number(conn.prepare(`INSERT INTO projects (job_number, name, customer, address, superintendent_user_id, status, budget_hours, color, start_date)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(...p.slice(0, 5), p[5], p[6], addDays(weekStart(new Date().toISOString().slice(0, 10)), -56)).lastInsertRowid));

  const skills = ['OSHA 10', 'OSHA 30', 'Forklift', 'Aerial Lift', 'Crane Signal Person', 'Rigging', 'Welding Cert', 'First Aid/CPR', 'Confined Space', 'Concrete Finishing'];
  for (const s of skills) conn.prepare('INSERT OR IGNORE INTO skills (name) VALUES (?)').run(s);
  const skillId = (n) => conn.prepare('SELECT id FROM skills WHERE name = ?').get(n).id;

  const people = [
    ['Dan', 'Miller', 'Carpenter', '1445', 'General Foreman', 52.1, 24.5, ['OSHA 30', 'First Aid/CPR', 'Aerial Lift']],
    ['Luis', 'Hernandez', 'Carpenter', '1445', 'Foreman', 49.5, 24.5, ['OSHA 30', 'Forklift']],
    ['Kyle', 'Brooks', 'Carpenter', '1445', 'Journeyman', 45.8, 24.5, ['OSHA 10', 'Aerial Lift']],
    ['Sam', 'Patel', 'Carpenter', '1445', 'Apprentice 2nd yr', 27.5, 15.2, ['OSHA 10']],
    ['Jose', 'Ramirez', 'Laborer', '1290', 'Foreman', 38.9, 18.75, ['OSHA 30', 'Confined Space']],
    ['Ben', 'Carter', 'Laborer', '1290', 'Laborer Group 1', 33.4, 18.75, ['OSHA 10', 'Confined Space']],
    ['Eli', 'Watson', 'Laborer', '1290', 'Laborer Group 1', 33.4, 18.75, ['OSHA 10']],
    ['Marcus', 'Lee', 'Cement Mason', '518', 'Journeyman', 42.0, 20.1, ['Concrete Finishing', 'OSHA 10']],
    ['Ray', 'Thompson', 'Operating Engineer', '101', 'Operator', 48.75, 26.3, ['Crane Signal Person', 'Rigging', 'OSHA 30']],
    ['Nate', 'Young', 'Ironworker', '10', 'Journeyman', 46.2, 30.4, ['Rigging', 'Welding Cert', 'OSHA 10']],
    ['Chris', 'Diaz', 'Ironworker', '10', 'Apprentice 3rd yr', 32.3, 22.0, ['Welding Cert']],
    ['Aaron', 'King', 'Millwright', '1529', 'Journeyman', 47.9, 25.6, ['Rigging', 'Aerial Lift']],
  ];
  const eid = people.map(([f, l, trade, local, cls, base, fringe, sk], i) => {
    const id = Number(conn.prepare(`INSERT INTO employees (employee_no, first_name, last_name, phone, trade, union_local, classification, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(String(1001 + i), f, l, `316-555-${String(1100 + i * 7)}`, trade, local, cls).lastInsertRowid);
    // Current rate plus last year's rate, to show rate history.
    const juneFirst = `${new Date().getFullYear()}-06-01`;
    conn.prepare('INSERT INTO employee_pay_rates (employee_id, effective_date, base_rate, fringe_rate, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, `${new Date().getFullYear() - 1}-06-01`, Math.round(base * 0.96 * 100) / 100, Math.round(fringe * 0.95 * 100) / 100, 'Prior agreement');
    conn.prepare('INSERT INTO employee_pay_rates (employee_id, effective_date, base_rate, fringe_rate, note) VALUES (?, ?, ?, ?, ?)')
      .run(id, juneFirst, base, fringe, 'June 1 union increase');
    for (const s of sk) conn.prepare('INSERT INTO employee_skills (employee_id, skill_id) VALUES (?, ?)').run(id, skillId(s));
    return id;
  });

  // Crews per project, scheduled last week, this week, and next week (Mon–Fri).
  const crews = [[0, 2, 3, 5], [8, 9, 10, 6], [1, 7, 4], [11]];
  const thisWeek = weekStart(new Date().toISOString().slice(0, 10));
  const ins = conn.prepare(`INSERT OR IGNORE INTO assignments (employee_id, project_id, work_date, planned_hours, start_time, status, actual_hours, verified_at)
    VALUES (?, ?, ?, ?, '07:00', ?, ?, ?)`);
  for (const wk of [-7, 0, 7]) {
    for (let d = 0; d < 5; d++) {
      const day = addDays(thisWeek, wk + d);
      crews.forEach((crew, pi) => crew.forEach((ei) => {
        const hrs = pi === 1 ? 10 : 8;
        const past = wk < 0;
        ins.run(eid[ei], pid[pi], day, hrs, past ? 'verified' : 'scheduled', past ? hrs : null, past ? day + ' 16:00:00' : null);
      }));
    }
  }

  // Split-day example: next Wednesday the millwright works the morning at the
  // plant and the afternoon at the medical office building.
  const splitDay = addDays(thisWeek, 9);
  conn.prepare("UPDATE assignments SET planned_hours = 4, task = 'Clarifier drive alignment' WHERE employee_id = ? AND work_date = ?").run(eid[11], splitDay);
  conn.prepare(`INSERT INTO assignments (employee_id, project_id, work_date, planned_hours, start_time, task)
    VALUES (?, ?, ?, 4, '11:30', 'Set rooftop unit curbs')`).run(eid[11], pid[2], splitDay);
});

console.log(`Demo data loaded into ${DB_FILE}`);
console.log(`Logins (password "${pw}"): admin (manager, payroll), mjones / tgarcia (superintendents)`);
