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

function mountEstimating(api, db, h) {
  const { audit, bad, str, num, int, date, HttpError, adminOnly } = h;
  db.exec(SCHEMA);
  const canEstimate = (req, res, next) => (req.user && (req.user.role === 'admin' || req.user.can_estimate)
    ? next() : res.status(403).json({ error: 'You do not have access to Estimating.' }));

  const pick = (v, list, field) => {
    const s = str(v, 120);
    if (s && !list.includes(s)) throw bad(`${field} is not one of the choices.`);
    return s;
  };
  function readBid(b) {
    const out = {
      project: str(b.project, 200), owner: str(b.owner, 200), architect: str(b.architect, 200), location: str(b.location, 200),
      sector: pick(b.sector, SECTORS, 'Sector'), delivery: pick(b.delivery, DELIVERY, 'Delivery'),
      est_value: num(b.est_value), value_label: str(b.value_label, 120),
      bid_date: date(b.bid_date, 'Bid date'), bid_time: str(b.bid_time, 30), source: str(b.source, 120), notes: str(b.notes, 2000),
    };
    if (!out.project) throw bad('Project name is required.');
    if (Number.isNaN(out.est_value) || (out.est_value !== null && out.est_value < 0)) throw bad('Estimated value must be a dollar amount.');
    return out;
  }
  const FIELDS = ['project', 'owner', 'architect', 'location', 'sector', 'delivery', 'est_value', 'value_label', 'bid_date', 'bid_time', 'source', 'notes'];

  const listSql = `SELECT b.*, du.name AS decided_by_name, cu.name AS created_by_name
    FROM est_bids b LEFT JOIN users du ON du.id = b.decided_by LEFT JOIN users cu ON cu.id = b.created_by`;
  function shape(row, cfg) {
    let ratings = {};
    try { ratings = row.scorecard ? JSON.parse(row.scorecard).ratings || {} : {}; } catch { ratings = {}; }
    return { ...row, scorecard: undefined, ratings, score: scoreCard(cfg, ratings) };
  }
  const getBid = (id) => {
    const row = db.prepare(`${listSql} WHERE b.id = ?`).get(id);
    if (!row) throw new HttpError(404, 'That bid was not found.');
    return row;
  };

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

  // view: leads (undecided), go, no_go, all
  api.get('/estimating/bids', canEstimate, (req, res) => {
    const cfg = getConfig(db);
    const view = String(req.query.view || 'all');
    const where = { leads: "WHERE b.status = 'Lead'", go: "WHERE b.decision = 'go'", no_go: "WHERE b.decision = 'no_go'" }[view] || '';
    const rows = db.prepare(`${listSql} ${where} ORDER BY COALESCE(b.bid_date, '9999-12-31'), b.project`).all();
    res.json(rows.map((r) => shape(r, cfg)));
  });

  api.post('/estimating/bids', canEstimate, (req, res) => {
    const b = readBid(req.body || {});
    const r = db.prepare(`INSERT INTO est_bids (${FIELDS.join(', ')}, status, created_by) VALUES (${FIELDS.map(() => '?').join(', ')}, 'Lead', ?)`)
      .run(...FIELDS.map((f) => b[f]), req.user.id);
    const id = Number(r.lastInsertRowid);
    audit(req, 'create', 'est_bid', id, { project: b.project });
    res.json(shape(getBid(id), getConfig(db)));
  });

  api.put('/estimating/bids/:id', canEstimate, (req, res) => {
    const id = int(req.params.id); getBid(id);
    const b = readBid(req.body || {});
    db.prepare(`UPDATE est_bids SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...FIELDS.map((f) => b[f]), id);
    audit(req, 'update', 'est_bid', id, { project: b.project });
    res.json(shape(getBid(id), getConfig(db)));
  });

  api.put('/estimating/bids/:id/scorecard', canEstimate, (req, res) => {
    const id = int(req.params.id); getBid(id);
    const cfg = getConfig(db);
    const ratings = {};
    for (const q of cfg.questions) {
      const v = req.body?.ratings?.[q.key];
      if (v === undefined || v === null || v === '') continue;
      if (!(v in RATING)) throw bad(`${q.label}: rate it good, ok or poor.`);
      ratings[q.key] = v;
    }
    db.prepare("UPDATE est_bids SET scorecard = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify({ ratings }), id);
    res.json(shape(getBid(id), cfg));
  });

  // decision: go -> Not started (on the bid board) · no_go -> Passed with a reason · undecided -> back to Lead
  api.post('/estimating/bids/:id/decision', canEstimate, (req, res) => {
    const id = int(req.params.id); const row = getBid(id);
    const cfg = getConfig(db);
    const decision = String(req.body?.decision || '');
    const note = str(req.body?.note, 500);
    const sc = shape(row, cfg).score;
    if (decision === 'undecided') {
      if (row.status !== 'Lead' && row.status !== 'Not started' && row.status !== 'Passed') throw bad('This bid is already being worked or has a result. Change its status instead.');
      db.prepare(`UPDATE est_bids SET status = 'Lead', decision = NULL, decision_score = NULL, decision_reason = NULL, decision_note = NULL,
        decided_by = NULL, decided_at = NULL, updated_at = datetime('now') WHERE id = ?`).run(id);
    } else if (decision === 'go' || decision === 'no_go') {
      let reason = null;
      if (decision === 'no_go') {
        reason = str(req.body?.reason, 120) || sc.reason;
        if (!reason || !NOBID_REASONS.includes(reason)) throw bad('Pick why we are passing.');
      }
      db.prepare(`UPDATE est_bids SET status = ?, decision = ?, decision_score = ?, decision_reason = ?, decision_note = ?,
        decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(decision === 'go' ? 'Not started' : 'Passed', decision, sc.rated ? sc.score : null, reason, note, req.user.id, id);
    } else throw bad('Decision must be go, no_go or undecided.');
    audit(req, 'decide', 'est_bid', id, { decision, score: sc.score, suggestion: sc.suggestion });
    res.json(shape(getBid(id), cfg));
  });

  api.delete('/estimating/bids/:id', adminOnly, (req, res) => {
    const id = int(req.params.id); const row = getBid(id);
    db.prepare('DELETE FROM est_bids WHERE id = ?').run(id);
    audit(req, 'delete', 'est_bid', id, { project: row.project });
    res.json({ ok: true });
  });
}

module.exports = { mountEstimating, scoreCard, DEFAULT_SCORECARD, STATUSES, NOBID_REASONS };
