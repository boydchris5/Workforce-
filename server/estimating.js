'use strict';
// Estimating module: possible bids (leads), the Go / No-Go scorecard and the decision.
// Definitions follow the Opportunity & Bid History Tracker plan (Phase 1, approved Nov 19 2026).

const STATUSES = ['Lead', 'Not started', 'In progress', 'Submitted', 'Won', 'Lost', 'No award', 'Cancelled', 'Rebid', 'Passed'];
const SECTORS = ['Public – CDB', 'Public – K-12', 'Public – Higher Ed (non-CDB)', 'Public – Municipal/County', 'Healthcare – Hospital',
  'Healthcare – Medical Office/Clinic', 'Private – Industrial', 'Private – Commercial'];
const DELIVERY = ['Public hard bid', 'Private invite bid', 'Negotiated', 'Design-build', 'Budget / precon'];
const NOBID_REASONS = ['Capacity', 'Territory', 'Size fit', 'Risk / terms (LDs, schedule)', "Low odds (crowded or another GC's owner)", 'Sub coverage'];
const SOURCES = ['bids@ invite', 'SharePoint folder', 'SIBA / plan room', 'Owner or architect call', 'Public ad', 'Word of mouth', 'Other'];

// Draft scorecard from the whiteboard (Nov 20 2026). Weights are tuned in Admin; the score is the
// share of available points earned, so it stays 0–100 whatever the weights add up to.
const DEFAULT_SCORECARD = {
  questions: [
    { key: 'territory', label: 'Territory', weight: 15, gate: true, reason: 'Territory',
      good: 'Illinois south of I-64, or Jackson / Cape Girardeau, MO', poor: 'Elsewhere in MO, IN or KY, or north of I-64' },
    { key: 'size', label: 'Size & bonding', weight: 10, gate: true, reason: 'Size fit',
      good: 'Inside our size bands and bonding capacity', poor: 'Too small to carry general conditions, or over bonding' },
    { key: 'sector', label: 'Sector & self-perform', weight: 15, reason: "Low odds (crowded or another GC's owner)",
      good: 'A sector we win (K-12, CDB, healthcare) with real self-perform scope', poor: 'Unfamiliar sector, everything subbed' },
    { key: 'capacity', label: 'Capacity', weight: 15, reason: 'Capacity',
      good: 'Estimator open that week, no other bid due within 2 days, nobody out', poor: 'Two or more bids that week, or the key estimator is off' },
    { key: 'risk', label: 'Risk & terms', weight: 20, reason: 'Risk / terms (LDs, schedule)',
      good: 'Normal LDs and schedule, complete documents, known wage / DBE / VBP rules', poor: 'Heavy LDs, compressed schedule, weak documents, thin sub coverage' },
    { key: 'odds', label: 'Odds to win', weight: 20, reason: "Low odds (crowded or another GC's owner)",
      good: "Owner or architect we've won with, 4 or fewer bidders, good record vs. the likely field", poor: "Another GC's owner, crowded field, we usually lose" },
  ],
  go_at: 75,
  review_at: 50,
};
const RATING = { good: 1, ok: 0.5, poor: 0 };

