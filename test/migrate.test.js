'use strict';
// A database already at the previous schema version must still pick up new columns on startup.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../server/db');

test('a v13 database without users.can_estimate is upgraded on open', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mig-')), 't.db');
  db.open(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE users DROP COLUMN can_estimate; PRAGMA user_version = 13;');
  raw.close();
  const conn = db.open(file);
  const cols = conn.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('can_estimate'));
  assert.equal(conn.prepare('PRAGMA user_version').get().user_version, 14);
  conn.close();
});
