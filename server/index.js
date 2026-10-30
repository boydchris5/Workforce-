'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const auth = require('./auth');
const { createApp } = require('./app');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'workforce.db');
const PORT = Number(process.env.PORT) || 3000;

const conn = db.open(DB_FILE);

// First run: create the workforce manager's admin login.
if (!conn.prepare('SELECT COUNT(*) AS n FROM users').get().n) {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  conn.prepare(`INSERT INTO users (username, name, password_hash, role, can_view_payroll) VALUES (?, ?, ?, 'admin', 1)`)
    .run(username, 'Workforce Manager', auth.hashPassword(password));
  console.log('──────────────────────────────────────────────');
  console.log(` First-run admin account created`);
  console.log(`   username: ${username}`);
  if (!process.env.ADMIN_PASSWORD) console.log(`   password: ${password}   (change it after signing in)`);
  console.log('──────────────────────────────────────────────');
}

const app = createApp(conn, { secureCookies: process.env.NODE_ENV === 'production' });
app.listen(PORT, () => console.log(`Workforce Scheduler running on http://localhost:${PORT}  (db: ${DB_FILE})`));