// Score a set of ratings. Unrated questions earn nothing, so a partial card reads low until finished.
function scoreCard(cfg, ratings) {
  const r = ratings || {};
  let earned = 0; let total = 0; let rated = 0; let gate = null; let worst = null;
  for (const q of cfg.questions) {
    const w = Number(q.weight) || 0;
    total += w;
    if (!(r[q.key] in RATING)) continue;
    rated += 1;
    const v = RATING[r[q.key]];
    earned += w * v;
    if (q.gate && r[q.key] === 'poor' && !gate) gate = q;
    const lost = w * (1 - v);
    if (lost > 0 && (!worst || lost > worst.lost)) worst = { q, lost };
  }
  const score = total ? Math.round((earned / total) * 100) : 0;
  const complete = rated === cfg.questions.length;
  let suggestion = null;
  if (gate) suggestion = 'no_go';
  else if (complete) suggestion = score >= cfg.go_at ? 'go' : score >= cfg.review_at ? 'review' : 'no_go';
  const why = gate || (worst && worst.q) || null;
  return { score, rated, of: cfg.questions.length, complete, suggestion, gate: gate ? gate.key : null, reason: why ? why.reason : null };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS est_bids (
  id INTEGER PRIMARY KEY,
  project TEXT NOT NULL,
  owner TEXT,
  architect TEXT,
  location TEXT,
  sector TEXT,
  delivery TEXT,
  est_value REAL,
  value_label TEXT,
  bid_date TEXT,
  bid_time TEXT,
  source TEXT,
  folder_key TEXT,
  folder_uri TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Lead',
  scorecard TEXT,
  decision TEXT CHECK (decision IN ('go','no_go')),
  decision_score INTEGER,
  decision_reason TEXT,
  decision_note TEXT,
  decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_est_bids_status ON est_bids(status, bid_date);
`;

function getConfig(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'est_scorecard'").get();
  if (!row) return DEFAULT_SCORECARD;
  try {
    const saved = JSON.parse(row.value);
    // Keep the question text from the code; only weights and cut-offs are tuned in Admin.
    return {
      questions: DEFAULT_SCORECARD.questions.map((q) => ({ ...q, weight: Number.isFinite(saved.weights?.[q.key]) ? saved.weights[q.key] : q.weight })),
      go_at: Number.isFinite(saved.go_at) ? saved.go_at : DEFAULT_SCORECARD.go_at,
      review_at: Number.isFinite(saved.review_at) ? saved.review_at : DEFAULT_SCORECARD.review_at,
    };
  } catch { return DEFAULT_SCORECARD; }
}

// Bid board data store. The board page (public/estimating/board.html) was first built as a Claude
// artifact and keeps its document model: collections of JSON documents (bids, deadlines, ignored) and a
// few single documents (config/*). Two documents are built live from the app instead of stored:
// config/team (everyone in the Estimating and Pre-Con departments) and timeoff/current (their time off).
const STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS est_docs (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (coll, id)
);`;
const COLLECTIONS = new Set(['bids', 'deadlines', 'ignored']);
const CONFIG_DOCS = new Set(['sharepoint', 'holidays', 'competitors', 'sync', 'team']);
const EST_DEPTS = ['estimating', 'pre-con', 'precon', 'preconstruction', 'pre-construction'];
const ID_RE = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
const MAX_DOC = 256 * 1024;

// Estimating is for office logins only: the Workforce Manager, Office Staff and the Office Manager.
const canEstimateUser = (u) => !!u && ['admin', 'office', 'office_admin'].includes(u.role);

function mountEstimating(api, db, h) {
  const { audit, bad, num, int, HttpError, adminOnly } = h;
  db.exec(SCHEMA);
  db.exec(STORE_SCHEMA);
  migrateLeads(db);
  const canEstimate = (req, res, next) => (canEstimateUser(req.user) ? next() : res.status(403).json({ error: 'Estimating is for office staff.' }));

  const getDoc = db.prepare('SELECT data FROM est_docs WHERE coll = ? AND id = ?');
  const putDoc = db.prepare(`INSERT INTO est_docs (coll, id, data, updated_by, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (coll, id) DO UPDATE SET data = excluded.data, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
  const read = (coll, id) => { const r = getDoc.get(coll, id); return r ? JSON.parse(r.data) : null; };
  const write = (req, coll, id, data) => {
    const text = JSON.stringify(data);
    if (text.length > MAX_DOC) throw new HttpError(413, 'That document is too large.');
    putDoc.run(coll, id, text, req.user ? req.user.id : null);
  };
  const body = (req) => {
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw bad('Send a JSON object.');
    return b;
  };
  const checkId = (id) => { if (!ID_RE.test(String(id || ''))) throw bad('Invalid document id.'); return String(id); };
  // Which stored document a path names: collections/<id> or config/<name> or timeoff/current.
  function target(coll, id) {
    checkId(id);
    if (COLLECTIONS.has(coll)) return [coll, id];
    if (coll === 'config' && CONFIG_DOCS.has(id)) return ['config', id];
    if (coll === 'timeoff' && id === 'current') return ['timeoff', id];
    throw new HttpError(404, 'Unknown board document.');
  }

  // Estimators: the board's saved list first (keeps each person's badge colour), then anyone else in
  // the Estimating / Pre-Con departments, so a new estimator shows up without any setup.
  function liveTeam() {
    const people = db.prepare("SELECT first_name, last_name, department FROM employees WHERE active = 1 AND employee_type IN ('staff','project_manager') ORDER BY last_name, first_name").all()
      .filter((e) => EST_DEPTS.includes(String(e.department || '').trim().toLowerCase())).map((e) => `${e.first_name} ${e.last_name}`);
    const saved = (read('config', 'team')?.estimators || []).map((e) => e.name).filter(Boolean);
    const names = saved.slice();
    for (const n of people) if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    return { estimators: names.map((name) => ({ name })) };
  }
  function liveTimeOff() {
    const t = new Date();
    const start = new Date(t.getTime() - 45 * 864e5).toISOString().slice(0, 10);
    const end = new Date(t.getTime() + 350 * 864e5).toISOString().slice(0, 10);
    const days = db.prepare(`SELECT t.off_date AS date, e.first_name, e.last_name, e.department, t.reason AS type, t.hours, t.status
      FROM time_off t JOIN employees e ON e.id = t.employee_id
      WHERE t.status IN ('approved','pending') AND t.off_date BETWEEN ? AND ? AND e.active = 1 ORDER BY t.off_date`).all(start, end)
      .filter((r) => EST_DEPTS.includes(String(r.department || '').trim().toLowerCase()))
      .map((r) => ({ date: r.date, name: `${r.first_name} ${r.last_name}`, type: r.type || '', hours: Number(r.hours) || 8, status: r.status }));
    return { days, start, end, departments: 'Estimating,Pre-Con', fetchedAt: new Date().toISOString(), source: 'FM Workforce' };
  }

  api.get('/estimating/config', canEstimate, (_req, res) => {
    res.json({ scorecard: getConfig(db), statuses: STATUSES, sectors: SECTORS, delivery: DELIVERY, nobid_reasons: NOBID_REASONS, sources: SOURCES });
  });

  api.put('/estimating/config', adminOnly, (req, res) => {
    const b = req.body || {};
    const weights = {};
    for (const q of DEFAULT_SCORECARD.questions) {
      const w = num(b.weights?.[q.key]);
      if (w === null || Number.isNaN(w) || w < 0 || w > 100) throw bad(`${q.label} weight must be 0–100.`);
      weights[q.key] = w;
    }
    if (!Object.values(weights).some((w) => w > 0)) throw bad('At least one question needs a weight.');
    const goAt = int(b.go_at); const reviewAt = int(b.review_at);
    if (goAt === null || reviewAt === null || reviewAt < 0 || goAt > 100 || reviewAt >= goAt) throw bad('Cut-offs: "your call" must start below "suggested Go", both 0–100.');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('est_scorecard', ?)").run(JSON.stringify({ weights, go_at: goAt, review_at: reviewAt }));
    audit(req, 'update', 'est_scorecard', null, { weights, go_at: goAt, review_at: reviewAt });
    res.json(getConfig(db));
  });

  // ---- the board's document store ----
  api.get('/estimating/store/:coll', canEstimate, (req, res) => {
    const { coll } = req.params;
    if (!COLLECTIONS.has(coll)) throw new HttpError(404, 'Unknown board collection.');
    res.json(db.prepare('SELECT id, data FROM est_docs WHERE coll = ? ORDER BY id').all(coll).map((r) => ({ id: r.id, data: JSON.parse(r.data) })));
  });
  api.get('/estimating/store/:coll/:id', canEstimate, (req, res) => {
    const [coll, id] = target(req.params.coll, req.params.id);
    if (coll === 'config' && id === 'team') return res.json({ id, data: liveTeam() });
    if (coll === 'timeoff') return res.json({ id, data: liveTimeOff() });
    res.json({ id, data: read(coll, id) });
  });
  api.put('/estimating/store/:coll/:id', canEstimate, (req, res) => {
    const [coll, id] = target(req.params.coll, req.params.id);
    if (coll === 'timeoff') return res.json({ id }); // built from the app's time off; nothing to store
    write(req, coll, id, body(req));
    if (coll === 'bids') audit(req, read(coll, id) ? 'save' : 'create', 'est_bid', null, { id, project: req.body.project });
    res.json({ id });
  });
  api.patch('/estimating/store/:coll/:id', canEstimate, (req, res) => {
    const [coll, id] = target(req.params.coll, req.params.id);
    if (coll === 'timeoff') return res.json({ id });
    const cur = read(coll, id);
    if (!cur) throw new HttpError(404, 'That item is no longer on the board.');
    const patch = body(req);
    write(req, coll, id, { ...cur, ...patch });
    if (coll === 'bids' && ('status' in patch || 'decision' in patch)) audit(req, 'update', 'est_bid', null, { id, status: patch.status, decision: patch.decision });
    res.json({ id });
  });
  api.post('/estimating/store/:coll', canEstimate, (req, res) => {
    const { coll } = req.params;
    if (!COLLECTIONS.has(coll)) throw new HttpError(404, 'Unknown board collection.');
    const id = require('node:crypto').randomBytes(10).toString('base64url');
    write(req, coll, id, body(req));
    res.json({ id });
  });
  api.delete('/estimating/store/:coll/:id', canEstimate, (req, res) => {
    const [coll, id] = target(req.params.coll, req.params.id);
    const cur = read(coll, id);
    db.prepare('DELETE FROM est_docs WHERE coll = ? AND id = ?').run(coll, id);
    if (coll === 'bids' && cur) audit(req, 'delete', 'est_bid', null, { id, project: cur.project });
    res.json({ id });
  });

  // One-time load of the Claude bid board's data: { docs: [{ coll, id, data }] }. Existing documents
  // with the same id are replaced, so running it again is safe.
  api.post('/estimating/import', adminOnly, (req, res) => {
    const docs = Array.isArray(req.body?.docs) ? req.body.docs : null;
    if (!docs || !docs.length) throw bad('Nothing to import.');
    const counts = {};
    db.exec('BEGIN');
    try {
      for (const d of docs) {
        const [coll, id] = target(String(d.coll || ''), d.id);
        if (coll === 'timeoff') continue;
        if (!d.data || typeof d.data !== 'object' || Array.isArray(d.data)) throw bad(`Document ${coll}/${id} has no data.`);
        write(req, coll, id, d.data);
        counts[coll] = (counts[coll] || 0) + 1;
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    audit(req, 'import', 'est_board', null, counts);
    res.json({ imported: counts });
  });
}

// Possible bids saved by the first Estimating screen (#43) move onto the board as Lead / Not started /
// Passed bids, keeping their scorecard and decision.
function migrateLeads(db) {
  const rows = db.prepare('SELECT b.*, u.name AS decided_by_name FROM est_bids b LEFT JOIN users u ON u.id = b.decided_by').all();
  if (!rows.length) return;
  const ins = db.prepare('INSERT OR IGNORE INTO est_docs (coll, id, data) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      let ratings = {}; try { ratings = JSON.parse(r.scorecard || '{}').ratings || {}; } catch { ratings = {}; }
      const data = {
        id: '', project: r.project, owner: r.owner || '', architect: r.architect || '', location: r.location || '', sector: r.sector || '', delivery: r.delivery || '',
        bid_date: r.bid_date || '', bid_time: r.bid_time || '', published_ceiling: r.est_value, value_label: r.value_label || (r.est_value ? `$${Math.round(r.est_value).toLocaleString('en-US')}` : 'Not published'),
        source: r.source || '', notes: r.notes || '', status: r.status, team: [], estimator: '', scorecard: { ratings },
        decision: r.decision, decision_score: r.decision_score, decision_note: r.decision_note || '', decided_by: r.decided_by_name || '', decided_at: r.decided_at ? `${r.decided_at.replace(' ', 'T')}Z` : '',
        nobid_reason: r.decision === 'no_go' ? r.decision_reason || '' : '', nobid_by: r.decision === 'no_go' ? r.decided_by_name || '' : '',
      };
      ins.run('bids', `APP-${r.id}`, JSON.stringify(data));
    }
    db.exec('DELETE FROM est_bids');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { mountEstimating, scoreCard, canEstimateUser, DEFAULT_SCORECARD, STATUSES, NOBID_REASONS };
