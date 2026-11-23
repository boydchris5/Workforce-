(function () {
  // One board, three pages: ?view=schedule (bid calendar + bid schedule), gng (possible bids / Go-No-Go),
  // history (bid results & history). ?bid=<id> opens the schedule on that bid's card.
  const QS = new URLSearchParams(location.search);
  const VIEW = ['schedule', 'gng', 'history'].includes(QS.get('view')) ? QS.get('view') : 'schedule';
  let pendingJump = VIEW === 'schedule' ? QS.get('bid') : null;
  document.body.dataset.view = VIEW;
  { const T = { schedule: ['Bid Board Schedule', 'Bid calendar and bid schedule'], gng: ['Go / No-Go', 'Possible bids and the Go / No-Go scorecard'], history: ['Bid Results & History', 'Results, win rates, sectors and competitors'] }[VIEW];
    const h = document.querySelector('header.brand h1'); if (h) h.textContent = T[0];
    const m = document.querySelector('header.brand .meta'); if (m) m.textContent = 'Estimating · ' + T[1] + ' · Shared with the estimating team';
    document.title = T[0] + ' – FM Bid Board'; }
  const S = { showFinished: false, plOpen: null, pf: { year: String(new Date().getFullYear()), reason: 'all', sector: 'all', who: 'all' }, expanded: new Set(), ignored: new Set(), bids: [], deadlines: [], team: { estimators: [] }, sp: { folders: [] }, sync: null, filter: 'all', types: new Set(['bid', 'lead', 'pre', 'must', 'q', 'int', 'sent', 'off']), timeoff: null, editing: null, confirmDel: null, undo: null, canWrite: true, db: null, loaded: false, spFolders: null };
  const STATUSES = ['Lead', 'Not started', 'In progress', 'Submitted', 'Won', 'Lost', 'No award', 'Cancelled', 'Rebid', 'Passed'];
  const LEGACY = { 'Docs received': 'Not started', 'Concept': 'Not started', 'Estimating': 'In progress', 'Updating prior estimate': 'In progress', 'Bid forms executed': 'In progress', 'No bid': 'Passed' };
  const SECTORS = ['Public – CDB', 'Public – K-12', 'Public – Higher Ed (non-CDB)', 'Public – Municipal/County', 'Healthcare – Hospital', 'Healthcare – Medical Office/Clinic', 'Private – Industrial', 'Private – Commercial', 'Private – Religious'];
  const DELIVERY = ['Public hard bid', 'Private invite bid', 'Negotiated', 'Design-build', 'Budget / precon'];
  const LOSS_REASONS = ['Price – within 3%', 'Price – more than 3%', 'Qualifications / scope', 'Owner chose another firm (not price)', 'Over budget / no award', 'Unknown'];
  const NOBID_REASONS = ['Capacity', 'Territory', 'Size fit', 'Risk / terms (LDs, schedule)', 'Low odds (crowded or another GC\'s owner)', 'Sub coverage'];
  const RESULT_ST = new Set(['Submitted', 'Won', 'Lost', 'No award', 'Cancelled', 'Rebid']);
  const FINAL_ST = new Set(['Won', 'Lost', 'No award', 'Cancelled', 'Rebid']);
  const KEEP_ST = new Set(['Submitted', 'Won', 'Lost', 'No award', 'Cancelled', 'Rebid', 'Passed']);
  const sizeBand = (v) => !(v > 0) ? '' : v < 250000 ? '<$250K' : v < 1e6 ? '$250K–$1M' : v < 5e6 ? '$1M–$5M' : v < 15e6 ? '$5M–$15M' : '$15M+';
  const statusOf = (b) => LEGACY[b.status] || (STATUSES.includes(b.status) ? b.status : 'Not started');
  const parseMoney = (v) => { const t = String(v || '').trim().toLowerCase().replace(/[$,\s]/g, ''); if (!t) return null; const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t); if (!m) return NaN; return Math.round(Number(m[1]) * (m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1)); };
  const CLOSED = new Set(['Submitted', 'Passed', 'Won', 'Lost', 'No award', 'Cancelled', 'Rebid']);
  const needsResult = (b) => { const st = statusOf(b); return RESULT_ST.has(st) || ((st === 'In progress' || st === 'Not started') && !!b.bid_date && b.bid_date < todayIso); };
  const resultsDone = (b) => { const st = statusOf(b); if (!FINAL_ST.has(st)) return false; if (st === 'Cancelled' || st === 'Rebid') return true; const s = resultStats(b); return s.our > 0 && s.low > 0 && !!s.rank; };
  const SERVER = 'Microsoft 365';
  const TO_SERVER = 'Time Off Connector', TO_DEPTS = 'Estimating,Pre-Con';
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const parse = (s) => new Date(s + 'T12:00:00Z');
  const iso = (d) => d.toISOString().slice(0, 10);
  const fmtDay = (s) => s ? parse(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
  const money = (v) => '$' + Math.round(v).toLocaleString('en-US');
  const moneyM = (v) => v >= 1e6 ? '$' + (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M' : money(v);
  const todayIso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const monday = (s) => { const d = parse(s); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return iso(d); };
  const tmin = (t) => { const m = /^(\d{1,2}):(\d{2}) ?(AM|PM)$/i.exec(t || ''); if (!m) return 9999; let h = +m[1] % 12; if (m[3].toUpperCase() === 'PM') h += 12; return h * 60 + +m[2]; };
  const teamOf = (b) => Array.isArray(b.team) ? b.team : (b.estimator ? [b.estimator] : []);
  const goingTo = (d) => Array.isArray(d.attendees) ? d.attendees : [];
  const prebidsFor = (b) => S.deadlines.filter(d => d.kind === 'Pre-bid' && (d.bid_id === b._id || (!d.bid_id && d.project === b.project))).sort((x, y) => ((x.date || '') + tmin(x.time)).localeCompare((y.date || '') + tmin(y.time)));
  const bidMatches = (b) => { if (matches(teamOf(b))) return true; if (S.filter === 'all' || S.filter === '__none') return false; return prebidsFor(b).some(d => goingTo(d).includes(S.filter)); };
  const estIdx = (name) => S.team.estimators.findIndex(e => e.name === name);
  const initials = (name) => name ? name.split(/\s+/).map(w => w[0]).join('').slice(0, 3).toUpperCase() : '—';
  function iniBadge(name) { const i = estIdx(name); const b = el('span', 'ini ' + (name ? 'e' + Math.max(0, i) : 'none'), initials(name)); b.title = name || 'Unassigned'; return b; }
  function iniBadges(list) { const w = el('span', 'inis'); (list.length ? list : ['']).forEach(n => w.appendChild(iniBadge(n))); return w; }
  const matches = (list) => S.filter === 'all' || (S.filter === '__none' ? list.length === 0 : list.includes(S.filter));
  const isLead = (b) => statusOf(b) === 'Lead';
  const openBids = () => S.bids.filter(b => !CLOSED.has(statusOf(b)) && !isLead(b));
  const prefixDate = (name) => { const m = /^(\d{2})(\d{2})(\d{2})/.exec(name || ''); if (!m) return null; const mo = +m[2], d = +m[3]; if (mo < 1 || mo > 12 || d < 1 || d > 31) return null; return '20' + m[1] + '-' + m[2] + '-' + m[3]; };
  const folderKey = (name) => { const m = /^(\d{6}(?:-\d+)?)/.exec(name || ''); return m ? m[1] : null; };

  function showBanner(msg) { const b = $('#banner'); b.textContent = msg; b.hidden = false; }
  function writeFailed(e) {
    const code = e && e.code;
    if (code === 'invalid_argument') { S.canWrite = false; showBanner('You can view this board but not edit it. Ask the Workforce Manager for access.'); renderAll(); }
    else if (code === 'quota_exceeded') showBanner('The board is out of storage space. Ask Claude to clean it up.');
    else showBanner('That change did not save. Check your connection and try again.');
  }

  function renderLede() {
    const open = openBids(), pub = open.filter(b => b.published_ceiling != null);
    const un = open.filter(b => teamOf(b).length === 0).length;
    const total = pub.reduce((s, b) => s + b.published_ceiling, 0);
    const last = open.map(b => b.bid_date).filter(Boolean).sort().slice(-1)[0];
    const need = S.bids.filter(b => needsResult(b) && !resultsDone(b)).length;
    $('#lede').textContent = S.loaded ? (open.length + ' open bids through ' + fmtDay(last) + '. ' + pub.length + ' have a published ceiling totaling ' + moneyM(total) + '. ' + (un ? un + ' still need someone assigned.' : 'Every open bid has someone on it.') + (need ? ' ' + need + ' bid' + (need > 1 ? 's' : '') + ' past bid day still need results logged.' : '')) : 'Loading bids…';
  }

  function renderTiles() {
    const t = $('#tiles'); t.textContent = '';
    const open = openBids();
    const pub = open.reduce((s, b) => s + (b.published_ceiling || 0), 0);
    const rom = open.reduce((s, b) => s + (Number(b.rom) || 0), 0);
    const romN = open.filter(b => Number(b.rom) > 0).length;
    const next = open.filter(b => b.bid_date >= todayIso).sort((a, b) => a.bid_date.localeCompare(b.bid_date))[0];
    [['Open bids', open.length, 'Excludes submitted, passed and decided bids'],
     ['Published ceilings', moneyM(pub), 'Owner-advertised cost ranges'],
     ['FM ROM entered', moneyM(rom), romN + ' of ' + open.length + ' bids have an FM number'],
     ['Next bid due', next ? next.project : '—', next ? fmtDay(next.bid_date) + (next.bid_time ? ', ' + next.bid_time : '') : '']].forEach(([l, v, s], i) => {
      const d = el('div', 'tile'); d.appendChild(el('span', 'lbl', l)); d.appendChild(el('span', 'num' + (i === 3 ? ' small' : ''), String(v))); d.appendChild(el('span', 'sub', s)); t.appendChild(d);
    });
  }

  function renderFilters() {
    const opts = [['all', 'Everyone', null]].concat(S.team.estimators.map(e => [e.name, e.name, e.name])).concat([['__none', 'Unassigned', '']]);
    ['#filters', '#filters2', '#filters3'].forEach(sel => {
      const f = $(sel); f.querySelectorAll('button').forEach(b => b.remove());
      opts.forEach(([val, label, who]) => {
        const b = el('button', 'chip'); b.type = 'button'; b.setAttribute('aria-pressed', String(S.filter === val));
        if (who !== null) b.appendChild(iniBadge(who));
        b.appendChild(document.createTextNode(label));
        b.addEventListener('click', () => { S.filter = val; renderAll(); });
        f.appendChild(b);
      });
    });
    const lg = $('#lg-ini'); lg.textContent = '';
    S.team.estimators.forEach(e => { const s = el('span'); s.appendChild(iniBadge(e.name)); s.appendChild(document.createTextNode(e.name)); lg.appendChild(s); });
  }

  const TYPES = [['bid', 'Bid due', 'background:var(--fm-orange)'], ['lead', 'Undecided (possible bid)', 'border:1.5px dashed var(--fm-orange)'], ['pre', 'Pre-bid', 'border:1.5px solid var(--fm-char)'], ['must', 'Mandatory pre-bid', 'background:var(--fm-char)'], ['q', 'Questions & deadlines', 'background:var(--fm-tint);border:1px solid var(--fm-line)'], ['int', 'Internal', 'border:1px dashed var(--fm-soft)'], ['sent', 'Submitted / no bid', 'background:var(--fm-soft)'], ['off', 'Time off', 'border:1px dashed var(--fm-soft);border-radius:6px']];
  function evType(e, b) { if (e.kind === 'Bid') return b && isLead(b) ? 'lead' : b && CLOSED.has(statusOf(b)) ? 'sent' : 'bid'; if (e.kind === 'Pre-bid') return e.mandatory ? 'must' : 'pre'; if (e.kind === 'Internal') return 'int'; return 'q'; }
  function evShown(e, b, who) { if (!S.types.has(evType(e, b))) return false; if (e.kind === 'Internal' || who === null) return true; return matches(who); }
  function renderTypeFilters() {
    const f = $('#typefilters'); f.querySelectorAll('button').forEach(x => x.remove());
    const all = el('button', 'chip', 'All types'); all.type = 'button'; all.setAttribute('aria-pressed', String(S.types.size === TYPES.length));
    all.addEventListener('click', () => { S.types = new Set(TYPES.map(t => t[0])); renderAll(); }); f.appendChild(all);
    TYPES.forEach(([k, label, sw]) => {
      const b = el('button', 'chip'); b.type = 'button'; const on = S.types.has(k) && S.types.size !== TYPES.length; b.setAttribute('aria-pressed', String(on));
      const i = el('i', 'sw'); i.setAttribute('style', sw); b.appendChild(i); b.appendChild(document.createTextNode(label));
      b.title = 'Click to show only this. Shift-click to add or remove it.';
      b.addEventListener('click', (ev) => {
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) { if (S.types.has(k) && S.types.size > 1) S.types.delete(k); else S.types.add(k); }
        else if (S.types.size === TYPES.length) S.types = new Set([k]);
        else if (S.types.has(k)) { if (S.types.size > 1) S.types.delete(k); else S.types = new Set(TYPES.map(t => t[0])); }
        else S.types.add(k);
        renderAll();
      });
      f.appendChild(b);
    });
  }

  // Company holidays per Company Policy Manual §7.3 (rev. 12/16/2024): New Year's, Memorial Day, Independence Day,
  // Labor Day, Veterans Day, Thanksgiving, Christmas. Weekend holidays: Saturday -> Friday before, Sunday -> Monday after.
  // Company-declared extra days or a different observed day go in config/holidays (extra / moved).
  const HOLCACHE = new Map();
  function nthWeekday(y, m, dow, n) { const d = new Date(Date.UTC(y, m, 1)); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + 7 * (n - 1)); return d; }
  function lastWeekday(y, m, dow) { const d = new Date(Date.UTC(y, m + 1, 0)); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() - 1); return d; }
  function observed(d) { const w = d.getUTCDay(); const o = new Date(d); if (w === 6) o.setUTCDate(o.getUTCDate() - 1); if (w === 0) o.setUTCDate(o.getUTCDate() + 1); return o; }
  function holidaysForYear(y) {
    const fixed = (m, day) => observed(new Date(Date.UTC(y, m, day)));
    const tg = nthWeekday(y, 10, 4, 4), dayAfter = new Date(tg); dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    // Veterans Day and the day after Thanksgiving are a choose-one swap: the office stays open on Veterans Day, and most office staff take the day after Thanksgiving.
    return [[fixed(0, 1), "New Year's Day", 'closed'], [lastWeekday(y, 4, 1), 'Memorial Day', 'closed'], [fixed(6, 4), 'Independence Day', 'closed'], [nthWeekday(y, 8, 1, 1), 'Labor Day', 'closed'], [fixed(10, 11), 'Veterans Day', 'optional'], [tg, 'Thanksgiving Day', 'closed'], [dayAfter, 'Day after Thanksgiving', 'mostoff'], [fixed(11, 25), 'Christmas Day', 'closed']];
  }
  function holidayOn(isoDate) {
    if (!isoDate) return null;
    const cfg = S.holidaysCfg || {};
    const moved = (cfg.moved || []).find(x => x.date === isoDate); if (moved) return { name: moved.name, kind: moved.kind || 'closed' };
    if ((cfg.moved || []).some(x => x.from === isoDate)) return null;
    const extra = (cfg.extra || []).find(x => x.date === isoDate); if (extra) return { name: extra.name, kind: extra.kind || 'closed' };
    const y = +isoDate.slice(0, 4);
    if (!HOLCACHE.has(y)) { const m = new Map(); [y, y + 1].forEach(yy => holidaysForYear(yy).forEach(([d, n, kind]) => { const k = iso(d); if (+k.slice(0, 4) === y) m.set(k, { name: n, kind }); })); HOLCACHE.set(y, m); }
    return HOLCACHE.get(y).get(isoDate) || null;
  }

  // ---- Time off (FM Workforce app, via the Time Off Connector) ----
  // One shared doc, timeoff/current, so viewers without the connector still see it.
  const normName = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
  function offsOn(isoDate) { const t = S.timeoff; if (!t || !Array.isArray(t.days)) return []; return t.days.filter(d => d.date === isoDate); }
  function offFor(name, isoDate) { const n = normName(name); return offsOn(isoDate).find(d => normName(d.name) === n) || null; }
  const offLabel = (o) => (Number(o.hours) && Number(o.hours) < 8 ? ' ' + (+o.hours) + 'h' : '') + (o.status === 'pending' ? ' · pending' : '');
  const offShort = (o) => (Number(o.hours) && Number(o.hours) < 8 ? (+o.hours) + 'h' : 'off') + (o.status === 'pending' ? ', pending' : '');
  // People on an event who are out that day.
  function clashes(names, isoDate) { return (names || []).map(n => offFor(n, isoDate)).filter(Boolean); }
  const clashText = (list, isoDate) => list.map(o => o.name + ' (' + offShort(o) + ')').join(', ') + (list.length > 1 ? ' are' : ' is') + ' out ' + fmtDay(isoDate);
  async function refreshTimeOff(quiet) {
    const note = $('#off-note');
    const mcp = await claude.use('mcp'); if (!mcp) return false;
    const start = new Date(parse(todayIso)); start.setUTCDate(start.getUTCDate() - 45);
    const end = new Date(parse(todayIso)); end.setUTCDate(end.getUTCDate() + 350);
    let res;
    try { res = await mcp.callTool(TO_SERVER, 'get_time_off', { start: iso(start), end: iso(end), department: TO_DEPTS }, { cache: false }); }
    catch (e) {
      if (!quiet && note) note.textContent = e && (e.code === 'server_not_connected' || e.code === 'not_granted' || e.code === 'blocked_by_policy') ? 'Time off: connect the Time Off Connector in Claude settings to refresh it from FM Workforce.' : 'Time off could not be refreshed from FM Workforce just now. Showing the last copy.';
      return false;
    }
    let data = res && res.payload;
    if (!data || !Array.isArray(data.days)) { try { data = JSON.parse(resultText(res)); } catch (e) { data = null; } }
    if (!data || !Array.isArray(data.days)) return false;
    const days = data.days.map(d => ({ date: String(d.date || ''), name: String(d.name || ''), type: d.type || '', hours: Number(d.hours) || 8, status: d.status === 'pending' ? 'pending' : 'approved' })).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.name).sort((a, b) => (a.date + a.name).localeCompare(b.date + b.name));
    const doc = { days, start: data.start || iso(start), end: data.end || iso(end), departments: TO_DEPTS, fetchedAt: new Date().toISOString() };
    const same = S.timeoff && JSON.stringify(S.timeoff.days || []) === JSON.stringify(days);
    S.timeoff = Object.assign({}, S.timeoff || {}, doc); renderAll();
    if (S.db && S.canWrite) { try { await S.db.doc('timeoff/current').set(same ? Object.assign({}, doc, { days: S.timeoff.days }) : doc); } catch (e) {} }
    return true;
  }
  function renderOffNote() {
    const note = $('#off-note'); if (!note) return;
    const t = S.timeoff;
    note.textContent = 'Estimating and Pre-Con time off comes from the FM Workforce app (dashed = still pending approval).' + (t && t.fetchedAt ? ' Updated ' + new Date(t.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '.' : ' Not loaded yet: click Check SharePoint now.');
  }

  // Jobs we passed on (No-Go) stay off the Bid Board Schedule: no bid-due or pre-bid events, no card,
  // not in the PDF. They live on the Go / No-Go page and in Bid Results & History.
  const isPassed = (b) => !!b && statusOf(b) === 'Passed';
  // Finished = won / lost / no award / cancelled / rebid with the results logged. These drop off the
  // schedule and calendar on their own (they live in Bid Results & History); "Show finished bids" brings them back.
  const isFinished = (b) => !!b && FINAL_ST.has(statusOf(b)) && resultsDone(b);
  const offSchedule = (b) => isPassed(b) || (!S.showFinished && isFinished(b));
  function calEvents() {
    const hidden = S.bids.filter(offSchedule);
    const hiddenIds = new Set(hidden.map(b => b._id)); const hiddenProj = new Set(hidden.map(b => b.project));
    const evs = S.deadlines.filter(r => r.kind !== 'Bid' && !hiddenIds.has(r.bid_id) && !(r.bid_id == null && hiddenProj.has(r.project))).map(r => Object.assign({}, r));
    S.bids.forEach(b => { if (b.bid_date && !offSchedule(b)) evs.push({ date: b.bid_date, time: b.bid_time || 'TBD', project: b.project, event: 'Bid due', kind: 'Bid', _bid: b }); });
    return evs;
  }

  const monthKey = (d) => d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  const monthName = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  // Months that begin in this Mon–Fri week (the first week shown starts its own month).
  function newMonthsInWeek(wk, seen) {
    const out = [];
    for (let i = 0; i < 5; i++) { const d = parse(wk); d.setUTCDate(d.getUTCDate() + i); const k = monthKey(d); if (!seen.has(k)) { seen.add(k); out.push(new Date(d)); } }
    return out;
  }
  // Collapsed months: past months start collapsed; each viewer's own toggles are remembered in this browser.
  const MONTH_PREF = 'fmBidBoard.months';
  let monthPref = {}; try { monthPref = JSON.parse(localStorage.getItem(MONTH_PREF) || '{}') || {}; } catch (e) { monthPref = {}; }
  const curMonthKey = todayIso.slice(0, 7);
  const isCollapsed = (k) => (k in monthPref) ? monthPref[k] === 'closed' : k < curMonthKey;
  function toggleMonth(k) { monthPref[k] = isCollapsed(k) ? 'open' : 'closed'; try { localStorage.setItem(MONTH_PREF, JSON.stringify(monthPref)); } catch (e) {} renderCal(); }
  function renderCal() {
    const box = $('#cal'); box.textContent = '';
    ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].forEach(d => box.appendChild(el('div', 'dow', d)));
    const evsAll = calEvents();
    const ds = evsAll.map(e => e.date).filter(Boolean).sort(); if (!ds.length) return;
    let w = parse(monday(ds[0] < todayIso ? ds[0] : todayIso)); const last = parse(monday(ds[ds.length - 1])); const wks = [];
    while (w <= last) { wks.push(iso(w)); w.setUTCDate(w.getUTCDate() + 7); }
    const byDay = new Map(); evsAll.forEach(r => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
    const byProj = new Map(S.bids.map(b => [b.project, b])); const byId = new Map(S.bids.map(b => [b._id, b]));
    let total = 0;
    const seenMonths = new Set(); const jump = $('#monthjump'); jump.textContent = ''; let curBand = null;
    const bidsByMonth = {}; S.bids.forEach(b => { if (b.bid_date && !CLOSED.has(statusOf(b)) && !isLead(b)) { const k = b.bid_date.slice(0, 7); bidsByMonth[k] = (bidsByMonth[k] || 0) + 1; } });
    wks.forEach((wk, wi) => {
      newMonthsInWeek(wk, seenMonths).forEach(md => {
        const k = monthKey(md), n = bidsByMonth[k] || 0;
        const closed = isCollapsed(k); curBand = k;
        const band = el('button', 'monthband' + (closed ? ' closed' : '')); band.type = 'button'; band.id = 'm-' + k;
        band.setAttribute('aria-expanded', String(!closed)); band.title = closed ? 'Show this month' : 'Hide this month';
        band.addEventListener('click', () => toggleMonth(k));
        band.appendChild(el('span', 'mn', monthName(md)));
        band.appendChild(el('span', 'mc', (n ? n + ' open bid' + (n > 1 ? 's' : '') + ' due' : 'No open bids due') + (closed ? ' · Show ▸' : ' · Hide ▾')));
        box.appendChild(band);
        const j = el('button', 'chip', md.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }) + (n ? ' · ' + n : '')); j.type = 'button';
        if (isCollapsed(k)) j.classList.add('muted');
        j.addEventListener('click', () => { if (isCollapsed(k)) { monthPref[k] = 'open'; try { localStorage.setItem(MONTH_PREF, JSON.stringify(monthPref)); } catch (e) {} renderCal(); } const t = document.getElementById('m-' + k); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        jump.appendChild(j);
      });
      for (let i = 0; i < 5; i++) {
        const d = parse(wk); d.setUTCDate(d.getUTCDate() + i); const key = iso(d);
        const evs = (byDay.get(key) || []).slice().sort((a, b) => tmin(a.time) - tmin(b.time));
        const hol = holidayOn(key);
        const cell = el('div', 'day' + (d.getUTCMonth() % 2 ? ' mo-alt' : '') + (key < todayIso ? ' past' : '') + (key === todayIso ? ' today' : '') + (hol ? (hol.kind === 'optional' ? ' optional' : ' holiday') : ''));
        let shown = 0;
        const dn = el('div', 'dn'); dn.appendChild(el('span', null, d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })));
        if (d.getUTCDate() === 1 || (wi === 0 && i === 0)) dn.appendChild(el('span', 'mo', d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })));
        if (key === todayIso) dn.appendChild(el('span', 'mo', 'Today'));
        if (hol) { cell.appendChild(dn); const hl = el('div', 'hol' + (hol.kind === 'optional' ? ' opt' : ''), hol.kind === 'closed' ? 'Office closed · ' + hol.name : hol.kind === 'mostoff' ? 'Most office staff off · ' + hol.name : 'Optional holiday – office open · ' + hol.name); cell.appendChild(hl); }
        if (!hol) cell.appendChild(dn);
        const offs = S.types.has('off') ? offsOn(key).filter(o => S.filter === 'all' || S.filter === '__none' ? S.filter === 'all' : normName(o.name) === normName(S.filter)) : [];
        if (offs.length) {
          const ow = el('div', 'offs');
          offs.forEach(o => { const c = el('span', 'off' + (o.status === 'pending' ? ' pend' : '')); c.title = o.name + ' – ' + (o.type || 'Time off') + (Number(o.hours) < 8 ? ', ' + o.hours + ' hrs' : '') + (o.status === 'pending' ? ' (pending approval)' : ''); c.appendChild(iniBadge(o.name)); c.appendChild(document.createTextNode('Off' + offLabel(o))); ow.appendChild(c); });
          cell.appendChild(ow);
        }
        evs.forEach(e => {
          const b = e._bid || (e.bid_id && byId.get(e.bid_id)) || byProj.get(e.project); const who = e.kind === 'Pre-bid' && goingTo(e).length ? goingTo(e) : (b ? teamOf(b) : null);
          if (!evShown(e, b, who)) return;
          shown++;
          let cls = e.kind === 'Bid' ? 'bid' : e.kind === 'Pre-bid' ? (e.mandatory ? 'must' : 'pre') : e.kind === 'Internal' ? 'int' : 'q';
          if (evType(e, b) === 'sent') cls += ' sent';
          if (evType(e, b) === 'lead') cls += ' lead';
          const ev = el('div', 'ev ' + cls);
          if (who !== null) ev.appendChild(iniBadges(who));
          const tx = el('div', 'tx');
          const lab = e.kind === 'Bid' ? (b && isLead(b) ? 'POSSIBLE BID' : 'BID') : e.kind === 'Pre-bid' ? (e.mandatory ? 'MANDATORY PRE-BID' : 'Pre-bid') : e.kind === 'Internal' ? 'Internal' : 'Deadline';
          tx.appendChild(el('span', 't', lab + ' · ' + e.time));
          tx.appendChild(document.createTextNode(e.kind === 'Internal' ? e.event : (b ? b.project : e.project)));
          if (hol && (e.kind === 'Bid' || e.kind === 'Pre-bid')) tx.appendChild(el('span', 'holwarn', hol.kind === 'optional' ? "Optional holiday – check who's in" : 'Falls on a company holiday'));
          if (who && (e.kind === 'Bid' || e.kind === 'Pre-bid') && !(e.kind === 'Bid' && CLOSED.has(statusOf(b || {})))) { const cl = clashes(who, key); if (cl.length) tx.appendChild(el('span', 'offwarn', '⚠ ' + cl.map(o => initials(o.name) + ' ' + offShort(o)).join(', '))); }
          ev.appendChild(tx); ev.title = e.event;
          const target = e.kind === 'Bid' && b ? { kind: 'bid', id: b._id, from: key, label: 'Bid due · ' + b.project } : (e._id ? { kind: 'deadline', id: e._id, from: key, label: (e.kind === 'Internal' ? e.event : lab + ' · ' + (b ? b.project : e.project)) } : null);
          if (target && S.canWrite && S.db) {
            ev.draggable = true; ev.classList.add('drag');
            ev.title = 'Drag to another day to change the date. Click to open the bid.';
            ev.addEventListener('dragstart', (de) => { de.dataTransfer.effectAllowed = 'move'; try { de.dataTransfer.setData('text/plain', JSON.stringify(target)); } catch (x) {} S.dragging = target; ev.classList.add('dragging'); document.getElementById('cal').classList.add('dragmode'); });
            ev.addEventListener('dragend', () => { ev.classList.remove('dragging'); S.dragging = null; const c = document.getElementById('cal'); c.classList.remove('dragmode'); c.querySelectorAll('.dropok').forEach(x => x.classList.remove('dropok')); });
          }
          if (b) { ev.classList.add('link'); ev.addEventListener('click', () => { if (S.filter !== 'all' && !bidMatches(b)) { S.filter = 'all'; renderAll(); } setTimeout(() => { const c = document.getElementById('bid-' + b._id); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); } }, 50); }); }
          cell.appendChild(ev);
        });
        if (!shown && !offs.length && !(hol && hol.kind !== 'optional')) cell.classList.add('empty');
        total += shown;
        cell.dataset.date = key;
        cell.addEventListener('dragover', (de) => { if (!S.dragging) return; de.preventDefault(); de.dataTransfer.dropEffect = 'move'; cell.classList.add('dropok'); });
        cell.addEventListener('dragleave', () => cell.classList.remove('dropok'));
        cell.addEventListener('drop', (de) => { de.preventDefault(); cell.classList.remove('dropok'); let t = S.dragging; if (!t) { try { t = JSON.parse(de.dataTransfer.getData('text/plain')); } catch (x) { t = null; } } S.dragging = null; if (t) moveEvent(t, key); });
        if (curBand && isCollapsed(curBand)) cell.hidden = true;
        box.appendChild(cell);
      }
    });
    const pname = S.filter === 'all' ? 'everyone' : S.filter === '__none' ? 'unassigned bids' : S.filter;
    $('#cal-count').textContent = total + ' event' + (total === 1 ? '' : 's') + ' shown for ' + pname + (S.types.size === TYPES.length ? '' : ' · ' + TYPES.filter(t => S.types.has(t[0])).map(t => t[1]).join(', ')) + '.';
  }

  async function saveBid(id, patch, cellEl) {
    try { await S.db.doc('bids/' + id).update(patch); if (cellEl) { const s = el('span', 'saved', 'Saved'); cellEl.appendChild(s); setTimeout(() => s.remove(), 1400); } }
    catch (e) { writeFailed(e); }
  }

  function renderTable() {
    if (S.gngEditSeen !== S.editing) { S.gngEditSeen = S.editing; renderGoNoGo(); }
    const tb = $('#bids');
    if (tb.contains(document.activeElement) && (document.activeElement.tagName !== 'BUTTON' || S.resEdit)) { S.tableStale = true; return; }
    S.tableStale = false; tb.textContent = '';
    const rows = S.bids.filter(b => !isLead(b) && !offSchedule(b)).sort((a, b) => (a.bid_date || '9').localeCompare(b.bid_date || '9')).filter(bidMatches);
    const dups = findDups();
    if (!rows.length) { tb.appendChild(el('div', 'card empty', S.loaded ? 'No bids match this filter.' : 'Loading bids…')); return; }
    rows.forEach(b => {
      const id = b._id; const closed = CLOSED.has(statusOf(b));
      // Finished bids (submitted, won, lost…) shrink to a one-line summary until opened.
      const compact = closed && S.editing !== id && !S.expanded.has(id);
      const toggleOpen = () => { if (S.expanded.has(id)) S.expanded.delete(id); else S.expanded.add(id); S.confirmDel = null; renderTable(); };
      const card = el('article', 'card' + (closed ? ' closed' : '') + (compact ? ' compact' : '') + (S.editing === id ? ' open' : '')); card.id = 'bid-' + id;
      // date block
      const db = el('div', 'dblk');
      if (b.bid_date) { const d = parse(b.bid_date); db.appendChild(el('span', 'mo', d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }))); db.appendChild(el('span', 'dd', String(d.getUTCDate()))); db.appendChild(el('span', 'wd', d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))); }
      else db.appendChild(el('span', 'wd', 'No date'));
      card.appendChild(db);
      const main = el('div', 'cmain');
      // head line
      const head = el('div', 'chead');
      const ttl = el('div', 'ttl');
      const pbtn = el('button', 'proj-btn', b.project); pbtn.type = 'button'; pbtn.title = compact ? 'Show details' : 'Edit details'; pbtn.addEventListener('click', () => { if (compact) return toggleOpen(); S.editing = S.editing === id ? null : id; S.confirmDel = null; renderTable(); });
      ttl.appendChild(pbtn);
      ttl.appendChild(el('span', 'o', [b.id || id, b.location, b.sector, b.delivery].filter(Boolean).join(' · ')));
      const dupOf = dups.get(id); if (dupOf) ttl.appendChild(el('span', 'dup', 'Possible duplicate of ' + dupOf));
      head.appendChild(ttl);
      const right = el('div', 'cright');
      right.appendChild(el('span', 'val', b.value_label || 'Not published'));
      const st = el('select'); st.id = 'st-' + id; st.setAttribute('aria-label', 'Status for ' + b.project); st.disabled = !S.canWrite;
      st.title = 'Where this bid stands. Submitted, Passed and the award results drop it from the open-bid totals.';
      STATUSES.forEach(sv => { const o = el('option', null, sv); o.value = sv; if (statusOf(b) === sv) o.selected = true; st.appendChild(o); });
      st.addEventListener('change', () => saveBid(id, { status: st.value }, right)); right.appendChild(st);
      const ac = el('div', 'acts-c');
      if (S.confirmDel === id) {
        ac.appendChild(el('span', 'msg', 'Delete this bid?'));
        const yes = el('button', 'ib del solid', 'Delete'); yes.type = 'button'; yes.addEventListener('click', () => deleteBid(id));
        const no = el('button', 'ib', 'Cancel'); no.type = 'button'; no.addEventListener('click', () => { S.confirmDel = null; renderTable(); });
        ac.appendChild(yes); ac.appendChild(no);
      } else if (compact) {
        const op = el('button', 'ib', 'Details ▾'); op.type = 'button'; op.setAttribute('aria-label', 'Show details for ' + b.project); op.addEventListener('click', toggleOpen);
        ac.appendChild(op);
      } else {
        if (closed && S.editing !== id) { const cl = el('button', 'ib', 'Collapse ▴'); cl.type = 'button'; cl.setAttribute('aria-label', 'Collapse ' + b.project); cl.addEventListener('click', toggleOpen); ac.appendChild(cl); }
        const ed = el('button', 'ib', S.editing === id ? 'Close' : 'Edit'); ed.type = 'button'; ed.addEventListener('click', () => { S.editing = S.editing === id ? null : id; S.confirmDel = null; renderTable(); });
        const del = el('button', 'ib del', 'Delete'); del.type = 'button'; const keepHist = KEEP_ST.has(statusOf(b)); del.disabled = !S.canWrite || keepHist; if (keepHist) del.title = 'Kept for bid history. Change the status instead of deleting.'; del.setAttribute('aria-label', 'Delete ' + b.project); del.addEventListener('click', () => { S.confirmDel = id; renderTable(); });
        ac.appendChild(ed); ac.appendChild(del);
      }
      right.appendChild(ac);
      head.appendChild(right);
      main.appendChild(head);
      if (compact) { main.appendChild(compactSummary(b)); card.appendChild(main); tb.appendChild(card); return; }
      // Body: details on the left, results + notes in a side panel on the right.
      const body = el('div', 'cbody'); const left = el('div', 'cleft'); const side = el('div', 'cside');
      body.appendChild(left); body.appendChild(side); main.appendChild(body);
      // facts line
      const facts = el('div', 'facts');
      const fact = (label, node) => { const f = el('div', 'fact'); f.appendChild(el('span', 'fl', label)); f.appendChild(node); facts.appendChild(f); return f; };
      const tg = el('div', 'togs'); const cur = teamOf(b);
      S.team.estimators.forEach((e, i) => {
        const on = cur.includes(e.name);
        const btn = el('button', 'tog e' + i, initials(e.name)); btn.type = 'button'; btn.title = e.name; btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', e.name + ' on ' + b.project); btn.disabled = !S.canWrite;
        btn.addEventListener('click', () => { const next = on ? cur.filter(n => n !== e.name) : cur.concat([e.name]); const order = S.team.estimators.map(x => x.name); next.sort((a, z) => order.indexOf(a) - order.indexOf(z)); saveBid(id, { team: next, estimator: next[0] || '' }); });
        tg.appendChild(btn);
      });
      fact('Estimators', tg);
      const dwrap = el('div', 'dt-wrap');
      const dt = el('input'); dt.type = 'date'; dt.className = 'dt'; dt.id = 'date-' + id; dt.value = b.bid_date || ''; dt.disabled = !S.canWrite; dt.setAttribute('aria-label', 'Bid date for ' + b.project);
      dt.addEventListener('change', () => { if (dt.value) saveBid(id, { bid_date: dt.value }, dwrap); });
      const tm = el('input'); tm.type = 'text'; tm.className = 'tm'; tm.id = 'time-' + id; tm.maxLength = 20; tm.value = b.bid_time || ''; tm.placeholder = 'Time'; tm.disabled = !S.canWrite; tm.setAttribute('aria-label', 'Bid time for ' + b.project);
      tm.addEventListener('change', () => saveBid(id, { bid_time: tm.value.trim() }, dwrap));
      dwrap.appendChild(dt); dwrap.appendChild(tm);
      fact('Bid due', dwrap);
      const r = el('input'); r.type = 'text'; r.inputMode = 'decimal'; r.className = 'rom'; r.id = 'rom-' + id; r.placeholder = '$0'; r.setAttribute('aria-label', 'FM ROM for ' + b.project); r.value = b.rom == null ? '' : money(b.rom); r.disabled = !S.canWrite;
      const rf = fact('FM ROM', r);
      r.addEventListener('change', () => { const v = parseMoney(r.value); if (Number.isNaN(v)) { r.value = b.rom == null ? '' : money(b.rom); showBanner('Enter the ROM as a dollar amount, like $1,250,000 or 1.25M.'); return; } r.value = v == null ? '' : money(v); saveBid(id, { rom: v }, rf); });
      { const bo = el('span', 'fv', b.bid_opening || '—'); fact('Bid opening', bo); }
      fact('Owner', el('span', 'fv', b.owner || '—'));
      fact('Architect', el('span', 'fv', b.architect || '—'));
      const bsec = el('span', 'fv', (b.bid_security || '—') + (b.bond_status ? ' · ' + b.bond_status : '')); if (b.bond_status === 'Bid bond executed') bsec.classList.add('okb'); fact('Bid security', bsec);
      const pbs = prebidsFor(b);
      {
        const box = el('div', 'pbs');
        if (!pbs.length) box.appendChild(el('span', 'fv' + (/MANDATORY/.test(b.prebid || '') ? ' mustt' : ''), b.prebid || 'No pre-bid listed'));
        pbs.forEach(d => {
          const line = el('div', 'pbl');
          line.appendChild(el('span', 'fv' + (d.mandatory ? ' mustt' : ''), fmtDay(d.date) + (d.time ? ' · ' + d.time : '') + (d.mandatory ? ' · MANDATORY' : '') + (d.date < todayIso ? ' (held)' : '')));
          const g = el('div', 'togs'); const went = goingTo(d);
          S.team.estimators.forEach((e, i) => {
            const on = went.includes(e.name);
            const btn = el('button', 'tog e' + i, initials(e.name)); btn.type = 'button'; btn.title = e.name + (on ? ' is going' : ' not going'); btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', e.name + ' attending pre-bid for ' + b.project); btn.disabled = !S.canWrite;
            btn.addEventListener('click', async () => { const next = on ? went.filter(n => n !== e.name) : went.concat([e.name]); const order = S.team.estimators.map(x => x.name); next.sort((a, z) => order.indexOf(a) - order.indexOf(z)); try { await S.db.doc('deadlines/' + d._id).update({ attendees: next, bid_id: b._id }); } catch (err) { writeFailed(err); } });
            g.appendChild(btn);
          });
          line.appendChild(g); box.appendChild(line);
        });
        if (S.canWrite) {
          if (S.addingPre === id) {
            const f = el('div', 'pbl');
            const pd = el('input'); pd.type = 'date'; pd.className = 'dt'; pd.id = 'pre-date-' + id; pd.setAttribute('aria-label', 'Pre-bid date');
            const pt = el('input'); pt.type = 'text'; pt.className = 'tm'; pt.id = 'pre-time-' + id; pt.placeholder = 'Time'; pt.setAttribute('aria-label', 'Pre-bid time');
            const ml = el('label', 'chk fv'); const mc = el('input'); mc.type = 'checkbox'; mc.id = 'pre-must-' + id; ml.appendChild(mc); ml.appendChild(document.createTextNode(' Mandatory'));
            const ok = el('button', 'ib', 'Add'); ok.type = 'button';
            const no = el('button', 'ib', 'Cancel'); no.type = 'button';
            ok.addEventListener('click', async () => { if (!pd.value) { pd.focus(); return; } ok.disabled = true; try { await S.db.collection('deadlines').add({ bid_id: id, project: b.project, date: pd.value, time: pt.value.trim(), kind: 'Pre-bid', event: 'Pre-bid', mandatory: mc.checked, attendees: [] }); S.addingPre = null; S.tableStale = false; if (document.activeElement) document.activeElement.blur(); renderTable(); } catch (err) { ok.disabled = false; writeFailed(err); } });
            no.addEventListener('click', () => { S.addingPre = null; renderTable(); });
            [pd, pt, ml, ok, no].forEach(x => f.appendChild(x)); box.appendChild(f);
          } else {
            const add = el('button', 'ib', pbs.length ? '+ Another pre-bid' : '+ Add pre-bid'); add.type = 'button';
            add.addEventListener('click', () => { S.addingPre = id; renderTable(); setTimeout(() => { const x = document.getElementById('pre-date-' + id); if (x) x.focus(); }, 0); });
            box.appendChild(add);
          }
        }
        fact('Pre-bid · who is going', box).classList.add('wide');
      }
      left.appendChild(facts);
      if (!closed && S.timeoff) {
        const warns = [];
        if (b.bid_date && b.bid_date >= todayIso) { const cl = clashes(teamOf(b), b.bid_date); if (cl.length) warns.push('Bid day: ' + clashText(cl, b.bid_date) + '.'); }
        pbs.filter(d => d.date && d.date >= todayIso).forEach(d => { const cl = clashes(goingTo(d), d.date); if (cl.length) warns.push((d.mandatory ? 'Mandatory pre-bid' : 'Pre-bid') + ': ' + clashText(cl, d.date) + '.'); });
        if (warns.length) { const w = el('div', 'dflag'); w.appendChild(el('strong', null, 'Time off conflict')); warns.forEach(t => w.appendChild(el('span', 'q', t))); left.appendChild(w); }
      }
      if (b.date_flag && b.date_flag.date && b.date_flag.date !== b.bid_date) {
        const fl = el('div', 'dflag');
        fl.appendChild(el('strong', null, 'Bid date may have changed: '));
        fl.appendChild(document.createTextNode((b.date_flag.source || 'An addendum') + ' says ' + fmtDay(b.date_flag.date) + (b.date_flag.time ? ' ' + b.date_flag.time : '') + '. The board says ' + fmtDay(b.bid_date) + '. '));
        if (b.date_flag.quote) { const q = el('span', 'q', '"' + b.date_flag.quote + '"'); fl.appendChild(q); }
        const ap = el('button', 'ib', 'Use ' + fmtDay(b.date_flag.date)); ap.type = 'button'; ap.disabled = !S.canWrite;
        ap.addEventListener('click', () => { const patch = { bid_date: b.date_flag.date, date_flag: null }; if (b.date_flag.time) patch.bid_time = b.date_flag.time; saveBid(id, patch); });
        const ig = el('button', 'ib', 'Ignore'); ig.type = 'button'; ig.disabled = !S.canWrite;
        ig.addEventListener('click', () => saveBid(id, { date_flag: null, date_flag_ignored: b.date_flag.source === 'Bid documents' ? 'documents:' + b.date_flag.date : (b.date_flag.source || '') }));
        fl.appendChild(ap); fl.appendChild(ig); left.appendChild(fl);
      }
      if (Array.isArray(b.suggest) && b.suggest.length) {
        const sg = el('div', 'sugg');
        sg.appendChild(el('strong', null, 'SharePoint documents show different information:'));
        const ul = el('ul');
        b.suggest.forEach(x => { const li = el('li'); li.appendChild(el('span', 'fl', x.label)); li.appendChild(document.createTextNode(' ' + (x.field === 'published_ceiling' ? money(x.value) : x.value))); const was = el('span', 'was', 'board: ' + (x.field === 'published_ceiling' && x.current != null ? money(x.current) : (norm(x.current) || '—'))); li.appendChild(was); ul.appendChild(li); });
        sg.appendChild(ul);
        const ap = el('button', 'ib', 'Use document values'); ap.type = 'button'; ap.disabled = !S.canWrite;
        ap.addEventListener('click', () => { const patch = { suggest: [] }; b.suggest.forEach(x => { patch[x.field] = x.value; }); saveBid(id, patch); });
        const ig = el('button', 'ib', 'Keep board values'); ig.type = 'button'; ig.disabled = !S.canWrite;
        ig.addEventListener('click', () => { const keep = Object.assign({}, b.sp_keep || {}); b.suggest.forEach(x => { keep[x.field] = x.value; }); saveBid(id, { suggest: [], sp_keep: keep }); });
        const acts = el('div', 'row'); acts.appendChild(ap); acts.appendChild(ig); sg.appendChild(acts);
        left.appendChild(sg);
      }
      {
        const ad = el('div', 'adds'); ad.appendChild(el('span', 'fl', 'Addenda in folder'));
        const list = Array.isArray(b.addenda) ? b.addenda : null;
        if (!list) ad.appendChild(el('span', 'fv muted', 'Not checked yet. Press Check SharePoint now.'));
        else if (!list.length) ad.appendChild(el('span', 'fv muted', 'None found' + (b.sp_checked_at ? ' as of ' + new Date(b.sp_checked_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '') + '.'));
        else {
          const ul = el('ul', 'addl');
          list.forEach(a => {
            const li = el('li'); li.appendChild(el('span', 'an', a.number ? 'Add. ' + a.number : 'Addendum'));
            li.appendChild(document.createTextNode(' ' + a.name.replace(/\.pdf$/i, '')));
            if (a.found && a.found.date) li.appendChild(el('span', 'tag', 'Bid date ' + fmtDay(a.found.date)));
            else if (a.found && a.found.noChange) li.appendChild(el('span', 'tag muted', 'No date change'));
            ul.appendChild(li);
          });
          ad.appendChild(ul);
        }
        left.appendChild(ad);
      }
      if (needsResult(b) || statusOf(b) === 'Passed') side.appendChild(resultsCard(b));
      { const rv = romVsLow(b); if (rv) side.appendChild(rv); }
      // description + notes
      const dsc = el('div', 'desc'); dsc.appendChild(el('span', 'fl', 'Job description')); dsc.appendChild(el('p', null, b.description || 'No description yet. Click Edit to add one.')); if (!b.description) dsc.classList.add('blank');
      left.appendChild(dsc);
      const nwrap = el('div', 'notes'); nwrap.appendChild(el('span', 'fl', 'Notes'));
      const nt = el('textarea', 'note'); nt.id = 'note-' + id; nt.placeholder = 'Add a note for the team'; nt.maxLength = 1000; nt.rows = 4; nt.setAttribute('aria-label', 'Notes for ' + b.project); nt.value = b.notes || ''; nt.disabled = !S.canWrite;
      nt.addEventListener('change', () => saveBid(id, { notes: nt.value }, nwrap)); nwrap.appendChild(nt);
      side.appendChild(nwrap);
      if (S.editing === id) main.appendChild(editorFor(b));
      card.appendChild(main);
      tb.appendChild(card);
    });
  }

  // ---- Bid history: results, no-bid reasons, competitors ----
  const isUs = (n) => /fager|\bfmc\b|\bfm\b/i.test(n || '');
  const compKey = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const canonComp = (n) => { const k = compKey(n); const hit = (S.comps || []).find(c => compKey(c) === k); return hit || String(n || '').trim(); };
  async function learnComps(names) {
    if (!S.db || !S.canWrite) return;
    const have = new Set((S.comps || []).map(compKey)); const add = [];
    names.map(n => String(n || '').trim()).forEach(n => { if (n && !isUs(n) && !have.has(compKey(n))) { have.add(compKey(n)); add.push(n); } });
    if (!add.length) return;
    try { await S.db.doc('config/competitors').set({ names: (S.comps || []).concat(add).sort((a, z) => a.localeCompare(z)) }); } catch (e) {}
  }
  function renderComps() { const dl = $('#dl-comp'); if (!dl) return; dl.textContent = ''; ['Fager-McGee'].concat(S.comps || []).forEach(n => { const o = el('option'); o.value = n; dl.appendChild(o); }); }
  function parseTab(text) {
    const out = [];
    String(text || '').split(/\n+/).forEach(line => {
      const m = /^\s*(.+?)\s*[–—:\-]?\s*\$?\s*([\d,]+(?:\.\d+)?\s*[kKmM]?)\s*$/.exec(line);
      if (!m) return; const v = parseMoney(m[2]); if (!(v > 0)) return;
      out.push({ name: m[1].replace(/[\s–—:\-]+$/, '').trim(), amount: v });
    });
    return out.sort((a, z) => a.amount - z.amount);
  }
  function resField(lbl, node, full) { const l = el('label', full ? 'full' : null); l.appendChild(document.createTextNode(lbl)); l.appendChild(node); return l; }
  function resMoney(b, k, lbl, box) { const i = el('input'); i.type = 'text'; i.inputMode = 'decimal'; i.placeholder = '$0'; i.id = k + '-' + b._id; i.value = b[k] > 0 ? money(b[k]) : ''; i.disabled = !S.canWrite; i.addEventListener('change', () => { const v = parseMoney(i.value); if (Number.isNaN(v)) { showBanner('Enter dollar amounts like $1,250,000 or 1.25M.'); i.value = b[k] > 0 ? money(b[k]) : ''; return; } i.value = v == null ? '' : money(v); saveBid(b._id, { [k]: v }, box); }); return resField(lbl, i); }
  function resNum(b, k, lbl, box) { const i = el('input'); i.type = 'number'; i.min = '1'; i.step = '1'; i.id = k + '-' + b._id; i.value = b[k] > 0 ? b[k] : ''; i.disabled = !S.canWrite; i.addEventListener('change', () => { const v = i.value === '' ? null : Math.round(Number(i.value)); saveBid(b._id, { [k]: v > 0 ? v : null }, box); }); return resField(lbl, i); }
  function resText(b, k, lbl, box, list) { const i = el('input'); i.type = 'text'; i.maxLength = 120; i.id = k + '-' + b._id; i.value = b[k] || ''; i.disabled = !S.canWrite; if (list) i.setAttribute('list', list); i.addEventListener('change', () => { let v = i.value.trim(); if (list === 'dl-comp' && v) { v = isUs(v) ? 'Fager-McGee' : canonComp(v); i.value = v; learnComps([v]); } saveBid(b._id, { [k]: v }, box); }); return resField(lbl, i); }
  function resSelect(b, k, lbl, opts, box) { const s = el('select'); s.id = k + '-' + b._id; s.disabled = !S.canWrite; const o0 = el('option', null, '— choose —'); o0.value = ''; s.appendChild(o0); const all = opts.slice(); if (b[k] && !all.includes(b[k])) all.push(b[k]); all.forEach(v => { const o = el('option', null, v); o.value = v; if (b[k] === v) o.selected = true; s.appendChild(o); }); s.addEventListener('change', () => saveBid(b._id, { [k]: s.value }, box)); return resField(lbl, s); }
  function resultsBlock(b) {
    const id = b._id, st = statusOf(b);
    const box = el('div', 'res'); const head = el('div', 'reshead');
    if (st === 'Passed') {
      head.appendChild(el('strong', null, 'No-bid decision')); box.appendChild(head);
      const g = el('div', 'resgrid');
      g.appendChild(resSelect(b, 'nobid_reason', 'Why we passed', NOBID_REASONS, box));
      g.appendChild(resText(b, 'nobid_by', 'Decided by', box));
      box.appendChild(g); return box;
    }
    head.appendChild(el('strong', null, 'Bid results'));
    if (!resultsDone(b)) head.appendChild(el('span', 'tag', FINAL_ST.has(st) ? 'Results incomplete' : 'Needs results'));
    const our = Number(b.res_our_bid) || 0, low = Number(b.res_low) || 0, tab = parseTab(b.res_tab), bits = [];
    if (our && low) {
      if (our <= low) { const second = tab.filter(x => !isUs(x.name))[0]; bits.push('We were low.' + (second && second.amount > our ? ' Next bidder ' + money(second.amount - our) + ' higher (' + ((second.amount - our) / our * 100).toFixed(1) + '%).' : '')); }
      else bits.push('We were ' + money(our - low) + ' (' + ((our - low) / low * 100).toFixed(1) + '%) over low.');
    }
    const band = sizeBand(our || Number(b.rom) || b.published_ceiling); if (band) bits.push('Size band ' + band + '.');
    if (bits.length) head.appendChild(el('span', 'fv', bits.join(' ')));
    box.appendChild(head);
    const g = el('div', 'resgrid');
    g.appendChild(resMoney(b, 'res_our_bid', 'Our base bid', box));
    g.appendChild(resMoney(b, 'res_low', 'Low bid', box));
    g.appendChild(resText(b, 'res_low_bidder', 'Low bidder', box, 'dl-comp'));
    g.appendChild(resNum(b, 'res_bidders', '# of bidders', box));
    g.appendChild(resNum(b, 'res_rank', 'Our rank', box));
    if (st === 'Lost' || st === 'No award') g.appendChild(resSelect(b, 'loss_reason', st === 'Lost' ? 'Loss reason' : 'Reason', LOSS_REASONS, box));
    if (st === 'Won') { g.appendChild(resText(b, 'job_no', 'Foundation job #', box)); g.appendChild(resMoney(b, 'final_contract', 'Contract amount', box)); }
    box.appendChild(g);
    const ta = el('textarea', 'note'); ta.id = 'tab-' + id; ta.rows = 3; ta.value = b.res_tab || ''; ta.disabled = !S.canWrite; ta.placeholder = 'Samron  $15,250,000\nFager-McGee  $15,480,000';
    ta.addEventListener('change', () => {
      const rows = parseTab(ta.value); const patch = { res_tab: ta.value };
      if (rows.length) {
        rows.forEach(r => { r.name = isUs(r.name) ? 'Fager-McGee' : canonComp(r.name); });
        if (!(b.res_low > 0)) patch.res_low = rows[0].amount;
        if (!b.res_low_bidder) patch.res_low_bidder = rows[0].name;
        if (!(b.res_bidders > 0)) patch.res_bidders = rows.length;
        const usIdx = rows.findIndex(r => isUs(r.name));
        if (usIdx >= 0) { if (!(b.res_rank > 0)) patch.res_rank = usIdx + 1; if (!(b.res_our_bid > 0)) patch.res_our_bid = rows[usIdx].amount; }
        learnComps(rows.map(r => r.name));
      }
      saveBid(id, patch, box);
    });
    box.appendChild(resField('Full bid tab (optional): one bidder per line, firm then amount. Blank fields above fill in from it.', ta, true));
    if (!FINAL_ST.has(st)) box.appendChild(el('span', 'msg', 'When the award is known, set the status above to Won, Lost, No award, Cancelled or Rebid.'));
    return box;
  }

  // One-line summary for a finished bid: estimators, ROM, our result and what is still missing.
  function compactSummary(b) {
    const row = el('div', 'csum');
    const team = teamOf(b);
    if (team.length) row.appendChild(el('span', 'cs', 'Est. ' + team.map(initials).join(' · ')));
    if (b.rom != null) row.appendChild(el('span', 'cs', 'ROM ' + money(b.rom)));
    const s = resultStats(b);
    if (s.our) {
      const place = s.rank === 1 ? 'FM low' : s.rank ? 'FM ' + ordinal(s.rank) : 'FM bid';
      row.appendChild(el('span', 'cs strong', place + (s.n > 1 ? ' of ' + s.n : '') + ' · ' + money(s.our) + (s.rank !== 1 && s.overPct != null ? ' (+' + pct(s.overPct) + ' over low)' : '') + (s.rank === 1 && s.gap2Pct != null ? ' (next +' + pct(s.gap2Pct) + ')' : '')));
    }
    const rv = romVsLowText(b); if (rv) row.appendChild(el('span', 'cs', rv));
    if ((needsResult(b) || statusOf(b) === 'Passed') && !resultsDone(b) && statusOf(b) !== 'Passed') row.appendChild(el('span', 'tag', !s.our ? 'Needs results' : 'Needs outcome'));
    if (b.notes) { const n = el('span', 'cs muted', '📝 ' + (b.notes.length > 60 ? b.notes.slice(0, 60) + '…' : b.notes)); n.title = b.notes; row.appendChild(n); }
    return row;
  }
  const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  // How our pre-bid ROM compared with the low bid (estimating accuracy).
  function romVsLowText(b) {
    const s = resultStats(b);
    if (b.rom == null || !(b.rom > 0) || !(s.low > 0)) return '';
    const d = (b.rom - s.low) / s.low * 100;
    return 'ROM vs low ' + (d >= 0 ? '+' : '−') + pct(Math.abs(d));
  }
  function romVsLow(b) {
    const t = romVsLowText(b); if (!t) return null;
    const box = el('div', 'romlow'); box.appendChild(el('span', 'fl', 'ROM vs low bid'));
    box.appendChild(el('span', 'fv', t.replace('ROM vs low ', '') + ' (ROM ' + money(b.rom) + ' · low ' + money(resultStats(b).low) + ')'));
    return box;
  }

  // ---- Results entry (bidder rows) ----
  const US = 'Fager-McGee';
  function bidRows(b) {
    if (Array.isArray(b.res_bids) && b.res_bids.length) return b.res_bids.map(r => ({ name: String(r.name || ''), amount: Number(r.amount) || 0 }));
    const tab = parseTab(b.res_tab);
    if (tab.length) return tab.map(r => ({ name: isUs(r.name) ? US : r.name, amount: r.amount }));
    const rows = [];
    if (b.res_our_bid > 0) rows.push({ name: US, amount: Number(b.res_our_bid) });
    if (b.res_low > 0 && b.res_low_bidder && !isUs(b.res_low_bidder)) rows.push({ name: b.res_low_bidder, amount: Number(b.res_low) });
    return rows;
  }
  function resultStats(b) {
    const rows = bidRows(b).filter(r => r.amount > 0).sort((a, z) => a.amount - z.amount);
    const usI = rows.findIndex(r => isUs(r.name));
    const our = usI >= 0 ? rows[usI].amount : (Number(b.res_our_bid) || 0);
    const low = rows.length ? rows[0].amount : (Number(b.res_low) || 0);
    const rank = Number(b.res_rank) || (usI >= 0 ? usI + 1 : null);
    const n = Math.max(rows.length, Number(b.res_bidders) || 0);
    const second = rank === 1 ? rows.find(r => !isUs(r.name) && r.amount > our) : null;
    return { rows, our, low, rank, n, lowName: rank === 1 ? US : ((rows[0] && rows[0].name) || b.res_low_bidder || ''), overPct: our && low && our > low ? (our - low) / low * 100 : null, gap2: second ? second.amount - our : null, gap2Pct: second && our ? (second.amount - our) / our * 100 : null };
  }
  function resultsCard(b) {
    const id = b._id, st = statusOf(b);
    if (st === 'Passed') return resultsBlock(b);
    const s = resultStats(b);
    const box = el('div', 'res'); const head = el('div', 'reshead');
    head.appendChild(el('strong', null, 'Bid results'));
    head.appendChild(el('span', 'tag muted', FINAL_ST.has(st) ? st : 'Award pending'));
    if (!resultsDone(b)) head.appendChild(el('span', 'tag', !s.our ? 'Needs results' : !FINAL_ST.has(st) ? 'Needs outcome' : 'Results incomplete'));
    box.appendChild(head);
    if (S.resEdit === id) { box.appendChild(resultsEditor(b, s)); return box; }
    let line = '';
    if (s.our && s.rank === 1) line = 'FM was low' + (s.n > 1 ? ' of ' + s.n + ' bidders' : '') + ' at ' + money(s.our) + '.' + (s.gap2 != null ? ' Next bid was ' + money(s.gap2) + ' (' + pct(s.gap2Pct) + ') higher.' : '');
    else if (s.our && s.rank) line = 'FM placed ' + s.rank + (s.n ? ' of ' + s.n : '') + ' at ' + money(s.our) + '.' + (s.overPct != null ? ' Low was ' + (s.lowName || 'not recorded') + ' at ' + money(s.low) + ', ' + money(s.our - s.low) + ' (' + pct(s.overPct) + ') under us.' : '');
    else if (s.our) line = 'Our bid: ' + money(s.our) + '. Add the other bids to see where we placed.';
    else line = 'No numbers logged yet.';
    box.appendChild(el('span', 'fv', line));
    if (s.rows.length > 1) {
      const t = el('table', 'htab small'); const hb = el('tbody');
      s.rows.forEach((r, i) => { const tr = el('tr', isUs(r.name) ? 'us' : null); [String(i + 1), r.name, money(r.amount), i === 0 ? 'Low' : '+' + pct((r.amount - s.low) / s.low * 100)].forEach((c, j) => tr.appendChild(el('td', j === 1 ? null : 'num', c))); hb.appendChild(tr); });
      t.appendChild(hb); box.appendChild(t);
    }
    const extra = [b.loss_reason ? 'Reason: ' + b.loss_reason : '', b.job_no ? 'Job #' + b.job_no : '', b.final_contract ? 'Contract ' + money(b.final_contract) : ''].filter(Boolean);
    if (extra.length) box.appendChild(el('span', 'fv', extra.join(' · ')));
    const btn = el('button', 'btn sec', s.our ? 'Edit results' : 'Log results'); btn.type = 'button'; btn.disabled = !S.canWrite;
    btn.addEventListener('click', () => { S.resEdit = id; S.resDraft = null; if (document.activeElement) document.activeElement.blur(); S.tableStale = false; renderTable(); setTimeout(() => { const x = document.getElementById('resamt-' + id + '-0'); if (x) x.focus(); }, 0); });
    const row = el('div', 'row'); row.appendChild(btn); box.appendChild(row);
    return box;
  }
  function resultsEditor(b, s) {
    const id = b._id, st = statusOf(b);
    if (!S.resDraft || S.resDraft.id !== id) {
      const rows = s.rows.map(r => ({ name: r.name, amount: r.amount }));
      if (!rows.some(r => isUs(r.name))) rows.unshift({ name: US, amount: s.our || null });
      while (rows.length < 3) rows.push({ name: '', amount: null });
      S.resDraft = { id, rows, out: RESULT_ST.has(st) ? st : 'Submitted' };
    }
    const D = S.resDraft;
    const w = el('div', 'resed');
    const top = el('div', 'resgrid');
    const oc = el('select'); oc.id = 'res-out-' + id;
    [['Submitted', 'Award pending'], ['Won', 'Won'], ['Lost', 'Lost'], ['No award', 'No award'], ['Cancelled', 'Cancelled'], ['Rebid', 'Rebid']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; if (D.out === v) o.selected = true; oc.appendChild(o); });
    top.appendChild(resField('Outcome', oc));
    const lr = el('select'); lr.id = 'res-loss-' + id; [''].concat(LOSS_REASONS).forEach(v => { const o = el('option', null, v || '— choose —'); o.value = v; if ((b.loss_reason || '') === v) o.selected = true; lr.appendChild(o); });
    const lrF = resField('Loss reason', lr); top.appendChild(lrF);
    const job = el('input'); job.type = 'text'; job.id = 'res-job-' + id; job.value = b.job_no || ''; job.maxLength = 40; const jobF = resField('Foundation job #', job); top.appendChild(jobF);
    const con = el('input'); con.type = 'text'; con.inputMode = 'decimal'; con.placeholder = '$0'; con.id = 'res-con-' + id; con.value = b.final_contract > 0 ? money(b.final_contract) : ''; const conF = resField('Contract amount', con); top.appendChild(conF);
    const syncF = () => { const v = oc.value; D.out = v; lrF.hidden = !(v === 'Lost' || v === 'No award'); jobF.hidden = v !== 'Won'; conF.hidden = v !== 'Won'; };
    oc.addEventListener('change', syncF); syncF();
    w.appendChild(top);
    w.appendChild(el('span', 'fl', 'Bids received: enter every number you have. Fager-McGee is always one row.'));
    const list = el('div', 'resrows');
    const draw = () => {
      list.textContent = '';
      D.rows.forEach((r, i) => {
        const line = el('div', 'resrow');
        const nm = el('input'); nm.type = 'text'; nm.setAttribute('list', 'dl-comp'); nm.placeholder = 'Bidder'; nm.value = r.name || ''; nm.id = 'resname-' + id + '-' + i; nm.setAttribute('aria-label', 'Bidder ' + (i + 1));
        nm.addEventListener('input', () => { r.name = nm.value; });
        const am = el('input'); am.type = 'text'; am.inputMode = 'decimal'; am.placeholder = '$0'; am.value = r.amount > 0 ? money(r.amount) : ''; am.id = 'resamt-' + id + '-' + i; am.setAttribute('aria-label', 'Bid amount ' + (i + 1));
        am.addEventListener('change', () => { const v = parseMoney(am.value); r.amount = Number.isNaN(v) ? null : v; am.value = r.amount > 0 ? money(r.amount) : ''; });
        const rm = el('button', 'ib', 'Remove'); rm.type = 'button'; rm.addEventListener('click', () => { D.rows.splice(i, 1); draw(); });
        line.appendChild(nm); line.appendChild(am); line.appendChild(rm); list.appendChild(line);
      });
    };
    draw(); w.appendChild(list);
    const add = el('button', 'ib', '+ Add bidder'); add.type = 'button'; add.addEventListener('click', () => { D.rows.push({ name: '', amount: null }); draw(); });
    const ar = el('div', 'row'); ar.appendChild(add); w.appendChild(ar);
    const msg = el('span', 'msg');
    const paste = el('textarea', 'note'); paste.rows = 3; paste.id = 'res-paste-' + id; paste.placeholder = 'Samron  $15,250,000\nFager-McGee  $15,480,000';
    const pb = el('button', 'ib', 'Fill the rows from this paste'); pb.type = 'button';
    pb.addEventListener('click', () => { const p = parseTab(paste.value); if (!p.length) { msg.className = 'msg err'; msg.textContent = 'No lines with a firm and an amount were found.'; return; } D.rows = p.map(r => ({ name: isUs(r.name) ? US : canonComp(r.name), amount: r.amount })); if (!D.rows.some(r => isUs(r.name))) D.rows.unshift({ name: US, amount: null }); draw(); paste.value = ''; msg.className = 'msg'; msg.textContent = D.rows.length + ' bids filled in. Check them, then Save results.'; });
    w.appendChild(resField('Or paste a bid tab: one bidder per line, firm then amount', paste, true));
    const pr = el('div', 'row'); pr.appendChild(pb); w.appendChild(pr);
    const ex = el('div', 'resgrid');
    const nIn = el('input'); nIn.type = 'number'; nIn.min = '1'; nIn.id = 'res-n-' + id; nIn.value = b.res_bidders > 0 ? b.res_bidders : ''; nIn.placeholder = 'Counted from rows';
    const rIn = el('input'); rIn.type = 'number'; rIn.min = '1'; rIn.id = 'res-r-' + id; rIn.value = b.res_rank > 0 ? b.res_rank : ''; rIn.placeholder = 'Counted from rows';
    ex.appendChild(resField('Total bidders (only if some numbers are missing)', nIn));
    ex.appendChild(resField('Our place (only if some numbers are missing)', rIn));
    w.appendChild(ex);
    const acts = el('div', 'row'); const save = el('button', 'btn', 'Save results'); save.type = 'button'; const cancel = el('button', 'btn sec', 'Cancel'); cancel.type = 'button';
    save.addEventListener('click', async () => {
      const clean = D.rows.map(r => ({ name: String(r.name || '').trim(), amount: Number(r.amount) || 0 })).filter(r => r.name && r.amount > 0).map(r => ({ name: isUs(r.name) ? US : canonComp(r.name), amount: r.amount })).sort((a, z) => a.amount - z.amount);
      const usI = clean.findIndex(r => isUs(r.name));
      if (usI < 0) { msg.className = 'msg err'; msg.textContent = 'Enter the Fager-McGee bid amount.'; return; }
      const nV = Math.round(Number(nIn.value)) || 0, rV = Math.round(Number(rIn.value)) || 0, conV = parseMoney(con.value);
      const patch = { status: oc.value, res_bids: clean, res_tab: '', res_our_bid: clean[usI].amount, res_low: clean[0].amount, res_low_bidder: clean[0].name, res_bidders: Math.max(clean.length, nV), res_rank: Math.max(usI + 1, rV), loss_reason: (oc.value === 'Lost' || oc.value === 'No award') ? lr.value : '', job_no: oc.value === 'Won' ? job.value.trim() : (b.job_no || ''), final_contract: oc.value === 'Won' && conV > 0 ? conV : (b.final_contract || null), res_logged_at: new Date().toISOString() };
      save.disabled = true;
      try { await S.db.doc('bids/' + id).update(patch); learnComps(clean.map(r => r.name)); S.resEdit = null; S.resDraft = null; if (document.activeElement) document.activeElement.blur(); S.tableStale = false; renderTable(); renderResults(); }
      catch (e) { save.disabled = false; writeFailed(e); }
    });
    cancel.addEventListener('click', () => { S.resEdit = null; S.resDraft = null; if (document.activeElement) document.activeElement.blur(); S.tableStale = false; renderTable(); });
    acts.appendChild(save); acts.appendChild(cancel); acts.appendChild(msg); w.appendChild(acts);
    return w;
  }

  // ---- Results & history view ----
  S.hf = { year: 'all', sector: 'all', delivery: 'all', who: 'all' };
  const pct = (v) => v == null || !isFinite(v) ? '—' : v.toFixed(1) + '%';
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const outcomeOf = (b, s) => FINAL_ST.has(statusOf(b)) ? statusOf(b) : (s.our ? 'Award pending' : 'Needs results');
  function histRows() {
    const f = S.hf;
    return S.bids.filter(needsResult).filter(b => (f.year === 'all' || (b.bid_date || '').slice(0, 4) === f.year) && (f.sector === 'all' || (b.sector || '(not set)') === f.sector) && (f.delivery === 'all' || (b.delivery || '(not set)') === f.delivery) && (f.who === 'all' || teamOf(b).includes(f.who))).map(b => ({ b, s: resultStats(b) })).sort((x, y) => (y.b.bid_date || '').localeCompare(x.b.bid_date || ''));
  }
  function histSelect(key, label, opts) {
    const w = el('label', 'hsel'); w.appendChild(document.createTextNode(label));
    const s = el('select'); s.id = 'hf-' + key;
    [['all', 'All']].concat(opts.map(o => [o, o])).forEach(([v, l]) => { const o = el('option', null, l); o.value = v; if (S.hf[key] === v) o.selected = true; s.appendChild(o); });
    s.addEventListener('change', () => { S.hf[key] = s.value; renderResults(); });
    w.appendChild(s); return w;
  }
  function jumpToBid(id) { if (VIEW !== 'schedule') { try { window.top.location.hash = '#/estimating?bid=' + encodeURIComponent(id); } catch (e) {} return; } const b = S.bids.find(x => x._id === id); if (!b) return; if (S.filter !== 'all' && !bidMatches(b)) { S.filter = 'all'; renderAll(); } setTimeout(() => { const c = document.getElementById('bid-' + id); if (c) { c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 1600); } }, 50); }
  function fillTable(sel, head, body, none) {
    const t = $(sel); if (!t) return; t.textContent = '';
    const th = el('thead'); const hr = el('tr'); head.forEach((h, i) => hr.appendChild(el('th', i ? 'num' : null, h))); th.appendChild(hr); t.appendChild(th);
    const tb = el('tbody');
    if (!body.length) { const tr = el('tr'); const td = el('td', null, none); td.colSpan = head.length; tr.appendChild(td); tb.appendChild(tr); }
    body.forEach(r => { const tr = el('tr'); r.forEach((c, i) => tr.appendChild(el('td', i ? 'num' : null, String(c)))); tb.appendChild(tr); });
    t.appendChild(tb);
  }
  function renderResults() {
    const fbox = $('#hist-filters'); if (!fbox) return;
    const all = S.bids.filter(needsResult);
    const uniq = (fn) => Array.from(new Set(all.map(fn))).filter(Boolean).sort();
    fbox.textContent = '';
    fbox.appendChild(histSelect('year', 'Year', uniq(b => (b.bid_date || '').slice(0, 4)).reverse()));
    fbox.appendChild(histSelect('sector', 'Sector', uniq(b => b.sector || '(not set)')));
    fbox.appendChild(histSelect('delivery', 'Delivery', uniq(b => b.delivery || '(not set)')));
    fbox.appendChild(histSelect('who', 'Estimator', S.team.estimators.map(e => e.name)));
    const csv = el('button', 'btn sec', 'Download CSV'); csv.type = 'button'; csv.addEventListener('click', downloadCsv); fbox.appendChild(csv);
    const rows = histRows();
    $('#hist-count').textContent = rows.length + ' bid' + (rows.length === 1 ? '' : 's') + ' shown';
    const won = rows.filter(r => statusOf(r.b) === 'Won'), lost = rows.filter(r => statusOf(r.b) === 'Lost'), dec = won.concat(lost);
    const wonAmt = won.reduce((t, r) => t + (r.s.our || 0), 0), decAmt = dec.reduce((t, r) => t + (r.s.our || 0), 0);
    const behind = rows.filter(r => r.s.overPct != null), near = behind.filter(r => r.s.overPct <= 3).length;
    const lows = rows.filter(r => r.s.rank === 1 && r.s.gap2Pct != null);
    const pending = rows.filter(r => !resultsDone(r.b)).length;
    const passed = S.bids.filter(b => statusOf(b) === 'Passed').length;
    const t = $('#hist-tiles'); t.textContent = '';
    [['Win rate', dec.length ? Math.round(won.length / dec.length * 100) + '%' : '—', won.length + ' won of ' + dec.length + ' decided'],
     ['Win rate by $', decAmt ? Math.round(wonAmt / decAmt * 100) + '%' : '—', moneyM(wonAmt) + ' won of ' + moneyM(decAmt) + ' bid'],
     ['FM was low', rows.filter(r => r.s.rank === 1).length + ' of ' + rows.filter(r => r.s.rank).length, 'Bids with a known place'],
     ['Avg. over low', pct(avg(behind.map(r => r.s.overPct))), near + ' near miss' + (near === 1 ? '' : 'es') + ' within 3%'],
     ['Left on the table', pct(avg(lows.map(r => r.s.gap2Pct))), 'Avg. gap to 2nd when we were low'],
     ['Still to log', pending, passed + ' passed (no-bid) not counted']].forEach(([l, v, sub]) => { const d = el('div', 'tile'); d.appendChild(el('span', 'lbl', l)); d.appendChild(el('span', 'num', String(v))); d.appendChild(el('span', 'sub', sub)); t.appendChild(d); });
    const tb = $('#hist-body'); tb.textContent = '';
    if (!rows.length) { const tr = el('tr'); const td = el('td', null, S.loaded ? 'No bids match these filters.' : 'Loading…'); td.colSpan = 11; tr.appendChild(td); tb.appendChild(tr); }
    rows.forEach(({ b, s }) => {
      const tr = el('tr');
      const cells = [fmtDay(b.bid_date), null, b.sector || '—', b.delivery || '—', teamOf(b).map(initials).join(', ') || '—', s.our ? money(s.our) : '—', s.low ? money(s.low) : '—', s.lowName || '—', s.rank ? s.rank + (s.n ? ' of ' + s.n : '') : '—', s.rank === 1 ? (s.gap2Pct != null ? 'Low by ' + pct(s.gap2Pct) : 'Low') : pct(s.overPct), outcomeOf(b, s) + (b.loss_reason ? ' · ' + b.loss_reason : '')];
      cells.forEach((c, i) => {
        const td = el('td', [5, 6, 8, 9].includes(i) ? 'num' : (i === 0 ? 'nw' : null));
        if (i === 1) { const pb = el('button', 'proj-btn', b.project); pb.type = 'button'; pb.addEventListener('click', () => jumpToBid(b._id)); td.appendChild(pb); }
        else td.textContent = c;
        if (i === 10 && !resultsDone(b)) td.classList.add('mustt');
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const bySec = new Map(); rows.forEach(r => { const k = r.b.sector || '(not set)'; if (!bySec.has(k)) bySec.set(k, []); bySec.get(k).push(r); });
    fillTable('#hist-sector', ['Sector', 'Bids', 'Won', 'Lost', 'Win %', 'Avg. over low'], Array.from(bySec.entries()).sort((a, z) => z[1].length - a[1].length).map(([k, list]) => { const w = list.filter(r => statusOf(r.b) === 'Won').length, l = list.filter(r => statusOf(r.b) === 'Lost').length; return [k, list.length, w, l, w + l ? Math.round(w / (w + l) * 100) + '%' : '—', pct(avg(list.filter(r => r.s.overPct != null).map(r => r.s.overPct)))]; }), 'No bids yet.');
    const comp = new Map();
    rows.forEach(({ b, s }) => { if (!s.our) return; s.rows.forEach((r, i) => { if (isUs(r.name)) return; const c = comp.get(r.name) || { n: 0, low: 0, beat: 0, diffs: [], last: '' }; c.n++; if (i === 0) c.low++; if (r.amount < s.our) c.beat++; c.diffs.push((r.amount - s.our) / s.our * 100); if ((b.bid_date || '') > c.last) c.last = b.bid_date; comp.set(r.name, c); }); });
    renderCompPanel(comp);
  }
  // ---- Competitors panel ----
  function lev(a, b) { if (Math.abs(a.length - b.length) > 2) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; }
  function usesOf(name) { return S.bids.filter(b => b.res_low_bidder === name || (Array.isArray(b.res_bids) && b.res_bids.some(r => r.name === name))).length; }
  async function renameComp(from, toRaw) {
    const to = String(toRaw || '').trim();
    if (!to) throw new Error('Type a name.');
    if (isUs(to)) throw new Error('That looks like Fager-McGee. Pick another name.');
    const target = (S.comps || []).find(c => c !== from && compKey(c) === compKey(to)) || to;
    const merging = target !== to || ((S.comps || []).includes(target) && target !== from);
    const next = (S.comps || []).filter(c => c !== from && c !== target).concat([target]).sort((a, z) => a.localeCompare(z));
    await S.db.doc('config/competitors').set({ names: next });
    for (const b of S.bids) {
      const patch = {};
      if (Array.isArray(b.res_bids) && b.res_bids.some(r => r.name === from)) patch.res_bids = b.res_bids.map(r => r.name === from ? { name: target, amount: r.amount } : r);
      if (b.res_low_bidder === from) patch.res_low_bidder = target;
      if (Object.keys(patch).length) await S.db.doc('bids/' + b._id).update(patch);
    }
    return merging ? 'Merged ' + from + ' into ' + target + '.' : 'Renamed ' + from + ' to ' + target + '.';
  }
  function renderCompPanel(comp) {
    const t = $('#hist-comp'); if (!t) return;
    if (S.compEdit && t.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const names = new Map(); (S.comps || []).forEach(n => names.set(n, true)); comp.forEach((c, n) => { if (!names.has(n)) names.set(n, false); });
    const all = Array.from(names.keys());
    const list = all.map(n => ({ n, c: comp.get(n) || null, listed: names.get(n) })).sort((a, z) => ((z.c && z.c.n) || 0) - ((a.c && a.c.n) || 0) || a.n.localeCompare(z.n));
    $('#comp-count').textContent = list.length + ' firm' + (list.length === 1 ? '' : 's');
    t.textContent = '';
    const th = el('thead'); const hr = el('tr'); ['Firm', 'Times faced', 'They were low', 'Beat FM', 'Avg. vs FM', 'Last faced', ''].forEach((h, i) => hr.appendChild(el('th', i && i < 6 ? 'num' : null, h))); th.appendChild(hr); t.appendChild(th);
    const tb = el('tbody');
    if (!list.length) { const tr = el('tr'); const td = el('td', null, 'No firms yet. Add one above, or log results on a card.'); td.colSpan = 7; tr.appendChild(td); tb.appendChild(tr); }
    const msg = $('#comp-msg');
    list.forEach(({ n, c, listed }) => {
      const tr = el('tr');
      const nameTd = el('td');
      if (S.compEdit === n) {
        const inp = el('input'); inp.type = 'text'; inp.value = n; inp.maxLength = 80; inp.setAttribute('list', 'dl-comp'); inp.id = 'comp-edit-input'; inp.setAttribute('aria-label', 'New name for ' + n);
        nameTd.appendChild(inp);
        nameTd.appendChild(el('span', 'msg', ' Type a new spelling, or another firm\'s name to merge into it.'));
        setTimeout(() => { const x = document.getElementById('comp-edit-input'); if (x && document.activeElement !== x) { x.focus(); x.select(); } }, 0);
        const ok = el('button', 'ib', 'Save'); ok.type = 'button'; const no = el('button', 'ib', 'Cancel'); no.type = 'button';
        ok.addEventListener('click', async () => { if (inp.value.trim() === n) { S.compEdit = null; renderResults(); return; } ok.disabled = true; try { const r = await renameComp(n, inp.value); S.compEdit = null; if (document.activeElement) document.activeElement.blur(); msg.className = 'msg'; msg.textContent = r; renderResults(); } catch (e) { ok.disabled = false; msg.className = 'msg err'; msg.textContent = e.message || 'That did not save.'; if (e.code) writeFailed(e); } });
        no.addEventListener('click', () => { S.compEdit = null; if (document.activeElement) document.activeElement.blur(); renderResults(); });
        inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') ok.click(); if (ev.key === 'Escape') no.click(); });
        tr.appendChild(nameTd);
        [c ? c.n : 0, c ? c.low : 0, c ? c.beat : 0, c ? ((avg(c.diffs) > 0 ? '+' : '') + pct(avg(c.diffs))) : '—', c && c.last ? fmtDay(c.last) : '—'].forEach(v => tr.appendChild(el('td', 'num', String(v))));
        const at = el('td'); const w = el('div', 'cacts'); w.appendChild(ok); w.appendChild(no); at.appendChild(w); tr.appendChild(at);
        tb.appendChild(tr); return;
      }
      nameTd.appendChild(document.createTextNode(n));
      if (!listed) nameTd.appendChild(el('span', 'tag muted', 'from results'));
      const k = compKey(n); const twin = all.find(o => o !== n && compKey(o).length > 4 && k.length > 4 && lev(k, compKey(o)) <= 2);
      if (twin) nameTd.appendChild(el('span', 'dupwarn', 'Same as ' + twin + '?'));
      tr.appendChild(nameTd);
      [c ? c.n : 0, c ? c.low : 0, c ? c.beat : 0, c ? ((avg(c.diffs) > 0 ? '+' : '') + pct(avg(c.diffs))) : '—', c && c.last ? fmtDay(c.last) : '—'].forEach(v => tr.appendChild(el('td', 'num', String(v))));
      const at = el('td'); const w = el('div', 'cacts');
      const rn = el('button', 'ib', 'Rename / merge'); rn.type = 'button'; rn.disabled = !S.canWrite; rn.addEventListener('click', () => { S.compEdit = n; if (document.activeElement) document.activeElement.blur(); renderResults(); });
      w.appendChild(rn);
      if (listed) {
        const used = usesOf(n);
        const rm = el('button', 'ib del', 'Remove'); rm.type = 'button'; rm.disabled = !S.canWrite || used > 0;
        rm.title = used ? 'Used in ' + used + ' logged bid' + (used > 1 ? 's' : '') + '. Merge it into another name instead.' : 'Take this firm off the list.';
        rm.addEventListener('click', async () => { rm.disabled = true; try { S.comps = (S.comps || []).filter(x => x !== n); await S.db.doc('config/competitors').set({ names: S.comps }); if (document.activeElement) document.activeElement.blur(); msg.className = 'msg'; msg.textContent = 'Removed ' + n + '.'; renderComps(); renderResults(); } catch (e) { rm.disabled = false; writeFailed(e); } });
        w.appendChild(rm);
      }
      at.appendChild(w); tr.appendChild(at); tb.appendChild(tr);
    });
    t.appendChild(tb);
  }
  async function addCompFromBox() {
    const inp = $('#comp-new'), m = $('#comp-msg'); const v = inp.value.trim(); if (!v) { inp.focus(); return; }
    if (!S.db || !S.canWrite) { m.className = 'msg err'; m.textContent = 'You need edit access to change the list.'; return; }
    if (isUs(v)) { m.className = 'msg err'; m.textContent = 'That looks like Fager-McGee.'; return; }
    const have = (S.comps || []).find(c => compKey(c) === compKey(v)); if (have) { m.className = 'msg err'; m.textContent = have + ' is already on the list.'; return; }
    try { await S.db.doc('config/competitors').set({ names: (S.comps || []).concat([v]).sort((a, z) => a.localeCompare(z)) }); inp.value = ''; m.className = 'msg'; m.textContent = 'Added ' + v + '.'; } catch (e) { writeFailed(e); }
  }

  async function downloadCsv() {
    const rows = histRows();
    const q = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['Bid date', 'Folder', 'Project', 'Owner', 'Sector', 'Delivery', 'Estimators', 'Our bid', 'Low bid', 'Low bidder', 'Our place', 'Bidders', '% over low', 'Gap to 2nd %', 'Outcome', 'Loss reason', 'Foundation job #', 'Contract', 'All bids'];
    const lines = [head.join(',')].concat(rows.map(({ b, s }) => [b.bid_date, b.id || b._id, b.project, b.owner, b.sector, b.delivery, teamOf(b).join('; '), s.our || '', s.low || '', s.lowName, s.rank || '', s.n || '', s.overPct != null ? s.overPct.toFixed(2) : '', s.gap2Pct != null ? s.gap2Pct.toFixed(2) : '', outcomeOf(b, s), b.loss_reason, b.job_no, b.final_contract || '', s.rows.map(r => r.name + ' ' + r.amount).join('; ')].map(q).join(',')));
    const dl = await claude.use('downloads');
    if (!dl) { showBanner('Downloads are not available in this view.'); return; }
    try { await dl.save({ filename: 'FM Bid Results ' + todayIso + '.csv', data: new Blob([lines.join('\n')], { type: 'text/csv' }) }); } catch (e) {}
  }

  function newBidDoc(f) {
    return { id: f.folder || '', project: f.project, owner: f.owner || '', architect: f.architect || '', bid_opening: f.bid_opening || '', location: f.location || '', sector: '', bid_date: f.date, bid_time: f.time || 'TBD', submit_method: '', published_ceiling: null, value_label: f.value || 'Not published', bid_security: '', labor: '', prebid: '', status: 'Not started', key_risk: '', source_doc: f.source || 'Added on the board', team: [], estimator: '', rom: null, notes: '', folder_name: f.folder_name || '', folder_uri: f.folder_uri || '', added_at: new Date().toISOString() };
  }
  const safeId = (s) => (s || '').replace(/[^A-Za-z0-9_\-.~:@+]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  async function addBid(f) {
    let id = safeId(f.folder) || safeId(f.project.toUpperCase()).slice(0, 40);
    if (!id) throw new Error('Give the bid a project name.');
    if (S.bids.some(b => b._id === id)) throw new Error('A bid with folder ' + id + ' is already on the board.');
    await S.db.doc('bids/' + id).set(newBidDoc(f));
    return id;
  }

  // ---- SharePoint sync ----
  function parseListing(result) {
    const texts = [];
    (result && result.content || []).forEach(c => { if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text); });
    if (!texts.length && typeof (result && result.payload) === 'string') texts.push(result.payload);
    const out = [];
    texts.join('\n').split(/\n+/).forEach(line => { const m = /^(.+?) \((folder|file), \d+ bytes\)\s+(file:\/\/\/\S+)/.exec(line.trim()); if (m && m[2] === 'folder') out.push({ name: m[1], uri: m[3] }); });
    return out;
  }
  function parseItems(result) {
    const out = [];
    resultText(result).split(/\n+/).forEach(line => { const m = /^(.+?) \((folder|file), (\d+) bytes\)\s+(file:\/\/\/\S+)/.exec(line.trim()); if (m) out.push({ name: m[1], type: m[2], size: +m[3], uri: m[4] }); });
    return out;
  }
  function resultText(result) {
    const texts = [];
    (result && result.content || []).forEach(c => { if (c && c.type === 'text' && typeof c.text === 'string') texts.push(c.text); });
    if (!texts.length && typeof (result && result.payload) === 'string') texts.push(result.payload);
    return texts.join('\n');
  }
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  function findBidDate(text, yearHint) {
    const t = (text || '').replace(/\s+/g, ' ');
    if (/does not (?:alter|change|modify)[^.]{0,60}bid date|bid date[^.]{0,40}(?:remains|is unchanged|has not changed|no change)/i.test(t)) return { noChange: true };
    const re = /[^.]{0,120}\b(?:bid(?:s)?|proposal(?:s)?)\b[^.]{0,40}\b(?:date|due|opening|received|deadline)\b[^.]{0,120}/ig;
    const dateRe = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?|\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/i;
    let m;
    while ((m = re.exec(t))) {
      const sent = m[0];
      const kw = /(mov|chang|revis|postpon|extend|new|reschedul|now|delay|push)/i.exec(sent); if (!kw) continue;
      const d = dateRe.exec(sent.slice(kw.index)) || dateRe.exec(sent); if (!d) continue;
      let y, mo, da;
      if (d[1]) { mo = MONTHS[d[1].toLowerCase().slice(0, 4)] || MONTHS[d[1].toLowerCase().slice(0, 3)]; da = +d[2]; y = d[3] ? +d[3] : yearHint; }
      else { mo = +d[4]; da = +d[5]; y = +d[6]; if (y < 100) y += 2000; }
      if (!mo || !da || da > 31) continue;
      const time = (/(\d{1,2}:\d{2}\s*[ap]\.?m\.?)/i.exec(sent) || [])[1] || '';
      return { date: y + '-' + String(mo).padStart(2, '0') + '-' + String(da).padStart(2, '0'), time: time.toUpperCase().replace(/\./g, '').replace(/\s*(AM|PM)/, ' $1'), quote: sent.trim().slice(0, 220) };
    }
    return null;
  }
  async function readText(mcp, uri) {
    try { return resultText(await mcp.callTool(SERVER, 'read_resource', { uri, startPage: 1, endPage: 3 }, { cache: false })); }
    catch (e) { if (e && e.retryable) { await new Promise(r => setTimeout(r, (e.retryAfterMs || 1500) + Math.random() * 800)); return resultText(await mcp.callTool(SERVER, 'read_resource', { uri, startPage: 1, endPage: 3 }, { cache: false })); } throw e; }
  }
  const addNum = (name) => { const m = /addend(?:um|a)\s*(?:no\.?|#)?\s*0*(\d+)/i.exec(name); return m ? +m[1] : null; };
  const DOC_FIELDS = [['owner', 'Owner'], ['architect', 'Architect'], ['location', 'Location'], ['bid_time', 'Bid time'], ['submit_method', 'How to submit'], ['bid_opening', 'Bid opening'], ['bid_security', 'Bid security'], ['value_label', 'Published value'], ['published_ceiling', 'Published ceiling'], ['description', 'Job description']];
  async function readCapped(mcp, uri, pages, cap) { try { const t = resultText(await mcp.callTool(SERVER, 'read_resource', { uri, startPage: 1, endPage: pages }, { cache: false })); return t.slice(0, cap); } catch (e) { if (e && e.code && e.code !== 'tool_error') throw e; return ''; } }
  async function extractFromDocs(sample, b, docs) {
    const prompt = 'You are reading bid documents for a commercial general contractor (Fager-McGee) to fill in a bid tracking board. ' +
      'Project on the board: "' + b.project + '" (folder ' + (b.id || b._id) + ', current bid date on board ' + (b.bid_date || 'unknown') + ').\n\n' +
      'Use ONLY what the documents say. When a later addendum changes something, the addendum wins. If a value is not stated, use null. Do not guess.\n' +
      'Reply with only one JSON object with these keys:\n' +
      '{"owner": string|null (owner/agency name, short), "architect": string|null (firm name, city in parentheses, and main contact if given, e.g. "Dodd Architects, PLLC (Anna) – Austin Walker"), ' +
      '"location": string|null ("City, ST"), "bid_date": "YYYY-MM-DD"|null (the CURRENT bid due date), "bid_time": string|null (e.g. "2:00 PM"), ' +
      '"submit_method": string|null (short, e.g. "CDB e-Builder", "Sealed, District Office", "Email to owner"), ' +
      '"bid_opening": string|null (where bids are received and opened, with room and street address if given, and whether public or private, e.g. "District Office, 593 Ava Road, Murphysboro, IL - public, read aloud" or "Public opening via WebEx, 2:00 PM" or "Private - emailed to owner"), ' +
      '"bid_security": string|null (short, e.g. "5% bid bond", "10% bid bond (CDB form)", "None"), ' +
      '"value_label": string|null (published budget or cost range exactly as stated, e.g. "Under $3,000,000"; null if none published), ' +
      '"published_ceiling": number|null (the dollar figure of that range or budget, else null), ' +
      '"prebid": {"date": "YYYY-MM-DD", "time": string|null, "location": string|null, "mandatory": boolean}|null, ' +
      '"description": string|null (2-3 plain sentences describing the work: building type, size, major scope; no risks, no contract terms)}\n\n' +
      docs.map(d => '=== ' + d.label + ': ' + d.name + ' ===\n' + d.text).join('\n\n');
    return await sample.json(prompt, { modelTier: 'quick' });
  }
  const norm = (v) => v == null ? '' : String(v).trim();
  // Match a SharePoint folder to a board bid: the folder's own link first, then the exact folder number. Never by date alone.
  const fid = (uri) => (uri || '').split('/').pop();
  function boardIndex() {
    const byUri = new Map(), byKey = new Map();
    S.bids.forEach(b => { if (b.folder_uri) byUri.set(fid(b.folder_uri), b); [b.id, b._id, folderKey(b.folder_name)].filter(Boolean).forEach(k => { if (!byKey.has(k)) byKey.set(k, b); }); });
    return (f) => byUri.get(fid(f.uri)) || (folderKey(f.name) && byKey.get(folderKey(f.name))) || null;
  }
  async function deepScan(mcp, all, msg) {
    const byKey = new Map(); all.forEach(f => { const k = folderKey(f.name); if (k) byKey.set(k, f); });
    const byFid = new Map(all.map(f => [fid(f.uri), f]));
    const targets = S.bids.filter(b => !CLOSED.has(statusOf(b))).map(b => ({ b, f: (b.folder_uri && byFid.get(fid(b.folder_uri))) || byKey.get(b.id) || byKey.get(folderKey(b.folder_name)) || (b.folder_uri ? { name: b.folder_name || b.project, uri: b.folder_uri } : null) })).filter(x => x.f);
    let n = 0, updated = 0; const flags = [];
    let SAMPLE = S.forceSkipDocs ? null : await claude.use('sample');
    for (const { b, f } of targets) {
      n++; msg.textContent = 'Checking ' + b.project + ' (' + n + ' of ' + targets.length + ')…';
      try {
        const top = parseItems(await readFolder(mcp, f.uri));
        const sub = (re) => top.find(x => x.type === 'folder' && re.test(x.name));
        // addenda: files in Addendums folder, plus one level of subfolders except ORIG copies
        const prev = new Map((b.addenda || []).map(a => [a.uri, a]));
        const addenda = [];
        const af = sub(/^addend/i);
        if (af) {
          const items = parseItems(await readFolder(mcp, af.uri));
          const files = items.filter(x => x.type === 'file');
          for (const sf of items.filter(x => x.type === 'folder' && !/^orig/i.test(x.name))) files.push(...parseItems(await readFolder(mcp, sf.uri)).filter(x => x.type === 'file'));
          for (const x of files.filter(x => /\.pdf$/i.test(x.name) && !/internal/i.test(x.name))) {
            const old = prev.get(x.uri);
            if (old) { addenda.push(old); continue; }
            let found = null;
            try { found = findBidDate(await readText(mcp, x.uri), +(b.bid_date || todayIso).slice(0, 4)); } catch (e) { found = { error: true }; }
            addenda.push({ name: x.name, uri: x.uri, number: addNum(x.name), found: found || null, seen: new Date().toISOString() });
          }
          addenda.sort((a, z) => (a.number || 99) - (z.number || 99) || a.name.localeCompare(z.name));
        }
        // bid bond
        let bond = '';
        const fe = sub(/^front end/i);
        if (fe) {
          const files = parseItems(await readFolder(mcp, fe.uri)).filter(x => x.type === 'file');
          if (files.some(x => /bid bond/i.test(x.name) && /execut/i.test(x.name))) bond = 'Bid bond executed';
          else if (files.some(x => /bond request/i.test(x.name) && /\d{4}-\d{2}-\d{2}|bid bond -/i.test(x.name))) bond = 'Bid bond requested';
          else if (files.some(x => /bond request/i.test(x.name) && !/AC & CW|DB & CW|form - /i.test(x.name))) bond = 'Bid bond requested';
        }
        // documents: project manual analysis, bid ad / invitation, newest addenda
        const docFiles = [];
        const pmf = sub(/^project manual/i);
        if (pmf) { const pm = parseItems(await readFolder(mcp, pmf.uri)).filter(x => x.type === 'file' && /analysis/i.test(x.name) && /\.pdf$/i.test(x.name)); pm.forEach(x => docFiles.push({ label: 'Project Manual Analysis', x, pages: 4, cap: 40000 })); }
        if (fe) { const fes = parseItems(await readFolder(mcp, fe.uri)).filter(x => x.type === 'file' && /\.pdf$/i.test(x.name) && /(advertis|invitation|ad for bid|notice to bidders|00\s*11\s*1[36]|bid form|instructions to bidders)/i.test(x.name) && !/execut/i.test(x.name)); fes.slice(0, 3).forEach(x => docFiles.push({ label: 'Bid documents (Front End)', x, pages: 3, cap: 15000 })); }
        if (!docFiles.length) { const rootDocs = top.filter(x => x.type === 'file' && /\.pdf$/i.test(x.name) && /(advertis|invitation|analysis|00\s*11\s*13)/i.test(x.name)); rootDocs.slice(0, 2).forEach(x => docFiles.push({ label: 'Bid documents', x, pages: 3, cap: 15000 })); }
        addenda.slice(-3).forEach(a => docFiles.push({ label: 'Addendum', x: { name: a.name, uri: a.uri, size: 0 }, pages: 2, cap: 8000 }));
        const sig = docFiles.map(d => d.x.uri + ':' + (d.x.size || 0)).sort().join('|');
        let docPatch = {};
        if (docFiles.length && SAMPLE && (sig !== b.doc_sig || S.forceReread || b.bid_opening === undefined)) {
          msg.textContent = 'Reading ' + b.project + ' documents (' + n + ' of ' + targets.length + ')…';
          const docs = [];
          for (const d of docFiles) { const text = await readCapped(mcp, d.x.uri, d.pages, d.cap); if (text.trim()) docs.push({ label: d.label, name: d.x.name, text }); }
          let ex = null;
          if (docs.length) {
            try { ex = await extractFromDocs(SAMPLE, b, docs); }
            catch (e) { if (e && (e.code === 'not_granted' || e.code === 'unavailable')) { SAMPLE = null; S.sampleNote = 'Document reading was not allowed, so owner, architect and description were not updated.'; } else if (e && e.code === 'rate_limited') { S.sampleNote = 'Claude is busy; some jobs were skipped. Run the check again in a few minutes.'; } }
          }
          if (ex && typeof ex === 'object') {
            const prevSp = b.sp_values || {}; const sp = {}; const suggest = [];
            DOC_FIELDS.forEach(([k, label]) => {
              let nv = ex[k]; if (k === 'published_ceiling') nv = typeof nv === 'number' && nv > 0 ? Math.round(nv) : null; else nv = nv == null ? null : String(nv).trim() || null;
              if (nv == null) return;
              sp[k] = nv;
              const cur = b[k];
              const blank = cur == null || norm(cur) === '' || (k === 'value_label' && /^not published/i.test(norm(cur)) && !/^not published/i.test(String(nv)));
              const untouched = prevSp[k] != null && norm(prevSp[k]) === norm(cur);
              if (norm(cur) === norm(nv)) return;
              if (b.sp_keep && b.sp_keep[k] != null && norm(b.sp_keep[k]) === norm(nv)) return;
              if (blank || untouched) docPatch[k] = nv;
              else suggest.push({ field: k, label, current: cur, value: nv });
            });
            if (ex.bid_date && /^\d{4}-\d{2}-\d{2}$/.test(ex.bid_date)) {
              sp.bid_date = ex.bid_date;
              if (!b.bid_date) docPatch.bid_date = ex.bid_date;
              else if (ex.bid_date !== b.bid_date && b.date_flag_ignored !== 'documents:' + ex.bid_date) docPatch.date_flag = { date: ex.bid_date, time: ex.bid_time || '', source: 'Bid documents', quote: '' };
            }
            if (ex.prebid && ex.prebid.date && /^\d{4}-\d{2}-\d{2}$/.test(ex.prebid.date)) {
              const have = S.deadlines.some(d => d.kind === 'Pre-bid' && (d.bid_id === b._id || d.project === b.project) && d.date === ex.prebid.date);
              if (!have && S.canWrite) { try { await S.db.collection('deadlines').add({ bid_id: b._id, project: b.project, date: ex.prebid.date, time: ex.prebid.time || '', kind: 'Pre-bid', event: 'Pre-bid' + (ex.prebid.location ? ', ' + ex.prebid.location : ''), mandatory: !!ex.prebid.mandatory, attendees: [] }); } catch (e) {} }
              if (!norm(b.prebid)) docPatch.prebid = fmtDay(ex.prebid.date) + (ex.prebid.time ? ', ' + ex.prebid.time : '') + (ex.prebid.mandatory ? ' (MANDATORY)' : ' (not mandatory)');
            }
            if (b.bid_opening === undefined && docPatch.bid_opening === undefined) docPatch.bid_opening = '';
            docPatch.sp_values = sp; docPatch.suggest = suggest; docPatch.doc_sig = sig;
            docPatch.source_doc = docs.map(d => d.label + ': ' + d.name).join('; ');
            updated++;
          }
        }
        const latest = addenda.filter(a => a.found && a.found.date).slice(-1)[0];
        const dateFlag = latest && latest.found.date !== b.bid_date && b.date_flag_ignored !== latest.name ? { date: latest.found.date, time: latest.found.time || '', source: latest.name, quote: latest.found.quote } : null;
        const patch = Object.assign({ addenda, bond_status: bond, sp_checked_at: new Date().toISOString() }, dateFlag ? { date_flag: dateFlag } : {}, docPatch);
        if (bond && !norm(b.bid_security) && !docPatch.bid_security) patch.bid_security = bond === 'Bid bond executed' ? 'Bid bond (executed)' : 'Bid bond';
        if (!b.folder_uri) patch.folder_uri = f.uri;
        if (!b.folder_name) patch.folder_name = f.name;
        if (S.canWrite) await S.db.doc('bids/' + b._id).update(patch);
        if (dateFlag || patch.date_flag) flags.push({ b, flag: dateFlag || patch.date_flag });
      } catch (e) { if (e && e.code && e.code !== 'tool_error') throw e; }
    }
    return { count: targets.length, flags, updated };
  }
  function syncError(e) {
    const code = e && e.code;
    if (code === 'server_not_connected') return 'Add Microsoft 365 in claude.ai Settings → Connectors, then try again.';
    if (code === 'needs_reauth') return 'Your Microsoft 365 connection needs to be reconnected in claude.ai Settings → Connectors.';
    if (code === 'not_in_manifest') return 'Microsoft 365 is turned off for this page. Turn it on from the page\'s Permissions menu.';
    if (code === 'selection_required') return 'Choose which Microsoft 365 connection to use when prompted, then try again.';
    if (code === 'blocked_by_policy' || code === 'approval_required') return 'Your organization blocks this Microsoft 365 call from the page.';
    if (code === 'tool_error') return 'SharePoint refused the request: ' + (e.message || 'no detail given') + '.';
    return 'SharePoint did not answer. Try again in a minute.';
  }
  async function readFolder(mcp, uri) {
    try { return await mcp.callTool(SERVER, 'read_resource', { uri }, { cache: false }); }
    catch (e) { if (e && e.retryable) { await new Promise(r => setTimeout(r, (e.retryAfterMs || 1500) + Math.random() * 800)); return await mcp.callTool(SERVER, 'read_resource', { uri }, { cache: false }); } throw e; }
  }
  async function runSync(fromClick) {
    const msg = $('#sync-msg'), btn = $('#sync-btn');
    const mcp = await claude.use('mcp');
    if (!mcp) { msg.className = 'msg err'; msg.textContent = 'SharePoint checks need this board opened in Claude with Microsoft 365 connected.'; return; }
    const folders = (S.sp && S.sp.folders) || [];
    if (!folders.length) { msg.className = 'msg err'; msg.textContent = 'No SharePoint folders are set up for this board yet. Ask Claude to add them.'; return; }
    btn.disabled = true; msg.className = 'msg'; msg.textContent = fromClick ? 'Refreshing time off…' : 'Reading Current Projects…';
    if (fromClick) { try { await refreshTimeOff(false); } catch (e) {} msg.textContent = 'Reading Current Projects…'; }
    try {
      let all = [];
      for (const f of folders) { const res = await readFolder(mcp, f.uri); all = all.concat(parseListing(res).map(x => Object.assign(x, { area: f.label }))); }
      S.spFolders = all;
      renderSync();
      msg.textContent = all.length + ' project folders read.';
      if (fromClick && S.db) {
        let added = 0;
        if (S.canWrite) {
          const found = boardIndex(); const addedKeys = new Set();
          for (const f of all) {
            const key = folderKey(f.name), d = prefixDate(f.name);
            if (!key || !d || d < todayIso || found(f) || addedKeys.has(key) || S.ignored.has(fid(f.uri))) continue;
            const name = f.name.slice(key.length).replace(/^[\s-]+/, '');
            try { await addBid({ folder: key, project: name || f.name, date: d, time: 'TBD', folder_name: f.name, folder_uri: f.uri, source: 'SharePoint ' + f.area }); added++; addedKeys.add(key); } catch (e) {}
          }
          if (added) await new Promise(r => setTimeout(r, 1500));
        }
        S.sampleNote = '';
        const r = await deepScan(mcp, all, msg);
        msg.textContent = all.length + ' folders read · ' + (added ? added + ' new job' + (added > 1 ? 's' : '') + ' added · ' : '') + r.count + ' open bids checked · ' + r.updated + ' updated from documents' + (r.flags.length ? ' · ' + r.flags.length + ' possible bid date change' + (r.flags.length > 1 ? 's' : '') : '') + '.' + (S.sampleNote ? ' ' + S.sampleNote : '');
        S.forceReread = false; const fr = $('#force-reread'); if (fr) fr.checked = false;
        if (S.canWrite) { try { await S.db.doc('config/sync').set({ checkedAt: new Date().toISOString(), folders: all.length, deep: r.count }); } catch (e) {} }
      }
    } catch (e) { msg.className = 'msg err'; msg.textContent = syncError(e); }
    finally { btn.disabled = false; }
  }
  function renderSync() {
    const when = $('#sync-when');
    when.textContent = S.sync && S.sync.checkedAt ? 'Last checked ' + new Date(S.sync.checkedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Not checked yet';
    if (!S.spFolders) return;
    $('#sync-out').hidden = false;
    const found = boardIndex();
    const fresh = [], diffs = [], matched = new Set();
    S.spFolders.forEach(f => {
      const key = folderKey(f.name), d = prefixDate(f.name);
      const b = found(f);
      if (b) { matched.add(b._id); if (d && b.bid_date && d !== b.bid_date) diffs.push({ f, b, d }); }
      else if (d && d >= todayIso && !S.ignored.has(fid(f.uri))) fresh.push({ f, d });
    });
    const missing = openBids().filter(b => !matched.has(b._id));
    const list = (ulId, cntId, items, make, none) => { const ul = $(ulId); ul.textContent = ''; $(cntId).textContent = items.length; if (!items.length) { const li = el('li', 'none', none); ul.appendChild(li); return; } items.forEach(it => ul.appendChild(make(it))); };
    list('#l-new', '#c-new', fresh.sort((a, b) => a.d.localeCompare(b.d)), ({ f, d }) => {
      const li = el('li'); const nm = el('div', 'nm', f.name); nm.appendChild(el('small', null, f.area + ' · bid ' + fmtDay(d))); li.appendChild(nm);
      const btn = el('button', 'btn', 'Add'); btn.type = 'button'; btn.disabled = !S.canWrite || !S.db;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const key = folderKey(f.name); const name = f.name.slice(key.length).replace(/^[\s-]+/, '');
        try { await addBid({ folder: key, project: name || f.name, date: d, time: 'TBD', folder_name: f.name, folder_uri: f.uri, source: 'SharePoint ' + f.area }); btn.textContent = 'Added'; }
        catch (e) { btn.disabled = false; $('#sync-msg').className = 'msg err'; $('#sync-msg').textContent = e.message || 'That bid did not save.'; if (e.code) writeFailed(e); }
      });
      li.appendChild(btn); return li;
    }, 'Everything dated today or later is on the board.');
    list('#l-miss', '#c-miss', missing, (b) => { const li = el('li'); const nm = el('div', 'nm', b.project); nm.appendChild(el('small', null, 'Bid ' + fmtDay(b.bid_date) + ' · create a folder in Current Projects')); li.appendChild(nm); return li; }, 'Every open bid has a folder.');
    list('#l-diff', '#c-diff', diffs, ({ f, b, d }) => { const li = el('li'); const nm = el('div', 'nm', b.project); nm.appendChild(el('small', null, 'Folder says ' + fmtDay(d) + ' · board says ' + fmtDay(b.bid_date))); li.appendChild(nm); return li; }, 'Folder dates match the board.');
    const fl = S.bids.filter(b => b.date_flag && b.date_flag.date && b.date_flag.date !== b.bid_date);
    list('#l-flag', '#c-flag', fl, (b) => { const li = el('li'); const nm = el('div', 'nm', b.project); nm.appendChild(el('small', null, b.date_flag.source + ' says ' + fmtDay(b.date_flag.date) + ' · board says ' + fmtDay(b.bid_date))); li.appendChild(nm); const ap = el('button', 'btn', 'Use new date'); ap.type = 'button'; ap.disabled = !S.canWrite; ap.addEventListener('click', () => { const patch = { bid_date: b.date_flag.date, date_flag: null }; if (b.date_flag.time) patch.bid_time = b.date_flag.time; saveBid(b._id, patch); }); li.appendChild(ap); return li; }, 'No addendum date changes found.');
  }

  const STOP = new Set(['building','project','renovation','school','center','elementary','addition','construct','rebid','new','the','and','phase','office','college','community']);
  const words = (n) => (n || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w));
  function findDups() {
    const out = new Map(); const list = S.bids;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const wa = new Set(words(a.project)), shared = words(b.project).filter(w => wa.has(w));
      const sameName = a.project.trim().toLowerCase() === b.project.trim().toLowerCase();
      const close = a.bid_date && b.bid_date && Math.abs(parse(a.bid_date) - parse(b.bid_date)) <= 3 * 864e5;
      if (sameName || (shared.length && close)) { if (!out.has(b._id)) out.set(b._id, a.project + ' (' + a._id + ')'); if (!out.has(a._id)) out.set(a._id, b.project + ' (' + b._id + ')'); }
    }
    return out;
  }

  const FIELDS = [['project', 'Project name', 'text', true], ['owner', 'Owner', 'text'], ['architect', 'Architect', 'text'], ['location', 'Location', 'text'], ['sector', 'Sector', 'select', false, SECTORS], ['delivery', 'Delivery', 'select', false, DELIVERY], ['submit_method', 'How to submit', 'text'], ['bid_opening', 'Bid opening location', 'text'], ['value_label', 'Published value (as shown)', 'text'], ['published_ceiling', 'Published ceiling (for totals)', 'money'], ['bid_security', 'Bid security', 'text'], ['prebid', 'Pre-bid (text)', 'text'], ['description', 'Job description', 'area'], ['source_doc', 'Source documents', 'area']];
  function editorFor(b) {
    const id = b._id; const box = el('div', 'ed');
    const inputs = {};
    FIELDS.forEach(([k, label, type, req, opts]) => {
      const lab = el('label' + '', type === 'area' ? 'full' : null); lab.appendChild(document.createTextNode(label));
      const inp = type === 'area' ? el('textarea') : type === 'select' ? el('select') : el('input');
      if (type === 'select') { const o0 = el('option', null, '— choose —'); o0.value = ''; inp.appendChild(o0); const all = opts.slice(); if (b[k] && !all.includes(b[k])) all.push(b[k]); all.forEach(v => { const o = el('option', null, v + (opts.includes(v) ? '' : ' (old value)')); o.value = v; inp.appendChild(o); }); }
      else if (type !== 'area') inp.type = type === 'money' ? 'text' : type;
      if (type === 'money') { inp.inputMode = 'decimal'; inp.placeholder = '$0'; }
      inp.id = 'ed-' + k + '-' + id; inp.value = b[k] == null ? '' : (type === 'money' ? money(b[k]) : b[k]); inp.disabled = !S.canWrite; if (req) inp.required = true;
      lab.appendChild(inp); box.appendChild(lab); inputs[k] = inp;
    });
    box.appendChild(el('h4', null, 'Calendar events for this bid'));
    const evs = S.deadlines.filter(d => d.kind !== 'Bid' && (d.bid_id === id || (!d.bid_id && d.project === b.project))).sort((x, y) => (x.date || '').localeCompare(y.date || ''));
    if (!evs.length) box.appendChild(el('span', 'msg', 'No pre-bids or deadlines yet.'));
    evs.forEach(d => box.appendChild(eventRow(b, d)));
    const addEv = el('button', 'ib', '+ Add pre-bid or deadline'); addEv.type = 'button'; addEv.disabled = !S.canWrite;
    addEv.addEventListener('click', async () => {
      try { await S.db.collection('deadlines').add({ bid_id: id, project: b.project, date: b.bid_date || todayIso, time: '', kind: 'Pre-bid', event: 'Pre-bid', mandatory: false }); } catch (e) { writeFailed(e); }
    });
    const ar = el('div', 'acts'); ar.appendChild(addEv); box.appendChild(ar);
    const acts = el('div', 'acts');
    const save = el('button', 'btn', 'Save changes'); save.type = 'button'; save.disabled = !S.canWrite;
    const cancel = el('button', 'btn sec', 'Close'); cancel.type = 'button';
    const m = el('span', 'msg');
    save.addEventListener('click', async () => {
      const patch = {};
      let bad = false; FIELDS.forEach(([k, , type]) => { const v = inputs[k].value; let nv = type === 'money' ? parseMoney(v) : v.trim(); if (Number.isNaN(nv)) { bad = true; return; } const ov = b[k] == null ? (type === 'money' ? null : '') : b[k]; if (nv !== ov) patch[k] = nv; });
      if (bad) { m.className = 'msg err'; m.textContent = 'Enter dollar amounts like $3,000,000 or 3M.'; return; }
      if (!patch.project && patch.project !== undefined) { m.className = 'msg err'; m.textContent = 'Project name cannot be blank.'; return; }
      if (!Object.keys(patch).length) { m.className = 'msg'; m.textContent = 'Nothing changed.'; return; }
      save.disabled = true;
      try { await S.db.doc('bids/' + id).update(patch); m.className = 'msg'; m.textContent = 'Saved.'; S.editing = null; S.tableStale = true; setTimeout(() => { if (document.activeElement) document.activeElement.blur(); renderTable(); }, 400); }
      catch (e) { save.disabled = false; writeFailed(e); }
    });
    cancel.addEventListener('click', () => { S.editing = null; renderTable(); });
    acts.appendChild(save); acts.appendChild(cancel); acts.appendChild(m); box.appendChild(acts);
    return box;
  }
  function eventRow(b, d) {
    const row = el('div', 'evrow');
    const dt = el('input'); dt.type = 'date'; dt.value = d.date || ''; dt.id = 'ev-date-' + d._id; dt.setAttribute('aria-label', 'Event date');
    const tm = el('input'); tm.type = 'text'; tm.value = d.time || ''; tm.placeholder = 'Time'; tm.id = 'ev-time-' + d._id; tm.setAttribute('aria-label', 'Event time');
    const kd = el('select'); kd.id = 'ev-kind-' + d._id; kd.setAttribute('aria-label', 'Event type');
    [['Pre-bid', 'Pre-bid'], ['Questions', 'Deadline']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; if (d.kind === v) o.selected = true; kd.appendChild(o); });
    const tx = el('input'); tx.type = 'text'; tx.value = d.event || ''; tx.placeholder = 'What (e.g. Pre-bid on site)'; tx.id = 'ev-text-' + d._id; tx.setAttribute('aria-label', 'Event description');
    const mlab = el('label', 'chk'); const mc = el('input'); mc.type = 'checkbox'; mc.checked = !!d.mandatory; mc.id = 'ev-must-' + d._id; mlab.appendChild(mc); mlab.appendChild(document.createTextNode('Mandatory'));
    const del = el('button', 'ib del', 'Remove'); del.type = 'button';
    [dt, tm, kd, tx, mc, del].forEach(x => { x.disabled = !S.canWrite; });
    const save = async (patch) => { try { await S.db.doc('deadlines/' + d._id).update(Object.assign({ bid_id: b._id, project: b.project }, patch)); } catch (e) { writeFailed(e); } };
    dt.addEventListener('change', () => { if (dt.value) save({ date: dt.value }); });
    tm.addEventListener('change', () => save({ time: tm.value.trim() }));
    kd.addEventListener('change', () => save({ kind: kd.value }));
    tx.addEventListener('change', () => save({ event: tx.value.trim() }));
    mc.addEventListener('change', () => save({ mandatory: mc.checked }));
    del.addEventListener('click', async () => {
      const keep = Object.assign({}, d); delete keep._id;
      try { await S.db.doc('deadlines/' + d._id).delete(); offerUndo('Removed ' + (d.event || 'event') + ' on ' + fmtDay(d.date) + '.', async () => { await S.db.doc('deadlines/' + d._id).set(keep); }); } catch (e) { writeFailed(e); }
    });
    [dt, tm, kd, tx, mlab, del].forEach(x => row.appendChild(x));
    return row;
  }
  async function deleteBid(id) {
    const b = S.bids.find(x => x._id === id); if (!b) return;
    const keep = Object.assign({}, b); delete keep._id;
    const evs = S.deadlines.filter(d => d.bid_id === id).map(d => { const k = Object.assign({}, d); const did = k._id; delete k._id; return [did, k]; });
    try {
      await S.db.doc('bids/' + id).delete();
      for (const [did] of evs) { try { await S.db.doc('deadlines/' + did).delete(); } catch (e) {} }
      const ign = b.folder_uri ? fid(b.folder_uri) : '';
      if (ign) { try { await S.db.doc('ignored/' + ign).set({ folder_name: b.folder_name || b.project, deleted_at: new Date().toISOString() }); } catch (e) {} }
      S.confirmDel = null; if (S.editing === id) S.editing = null;
      offerUndo('Deleted ' + b.project + (ign ? '. The SharePoint check will skip its folder.' : '.'), async () => { await S.db.doc('bids/' + id).set(keep); for (const [did, k] of evs) await S.db.doc('deadlines/' + did).set(k); if (ign) { try { await S.db.doc('ignored/' + ign).delete(); } catch (e) {} } });
    } catch (e) { writeFailed(e); }
  }
  let toastTimer = null;
  async function moveEvent(t, toDate) {
    if (!t || !toDate || t.from === toDate || !S.db) return;
    const hol = holidayOn(toDate);
    let holNote = hol && hol.kind !== 'optional' ? ' Heads up: ' + fmtDay(toDate) + ' is ' + (hol.kind === 'closed' ? 'a company holiday (office closed)' : hol.name + ' (most office staff off)') + '.' : '';
    { let ppl = [];
      if (t.kind === 'bid') { const b = S.bids.find(x => x._id === t.id); if (b) ppl = teamOf(b); }
      else { const d = S.deadlines.find(x => x._id === t.id); if (d) { ppl = goingTo(d); if (!ppl.length && d.kind === 'Pre-bid') { const b = S.bids.find(x => x._id === d.bid_id) || S.bids.find(x => x.project === d.project); if (b) ppl = teamOf(b); } } }
      const cl = clashes(ppl, toDate); if (cl.length) holNote += ' Time off: ' + clashText(cl, toDate) + '.'; }
    try {
      if (t.kind === 'bid') {
        const b = S.bids.find(x => x._id === t.id); if (!b) return;
        const prev = b.bid_date;
        await S.db.doc('bids/' + t.id).update({ bid_date: toDate });
        offerUndo('Moved ' + t.label + ' from ' + fmtDay(prev) + ' to ' + fmtDay(toDate) + '.' + holNote, async () => { await S.db.doc('bids/' + t.id).update({ bid_date: prev }); });
      } else {
        const d = S.deadlines.find(x => x._id === t.id); if (!d) return;
        const prev = d.date;
        await S.db.doc('deadlines/' + t.id).update({ date: toDate });
        offerUndo('Moved ' + t.label + ' from ' + fmtDay(prev) + ' to ' + fmtDay(toDate) + '.' + holNote, async () => { await S.db.doc('deadlines/' + t.id).update({ date: prev }); });
      }
    } catch (e) { writeFailed(e); }
  }
  function offerUndo(msg, fn) {
    S.undo = fn; $('#toast-msg').textContent = msg; $('#toast').hidden = false; $('#toast-undo').disabled = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; S.undo = null; }, 12000);
  }
  $('#toast-undo').addEventListener('click', async () => { const fn = S.undo; if (!fn) return; $('#toast-undo').disabled = true; try { await fn(); $('#toast-msg').textContent = 'Restored.'; } catch (e) { writeFailed(e); } S.undo = null; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 2500); });


  // ---- PDF export ----
  async function makePdf() {
    const msg = $('#pdf-msg'); msg.className = 'msg'; msg.textContent = 'Building PDF…';
    try {
      if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('lib');
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });
      if (typeof doc.autoTable !== 'function') throw new Error('lib');
      const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 32;
      const ORANGE = [241, 90, 34], CHAR = [45, 45, 45], MID = [74, 74, 74], SOFT = [107, 107, 107], TINT = [242, 242, 242], LINE = [208, 208, 208];
      const logo = document.querySelector('.brand img').src;
      const who = S.filter === 'all' ? 'Everyone' : S.filter === '__none' ? 'Unassigned bids' : S.filter;
      const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const header = (title) => {
        try { doc.addImage(logo, 'JPEG', M, 22, 150, 26); } catch (e) {}
        doc.setDrawColor(...ORANGE); doc.setLineWidth(2); doc.line(M, 56, W - M, 56);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...CHAR); doc.text(title, M, 76);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...SOFT);
        doc.text('Showing: ' + who + '   ·   Printed ' + stamp, W - M, 76, { align: 'right' });
      };
      const footer = () => {
        const n = doc.internal.getNumberOfPages();
        for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(...SOFT); doc.text('Fager-McGee Commercial Construction · 347 S. Williams St., Murphysboro, IL 62966 · 618-687-3900', W / 2, H - 16, { align: 'center' }); doc.text('Page ' + i + ' of ' + n, W - M, H - 16, { align: 'right' }); }
      };
      // calendar
      header('Bid Calendar');
      const evsAll = calEvents();
      const byProj = new Map(S.bids.map(b => [b.project, b])); const byId = new Map(S.bids.map(b => [b._id, b]));
      const ds = evsAll.map(e => e.date).filter(Boolean).sort();
      const body = [], meta = [];
      if (ds.length) {
        let w = parse(monday(ds[0] < todayIso ? ds[0] : todayIso)); const last = parse(monday(ds[ds.length - 1]));
        const byDay = new Map(); evsAll.forEach(r => { if (!byDay.has(r.date)) byDay.set(r.date, []); byDay.get(r.date).push(r); });
        const seenP = new Set();
        while (w <= last) {
          newMonthsInWeek(iso(w), seenP).forEach(md => { body.push([{ content: monthName(md).toUpperCase(), colSpan: 5, styles: { fillColor: CHAR, textColor: 255, fontStyle: 'bold', fontSize: 9, minCellHeight: 0, cellPadding: 4 } }]); meta.push(null); });
          const row = [], mrow = [];
          for (let i = 0; i < 5; i++) {
            const d = new Date(w); d.setUTCDate(d.getUTCDate() + i); const key = iso(d);
            const hol = holidayOn(key);
            const lines = [d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + (hol ? (hol.kind === 'closed' ? '   OFFICE CLOSED – ' : hol.kind === 'mostoff' ? '   MOST OFFICE OFF – ' : '   OPTIONAL HOLIDAY (office open) – ') + hol.name.toUpperCase() : '')];
            if (S.types.has('off')) { const po = offsOn(key).filter(o => S.filter === 'all' || normName(o.name) === normName(S.filter)); if (po.length) lines.push('OFF: ' + po.map(o => initials(o.name) + (Number(o.hours) < 8 ? ' ' + (+o.hours) + 'h' : '') + (o.status === 'pending' ? ' (pending)' : '')).join(', ')); }
            (byDay.get(key) || []).slice().sort((a, b) => tmin(a.time) - tmin(b.time)).forEach(e => {
              const b = e._bid || (e.bid_id && byId.get(e.bid_id)) || byProj.get(e.project);
              const ppl = e.kind === 'Pre-bid' && goingTo(e).length ? goingTo(e) : (b ? teamOf(b) : null);
              if (!evShown(e, b, ppl)) return;
              const lab = e.kind === 'Bid' ? 'BID' : e.kind === 'Pre-bid' ? (e.mandatory ? 'MANDATORY PRE-BID' : 'Pre-bid') : e.kind === 'Internal' ? 'Internal' : 'Deadline';
              const ini = ppl && ppl.length ? ' [' + ppl.map(initials).join(', ') + ']' : '';
              const pcl = (e.kind === 'Bid' || e.kind === 'Pre-bid') && ppl ? clashes(ppl, key) : [];
              lines.push(lab + ' ' + (e.time || '') + ini + '\n' + (e.kind === 'Internal' ? e.event : (b ? b.project : e.project)) + (pcl.length ? '\n! ' + pcl.map(o => initials(o.name) + ' out').join(', ') : ''));
            });
            row.push(lines.join('\n')); mrow.push({ past: key < todayIso, today: key === todayIso, hol: hol ? hol.kind : '' });
          }
          body.push(row); meta.push(mrow); w.setUTCDate(w.getUTCDate() + 7);
        }
      }
      doc.autoTable({
        startY: 88, margin: { left: M, right: M, bottom: 30 }, head: [['Mon', 'Tue', 'Wed', 'Thu', 'Fri']], body,
        theme: 'grid', styles: { font: 'helvetica', fontSize: 6.8, cellPadding: 3, valign: 'top', textColor: CHAR, lineColor: LINE, lineWidth: 0.5, minCellHeight: 56, overflow: 'linebreak' },
        headStyles: { fillColor: MID, textColor: 255, fontStyle: 'bold', minCellHeight: 0 }, rowPageBreak: 'avoid',
        didParseCell: (h) => { if (h.section !== 'body' || !meta[h.row.index]) return; const mm = meta[h.row.index][h.column.index]; if (!mm) return; if (mm.past) h.cell.styles.fillColor = TINT; if (mm.hol === 'closed' || mm.hol === 'mostoff') { h.cell.styles.fillColor = [214, 214, 214]; h.cell.styles.textColor = MID; } else if (mm.hol === 'optional') { h.cell.styles.fillColor = [236, 236, 236]; } if (mm.today) { h.cell.styles.lineColor = ORANGE; h.cell.styles.lineWidth = 1.5; } }
      });
      // schedule
      doc.addPage(); header('Bid Schedule');
      const rows = S.bids.filter(b => !isLead(b) && !offSchedule(b)).sort((a, b) => (a.bid_date || '9').localeCompare(b.bid_date || '9')).filter(bidMatches);
      const sbody = rows.map(b => {
        const pre = prebidsFor(b).map(d => fmtDay(d.date) + (d.time ? ' ' + d.time : '') + (d.mandatory ? ' (MANDATORY)' : '') + (goingTo(d).length ? ' — ' + goingTo(d).map(initials).join(', ') : '')).join('\n') || (b.prebid || '');
        return [fmtDay(b.bid_date) + '\n' + (b.bid_time || '') + (b.bid_opening ? '\n' + b.bid_opening : ''), b.project + '\n' + [b.id || b._id, b.location].filter(Boolean).join(' · '), (b.owner || '—') + '\n' + (b.architect || '—'), teamOf(b).map(initials).join(', ') || '—', pre, b.value_label || '', b.rom == null ? '' : money(b.rom), statusOf(b), b.bid_security || '', b.description || '', b.notes || ''];
      });
      doc.autoTable({
        startY: 88, margin: { left: M, right: M, bottom: 30 },
        head: [['Bid due / opening', 'Project', 'Owner / Architect', 'Estimators', 'Pre-bid / who is going', 'Value', 'FM ROM', 'Status', 'Bid security', 'Job description', 'Notes']], body: sbody,
        theme: 'grid', styles: { font: 'helvetica', fontSize: 7, cellPadding: 3.5, valign: 'top', textColor: CHAR, lineColor: LINE, lineWidth: 0.5, overflow: 'linebreak' },
        headStyles: { fillColor: MID, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: TINT },
        columnStyles: { 0: { cellWidth: 64 }, 1: { cellWidth: 96, fontStyle: 'bold' }, 2: { cellWidth: 80 }, 3: { cellWidth: 40 }, 4: { cellWidth: 78 }, 5: { cellWidth: 58 }, 6: { cellWidth: 50 }, 7: { cellWidth: 44 }, 8: { cellWidth: 52 }, 9: { cellWidth: 'auto' }, 10: { cellWidth: 66 } },
        didParseCell: (h) => { if (h.section === 'head' && h.column.index === 5) h.cell.styles.fillColor = ORANGE; }
      });
      footer();
      const blob = doc.output('blob');
      const dl = await claude.use('downloads');
      if (!dl) { msg.className = 'msg err'; msg.textContent = 'Downloads are not available in this view.'; return; }
      const res = await dl.save({ filename: 'FM Bid Board ' + todayIso + '.pdf', data: blob });
      msg.textContent = res && res.status === 'saved' ? 'PDF saved.' : '';
    } catch (e) {
      msg.className = 'msg err';
      msg.textContent = e && e.message === 'lib' ? 'The PDF tools did not load. Reload the page and try again.' : (e && e.code === 'cancelled' || e && e.code === 'declined') ? '' : 'The PDF could not be saved. Try again.';
    }
  }
  $('#pdf-btn').addEventListener('click', makePdf);
  claude.use('downloads').then(dl => { $('#pdf-btn').hidden = !dl; }).catch(() => {});


  // ---- Possible bids · Go / No-Go (FM Workforce) ----
  // A possible bid is a bid with status Lead. The six-question scorecard and its weights come from
  // the Workforce server (Estimating settings); the score is the share of points earned, 0-100.
  const RATING = { good: 1, ok: 0.5, poor: 0 };
  const RATE_LBL = [['good', 'Good'], ['ok', 'OK'], ['poor', 'Poor']];
  const FM = { me: null, scorecard: null, nobid: NOBID_REASONS, sources: [] };
  (window.FM_READY || Promise.resolve(null)).then(x => { if (x) Object.assign(FM, x); { const ss = $('#g-sector'); if (ss && !ss.options.length) ['', ...SECTORS].forEach(v => { const o = el('option', null, v || '—'); o.value = v; ss.appendChild(o); }); }
    const sel = $('#g-source'); if (sel) { sel.textContent = ''; [''].concat(FM.sources || []).forEach(v => { const o = el('option', null, v || '—'); o.value = v; sel.appendChild(o); }); } renderGoNoGo(); });
  function scoreOf(b) {
    const cfg = FM.scorecard; if (!cfg) return null;
    const r = (b.scorecard && b.scorecard.ratings) || {};
    let earned = 0, total = 0, rated = 0, gate = null, worst = null;
    cfg.questions.forEach(q => { const w = Number(q.weight) || 0; total += w; if (!(r[q.key] in RATING)) return; rated++; const v = RATING[r[q.key]]; earned += w * v; if (q.gate && r[q.key] === 'poor' && !gate) gate = q; const lost = w * (1 - v); if (lost > 0 && (!worst || lost > worst.lost)) worst = { q, lost }; });
    const score = total ? Math.round(earned / total * 100) : 0, complete = rated === cfg.questions.length;
    const suggestion = gate ? 'no_go' : complete ? (score >= cfg.go_at ? 'go' : score >= cfg.review_at ? 'review' : 'no_go') : null;
    const why = gate || (worst && worst.q); return { score, rated, of: cfg.questions.length, suggestion, reason: why ? why.reason : null, gate: gate ? gate.label : null };
  }
  const SUG = { go: ['Suggested Go', 'go'], review: ['Your call', 'review'], no_go: ['Suggested No-Go', 'nogo'] };
  const meName = () => (FM.me && FM.me.name) || 'Someone';
  async function decide(b, decision) {
    const sc = scoreOf(b) || {}; const card = document.getElementById('gng-' + b._id);
    const note = card ? (card.querySelector('.gnote') || {}).value || '' : '';
    const picked = card ? Array.from(card.querySelectorAll('.greasons input:checked')).map(x => x.value) : [];
    const reasons = picked.length ? picked : (sc.reason ? [sc.reason] : []);
    if (decision === 'no_go' && !reasons.length) { showBanner('Tick at least one reason for the No-Go.'); return; }
    const reason = reasons.join(', ');
    const prev = { status: b.status || 'Lead', decision: b.decision || null, decision_score: b.decision_score ?? null, decision_note: b.decision_note || '', decided_by: b.decided_by || '', decided_at: b.decided_at || '', nobid_reason: b.nobid_reason || '', nobid_reasons: b.nobid_reasons || [], nobid_by: b.nobid_by || '' };
    const patch = decision === 'go'
      ? { status: 'Not started', decision: 'go', decision_score: sc.rated ? sc.score : null, decision_note: note.trim(), decided_by: meName(), decided_at: new Date().toISOString() }
      : { status: 'Passed', decision: 'no_go', decision_score: sc.rated ? sc.score : null, decision_note: note.trim(), decided_by: meName(), decided_at: new Date().toISOString(), nobid_reason: reasons[0] || '', nobid_reasons: reasons, nobid_by: meName() };
    try { await S.db.doc('bids/' + b._id).update(patch); offerUndo((decision === 'go' ? 'Go: ' + b.project + ' is on the bid schedule.' : 'No-Go logged: ' + b.project + ' (' + reason + ').'), async () => { await S.db.doc('bids/' + b._id).update(prev); }); }
    catch (e) { writeFailed(e); }
  }
  const UNDECIDE = { status: 'Lead', decision: null, decision_score: null, decision_note: '', decided_by: '', decided_at: '', nobid_reason: '', nobid_reasons: [], nobid_by: '' };
  const reasonsOf = (b) => Array.isArray(b.nobid_reasons) && b.nobid_reasons.length ? b.nobid_reasons : (b.nobid_reason ? String(b.nobid_reason).split(/,\s*/).filter(Boolean) : []);
  const decidedYear = (b) => (b.decided_at || b.bid_date || '').slice(0, 4);
  const ceilingOf = (b) => Number(b.published_ceiling) || 0;
  function renderGngTiles() {
    const t = $('#gng-tiles'); if (!t) return; t.textContent = '';
    const yr = todayIso.slice(0, 4);
    const decided = S.bids.filter(b => b.decision && decidedYear(b) === yr);
    const go = decided.filter(b => b.decision === 'go').length;
    const passed = S.bids.filter(b => isPassed(b) && decidedYear(b) === yr);
    const tally = {}; passed.forEach(b => reasonsOf(b).forEach(r => { tally[r] = (tally[r] || 0) + 1; }));
    const top = Object.entries(tally).sort((a, z) => z[1] - a[1])[0];
    [['Waiting on a decision', S.bids.filter(isLead).length, 'Possible bids not yet Go or No-Go'],
     ['Go rate ' + yr, decided.length ? Math.round(go / decided.length * 100) + '%' : '—', go + ' Go of ' + decided.length + ' decided'],
     ['Passed ' + yr, passed.length, money(passed.reduce((x, b) => x + ceilingOf(b), 0)) + ' in published value'],
     ['Top no-bid reason', top ? top[0] : '—', top ? top[1] + ' job' + (top[1] > 1 ? 's' : '') + ' this year' : 'No passed jobs this year']].forEach(([l, v, sb], i) => {
      const d = el('div', 'tile'); d.appendChild(el('span', 'lbl', l)); d.appendChild(el('span', 'num' + (i === 3 ? ' small' : ''), String(v))); d.appendChild(el('span', 'sub', sb)); t.appendChild(d);
    });
  }
  function plRows() {
    const f = S.pf;
    return S.bids.filter(isPassed).filter(b => (f.year === 'all' || decidedYear(b) === f.year) && (f.reason === 'all' || reasonsOf(b).includes(f.reason)) && (f.sector === 'all' || (b.sector || '(not set)') === f.sector) && (f.who === 'all' || (b.decided_by || b.nobid_by || '') === f.who))
      .sort((a, z) => (z.decided_at || z.bid_date || '').localeCompare(a.decided_at || a.bid_date || ''));
  }
  function plSelect(key, label, opts) {
    const w = el('label', 'hsel'); w.appendChild(document.createTextNode(label));
    const sl = el('select'); sl.id = 'pf-' + key;
    [['all', 'All']].concat(opts.map(o => [o, o])).forEach(([v, l]) => { const o = el('option', null, l); o.value = v; if (S.pf[key] === v) o.selected = true; sl.appendChild(o); });
    sl.addEventListener('change', () => { S.pf[key] = sl.value; S.plOpen = null; renderPassed(); });
    w.appendChild(sl); return w;
  }
  function renderPassed() {
    const fbox = $('#pl-filters'), tbl = $('#pl-table'); if (!fbox || !tbl) return;
    if (tbl.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const all = S.bids.filter(isPassed);
    const uniq = (fn) => Array.from(new Set(all.flatMap(fn))).filter(Boolean).sort();
    fbox.textContent = '';
    const years = uniq(b => [decidedYear(b)]).reverse(); if (!years.includes(S.pf.year) && S.pf.year !== 'all') years.unshift(S.pf.year);
    fbox.appendChild(plSelect('year', 'Year', years));
    fbox.appendChild(plSelect('reason', 'Reason', Array.from(new Set((FM.nobid || NOBID_REASONS).concat(uniq(reasonsOf))))));
    fbox.appendChild(plSelect('sector', 'Sector', uniq(b => [b.sector || '(not set)'])));
    fbox.appendChild(plSelect('who', 'Decided by', uniq(b => [b.decided_by || b.nobid_by || ''])));
    const csv = el('button', 'btn sec', 'Download CSV'); csv.type = 'button'; csv.addEventListener('click', downloadPassedCsv); fbox.appendChild(csv);
    const rows = plRows();
    $('#pl-count').textContent = rows.length + ' passed job' + (rows.length === 1 ? '' : 's') + ' shown';
    tbl.textContent = '';
    const head = ['Bid date', 'Decided', 'Project', 'Owner', 'Architect', 'Sector', 'Value', 'Score', 'Gate failed', 'Reasons', 'Decided by', 'Who got it', 'Winning price'];
    const NUMC = new Set(['Value', 'Score', 'Winning price']);
    const th = el('thead'); const hr = el('tr'); head.forEach(h => hr.appendChild(el('th', NUMC.has(h) ? 'num' : null, h))); th.appendChild(hr); tbl.appendChild(th);
    const tb = el('tbody');
    if (!rows.length) { const tr = el('tr'); const td = el('td', null, 'No passed jobs match these filters.'); td.colSpan = head.length; tr.appendChild(td); tb.appendChild(tr); }
    rows.forEach(b => {
      const sc = scoreOf(b) || {}; const open = S.plOpen === b._id;
      const tr = el('tr', 'plrow' + (open ? ' open' : '')); tr.tabIndex = 0; tr.title = open ? 'Hide details' : 'Show the scorecard and notes';
      const toggle = () => { S.plOpen = open ? null : b._id; renderPassed(); };
      tr.addEventListener('click', toggle); tr.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') toggle(); });
      const score = b.decision_score != null ? b.decision_score : (sc.rated ? sc.score : null);
      [b.bid_date ? fmtDay(b.bid_date) : '—', b.decided_at ? fmtDay(b.decided_at.slice(0, 10)) : '—', (open ? '▾ ' : '▸ ') + b.project, b.owner || '—', b.architect || '—', b.sector || '—',
        ceilingOf(b) ? money(ceilingOf(b)) : (b.value_label || '—'), score != null ? String(score) : '—', sc.gate || '—', reasonsOf(b).join(', ') || '—', b.decided_by || b.nobid_by || '—',
        b.passed_winner || '—', b.passed_amount ? money(b.passed_amount) : '—'].forEach((c, i) => tr.appendChild(el('td', NUMC.has(head[i]) ? 'num' : null, c)));
      tb.appendChild(tr);
      if (open) tb.appendChild(passedDetail(b, head.length));
    });
    tbl.appendChild(tb);
    renderAnalysis();
  }
  function passedDetail(b, cols) {
    const tr = el('tr', 'pldet'); const td = el('td'); td.colSpan = cols; tr.appendChild(td);
    const wrap = el('div', 'plwrap');
    const left = el('div');
    left.appendChild(el('span', 'fl', 'Scorecard'));
    const ratings = (b.scorecard && b.scorecard.ratings) || {}; const notes = b.score_notes || {};
    const ul = el('ul', 'plsc');
    ((FM.scorecard && FM.scorecard.questions) || []).forEach(q => {
      const li = el('li'); const r = ratings[q.key];
      li.appendChild(el('span', 'tog r-' + (r || 'none'), r ? RATE_LBL.find(x => x[0] === r)[1] : '—'));
      li.appendChild(el('strong', null, ' ' + q.label + (q.gate ? ' (gate)' : '')));
      if (notes[q.key]) li.appendChild(el('span', 'why', ' – ' + notes[q.key]));
      ul.appendChild(li);
    });
    left.appendChild(ul);
    if (b.decision_note) { left.appendChild(el('span', 'fl', 'Note')); left.appendChild(el('p', 'fv', b.decision_note)); }
    [['Location', b.location], ['Bid date', b.bid_date ? fmtDay(b.bid_date) : ''], ['How we heard', b.source], ['Delivery', b.delivery]].forEach(([l, v]) => { if (v) { const p = el('div', 'fv'); p.appendChild(el('span', 'fl', l + ' ')); p.appendChild(document.createTextNode(v)); left.appendChild(p); } });
    wrap.appendChild(left);
    const right = el('div', 'plgot');
    right.appendChild(el('span', 'fl', 'Who got it (after the bid opens)'));
    const w = el('input'); w.type = 'text'; w.maxLength = 80; w.placeholder = 'Winning contractor'; w.value = b.passed_winner || ''; w.setAttribute('list', 'dl-comp'); w.disabled = !S.canWrite; w.setAttribute('aria-label', 'Who got ' + b.project);
    const a = el('input'); a.type = 'text'; a.inputMode = 'decimal'; a.placeholder = 'Winning price'; a.value = b.passed_amount ? money(b.passed_amount) : ''; a.disabled = !S.canWrite; a.setAttribute('aria-label', 'Winning price for ' + b.project);
    const sv = el('button', 'ib', 'Save'); sv.type = 'button'; sv.disabled = !S.canWrite;
    sv.addEventListener('click', async (ev) => { ev.stopPropagation(); const v = a.value.trim() ? parseMoney(a.value) : null; if (Number.isNaN(v)) { showBanner('Enter the price as a dollar amount, like $1,250,000 or 1.25M.'); return; } try { await S.db.doc('bids/' + b._id).update({ passed_winner: w.value.trim(), passed_amount: v }); if (w.value.trim()) learnComps([w.value.trim()]); } catch (e) { writeFailed(e); } });
    [w, a, sv].forEach(x => { x.addEventListener('click', ev => ev.stopPropagation()); right.appendChild(x); });
    if (b.passed_amount && ceilingOf(b)) right.appendChild(el('div', 'fv muted', 'Winning price was ' + pct((b.passed_amount - ceilingOf(b)) / ceilingOf(b) * 100).replace(/^(\d)/, '+$1') + ' vs the published value.'));
    const back = el('button', 'btn sec', 'Back to undecided'); back.type = 'button'; back.disabled = !S.canWrite;
    back.addEventListener('click', async (ev) => { ev.stopPropagation(); try { await S.db.doc('bids/' + b._id).update(UNDECIDE); S.plOpen = null; } catch (e) { writeFailed(e); } });
    right.appendChild(back);
    wrap.appendChild(right); td.appendChild(wrap);
    return tr;
  }
  function renderAnalysis() {
    const rows = S.bids.filter(isPassed).filter(b => S.pf.year === 'all' || decidedYear(b) === S.pf.year);
    const group = (keyFn) => { const m = new Map(); rows.forEach(b => [].concat(keyFn(b)).forEach(k => { const g = m.get(k) || { n: 0, v: 0 }; g.n++; g.v += ceilingOf(b); m.set(k, g); })); return Array.from(m.entries()).sort((a, z) => z[1].n - a[1].n); };
    fillTable('#an-reason', ['Reason', 'Jobs', 'Published value'], group(b => reasonsOf(b).length ? reasonsOf(b) : ['(none given)']).map(([k, g]) => [k, g.n, g.v ? money(g.v) : '—']), 'No passed jobs yet.');
    fillTable('#an-arch', ['Architect', 'Jobs', 'Published value'], group(b => b.architect || '(not set)').map(([k, g]) => [k, g.n, g.v ? money(g.v) : '—']), 'No passed jobs yet.');
    fillTable('#an-sector', ['Sector', 'Jobs', 'Published value'], group(b => b.sector || '(not set)').map(([k, g]) => [k, g.n, g.v ? money(g.v) : '—']), 'No passed jobs yet.');
    fillTable('#an-month', ['Month', 'Jobs', 'Published value'], group(b => (b.decided_at || b.bid_date || '').slice(0, 7) || '(no date)').sort((a, z) => z[0].localeCompare(a[0])).map(([k, g]) => [k === '(no date)' ? k : new Date(k + '-01T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }), g.n, g.v ? money(g.v) : '—']), 'No passed jobs yet.');
    // Does the Go score predict wins? Go decisions with a score and a final won / lost outcome.
    const bands = [['80 and up', 80, 101], ['60 – 79', 60, 80], ['Under 60', 0, 60]];
    const goes = S.bids.filter(b => b.decision === 'go' && b.decision_score != null && ['Won', 'Lost'].includes(statusOf(b)));
    fillTable('#an-score', ['Go score', 'Bids', 'Won', 'Lost', 'Win rate'], bands.map(([l, lo, hi]) => { const g = goes.filter(b => b.decision_score >= lo && b.decision_score < hi); const w = g.filter(b => statusOf(b) === 'Won').length; return [l, g.length, w, g.length - w, g.length ? Math.round(w / g.length * 100) + '%' : '—']; }), 'No scored Go bids with a result yet.');
    const note = $('#an-note'); if (note) note.textContent = goes.length < 10 ? 'Win rate by score gets meaningful after about 10 scored Go bids with a result (' + goes.length + ' so far).' : goes.length + ' scored Go bids with a result.';
  }
  async function downloadPassedCsv() {
    const rows = plRows();
    const q = (v) => { const x = v == null ? '' : String(v); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const qsList = (FM.scorecard && FM.scorecard.questions) || [];
    const head = ['Decided', 'Bid date', 'Folder', 'Project', 'Owner', 'Architect', 'Location', 'Sector', 'Delivery', 'Published value', 'Score', 'Gate failed', 'Reasons', 'Note', 'Decided by', 'Winner', 'Winning price'].concat(qsList.flatMap(qq => [qq.label, qq.label + ' – why']));
    const lines = [head.join(',')].concat(rows.map(b => { const sc = scoreOf(b) || {}; const r = (b.scorecard && b.scorecard.ratings) || {}; const n = b.score_notes || {};
      return [b.decided_at ? b.decided_at.slice(0, 10) : '', b.bid_date, b.id || b._id, b.project, b.owner, b.architect, b.location, b.sector, b.delivery, ceilingOf(b) || '', b.decision_score ?? (sc.rated ? sc.score : ''), sc.gate || '', reasonsOf(b).join('; '), b.decision_note, b.decided_by || b.nobid_by, b.passed_winner, b.passed_amount || ''].concat(qsList.flatMap(qq => [r[qq.key] || '', n[qq.key] || ''])).map(q).join(','); }));
    const dl = await claude.use('downloads');
    if (!dl) { showBanner('Downloads are not available in this view.'); return; }
    try { await dl.save({ filename: 'FM Passed Jobs ' + todayIso + '.csv', data: new Blob([lines.join('\n')], { type: 'text/csv' }) }); } catch (e) {}
  }
  function renderGoNoGo() {
    const list = $('#gng-list'); if (!list) return;
    if (list.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') { S.gngStale = true; return; }
    S.gngStale = false; list.textContent = '';
    const leads = S.bids.filter(isLead).sort((a, z) => (a.bid_date || '9').localeCompare(z.bid_date || '9'));
    $('#gng-count').textContent = leads.length ? leads.length + ' waiting on a decision' : 'Nothing waiting';
    if (!leads.length) list.appendChild(el('div', 'card empty', S.loaded ? 'No possible bids waiting. Add one when it comes in.' : 'Loading…'));
    leads.forEach(b => {
      const sc = scoreOf(b); const ratings = (b.scorecard && b.scorecard.ratings) || {};
      const card = el('article', 'card gcard'); card.id = 'gng-' + b._id;
      const db = el('div', 'dblk');
      if (b.bid_date) { const d = parse(b.bid_date); db.appendChild(el('span', 'mo', d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }))); db.appendChild(el('span', 'dd', String(d.getUTCDate()))); db.appendChild(el('span', 'wd', d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))); }
      else db.appendChild(el('span', 'wd', 'No date'));
      card.appendChild(db);
      const main = el('div', 'cmain'); const head = el('div', 'chead'); const ttl = el('div', 'ttl');
      const pbtn = el('button', 'proj-btn', b.project); pbtn.type = 'button'; pbtn.title = 'Edit details';
      pbtn.addEventListener('click', () => { S.editing = b._id; renderGoNoGo(); });
      ttl.appendChild(pbtn);
      ttl.appendChild(el('span', 'o', [b.owner, b.location, b.value_label && b.value_label !== 'Not published' ? b.value_label : '', b.source ? 'via ' + b.source : ''].filter(Boolean).join(' · ')));
      { const af = el('label', 'garch'); af.appendChild(el('span', 'fl', 'Architect')); const ai = el('input'); ai.type = 'text'; ai.maxLength = 120; ai.placeholder = 'Firm (city) – contact'; ai.value = b.architect || ''; ai.disabled = !S.canWrite; ai.setAttribute('aria-label', 'Architect for ' + b.project); ai.addEventListener('change', async () => { try { await S.db.doc('bids/' + b._id).update({ architect: ai.value.trim() }); } catch (e) { writeFailed(e); } }); af.appendChild(ai);
        af.appendChild(el('span', 'fl', 'Sector')); const ss = el('select'); ss.disabled = !S.canWrite; ss.setAttribute('aria-label', 'Sector for ' + b.project);
        ['', ...SECTORS.concat(b.sector && !SECTORS.includes(b.sector) ? [b.sector] : [])].forEach(v => { const o = el('option', null, v || '—'); o.value = v; if ((b.sector || '') === v) o.selected = true; ss.appendChild(o); });
        ss.addEventListener('change', async () => { try { await S.db.doc('bids/' + b._id).update({ sector: ss.value }); } catch (e) { writeFailed(e); } }); af.appendChild(ss);
        ttl.appendChild(af); }
      head.appendChild(ttl);
      const right = el('div', 'cright');
      const box = el('div', 'gscore ' + (sc && sc.suggestion ? SUG[sc.suggestion][1] : ''));
      box.appendChild(el('span', 'gv', sc && sc.rated ? String(sc.score) : '—'));
      box.appendChild(el('span', 'gl', sc && sc.suggestion ? SUG[sc.suggestion][0] : sc ? sc.rated + ' of ' + sc.of + ' rated' : 'Scorecard loading'));
      right.appendChild(box);
      const ac = el('div', 'acts-c');
      const del = el('button', 'ib del', 'Delete'); del.type = 'button'; del.disabled = !S.canWrite;
      del.addEventListener('click', () => deleteBid(b._id)); ac.appendChild(del); right.appendChild(ac);
      head.appendChild(right); main.appendChild(head);
      { // Capacity: what else is due the same week, and who is on it.
        const cap = el('div', 'gcap');
        if (b.bid_date) {
          const wk = monday(b.bid_date); const same = openBids().filter(x => x.bid_date && monday(x.bid_date) === wk);
          const who = Array.from(new Set(same.flatMap(teamOf)));
          cap.appendChild(el('strong', null, 'Week of ' + fmtDay(wk) + ': '));
          cap.appendChild(document.createTextNode(same.length ? same.length + ' other bid' + (same.length > 1 ? 's' : '') + ' due (' + same.map(x => x.project + (teamOf(x).length ? ' – ' + teamOf(x).map(initials).join('/') : '')).join('; ') + ')' + (who.length ? '. Estimators busy: ' + who.join(', ') + '.' : '.') : 'no other bids due that week.'));
        } else cap.appendChild(document.createTextNode('No bid date yet, so capacity that week can\'t be checked.'));
        main.appendChild(cap);
      }
      if (S.editing === b._id) main.appendChild(editorFor(b));
      if (FM.scorecard) {
        const qs = el('div', 'gqs');
        FM.scorecard.questions.forEach(q => {
          const row = el('div', 'gq');
          const lab = el('div', 'gql'); const t = el('strong', null, q.label); lab.appendChild(t);
          if (q.gate) lab.appendChild(el('span', 'tag muted', 'gate'));
          lab.appendChild(el('span', 'gw', q.weight + ' pts'));
          lab.appendChild(el('span', 'gh', 'Good: ' + q.good + ' · Poor: ' + q.poor));
          row.appendChild(lab);
          const seg = el('div', 'togs grate'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', q.label);
          RATE_LBL.forEach(([k, l]) => {
            const btn = el('button', 'tog r-' + k, l); btn.type = 'button'; btn.disabled = !S.canWrite; btn.setAttribute('aria-pressed', String(ratings[q.key] === k));
            btn.addEventListener('click', async () => { const next = Object.assign({}, ratings); if (next[q.key] === k) delete next[q.key]; else next[q.key] = k; try { await S.db.doc('bids/' + b._id).update({ scorecard: { ratings: next } }); } catch (e) { writeFailed(e); } });
            seg.appendChild(btn);
          });
          row.appendChild(seg);
          const notes = b.score_notes || {};
          const qn = el('input', 'gqn'); qn.type = 'text'; qn.maxLength = 200; qn.placeholder = 'Why? (optional)'; qn.value = notes[q.key] || ''; qn.disabled = !S.canWrite; qn.setAttribute('aria-label', 'Why ' + q.label + ' for ' + b.project);
          qn.addEventListener('change', async () => { const next = Object.assign({}, b.score_notes || {}); if (qn.value.trim()) next[q.key] = qn.value.trim(); else delete next[q.key]; try { await S.db.doc('bids/' + b._id).update({ score_notes: next }); } catch (e) { writeFailed(e); } });
          row.appendChild(qn); qs.appendChild(row);
        });
        main.appendChild(qs);
      }
      const dec = el('div', 'gdec');
      const nl = el('label'); nl.appendChild(document.createTextNode('Note (why)')); const ni = el('input', 'gnote'); ni.type = 'text'; ni.maxLength = 300; ni.placeholder = 'One line, e.g. good owner, open week'; ni.id = 'gnote-' + b._id; nl.appendChild(ni); dec.appendChild(nl);
      const rl = el('div', 'greasons'); rl.appendChild(el('span', 'fl', 'If No-Go, because (tick all that apply)'));
      (FM.nobid || NOBID_REASONS).forEach(r => { const lab = el('label', 'chk'); const cb = el('input'); cb.type = 'checkbox'; cb.value = r; if (sc && sc.reason === r) cb.checked = true; lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + r)); rl.appendChild(lab); });
      dec.appendChild(rl);
      const go = el('button', 'btn', 'Go'); go.type = 'button'; go.disabled = !S.canWrite; go.addEventListener('click', () => decide(b, 'go'));
      const ng = el('button', 'btn sec nogo', 'No-Go'); ng.type = 'button'; ng.disabled = !S.canWrite; ng.addEventListener('click', () => decide(b, 'no_go'));
      const bt = el('div', 'gbtns'); bt.appendChild(go); bt.appendChild(ng); dec.appendChild(bt);
      main.appendChild(dec);
      card.appendChild(main); list.appendChild(card);
    });
    // Recently decided, with who made the call.
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const recent = S.bids.filter(b => b.decision === 'go' && (b.decided_at || '') >= since).sort((a, z) => (z.decided_at || '').localeCompare(a.decided_at || ''));
    const rbox = $('#gng-recent'); rbox.hidden = !recent.length; $('#gng-rc').textContent = recent.length; const ul = $('#gng-rl'); ul.textContent = '';
    recent.forEach(b => {
      const li = el('li'); const nm = el('div', 'nm', b.project);
      nm.appendChild(el('small', null, (b.decision === 'go' ? 'Go' : 'No-Go' + (b.nobid_reason ? ' · ' + b.nobid_reason : '')) + ' · ' + (b.decided_by || '') + ' · ' + new Date(b.decided_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + (b.decision_score != null ? ' · scored ' + b.decision_score : '') + (b.decision_note ? ' · ' + b.decision_note : '')));
      li.appendChild(nm);
      const st = statusOf(b);
      if (st === 'Not started' || st === 'Passed') { const u = el('button', 'btn sec', 'Back to undecided'); u.type = 'button'; u.disabled = !S.canWrite; u.addEventListener('click', async () => { try { await S.db.doc('bids/' + b._id).update(UNDECIDE); } catch (e) { writeFailed(e); } }); li.appendChild(u); }
      ul.appendChild(li);
    });
  }
  $('#gng-list').addEventListener('focusout', () => setTimeout(() => { if (S.gngStale && !$('#gng-list').contains(document.activeElement)) renderGoNoGo(); }, 0));
  $('#gng-add-open').addEventListener('click', () => { $('#gng-form').hidden = false; $('#g-project').focus(); });
  $('#gng-cancel').addEventListener('click', () => { $('#gng-form').hidden = true; $('#gng-msg').textContent = ''; });
  $('#gng-form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const m = $('#gng-msg'); m.className = 'msg';
    if (!S.db || !S.canWrite) { m.className = 'msg err'; m.textContent = 'You need edit access to add bids.'; return; }
    const project = $('#g-project').value.trim(); if (!project) { m.className = 'msg err'; m.textContent = 'Project name is required.'; return; }
    const f = { project, date: $('#g-date').value || '', owner: $('#g-owner').value.trim(), architect: $('#g-arch').value.trim(), location: $('#g-loc').value.trim(), value: $('#g-val').value.trim() };
    try {
      let id = safeId(project.toUpperCase()).slice(0, 40); if (S.bids.some(b => b._id === id)) id = id.slice(0, 32) + '-' + Date.now().toString(36).slice(-6);
      const docData = Object.assign(newBidDoc(f), { status: 'Lead', source: $('#g-source').value || '', sector: $('#g-sector').value || '', bid_time: '' });
      if (!f.date) docData.bid_date = '';
      await S.db.doc('bids/' + id).set(docData);
      $('#gng-form').reset(); $('#gng-form').hidden = true; m.textContent = '';
    } catch (e) { m.className = 'msg err'; m.textContent = 'That possible bid did not save.'; if (e.code) writeFailed(e); }
  });

  function renderAll() { renderTypeFilters(); renderLede(); renderTiles(); renderFilters(); renderCal(); renderGoNoGo(); renderGngTiles(); renderPassed(); renderTable(); renderResults(); renderSync(); renderOffNote();
    if (pendingJump && S.bids.some(x => x._id === pendingJump)) { const id = pendingJump; pendingJump = null; S.expanded.add(id); renderTable(); jumpToBid(id); } }

  document.querySelectorAll('.show-fin').forEach(cb => cb.addEventListener('change', () => { S.showFinished = cb.checked; document.querySelectorAll('.show-fin').forEach(x => { x.checked = cb.checked; }); renderAll(); }));
  $('#bids').addEventListener('focusout', () => setTimeout(() => { if (S.tableStale && !$('#bids').contains(document.activeElement)) renderTable(); }, 0));
  $('#add-open').addEventListener('click', () => { $('#addform').hidden = false; $('#f-project').focus(); });
  $('#add-cancel').addEventListener('click', () => { $('#addform').hidden = true; $('#add-msg').textContent = ''; });
  $('#addform').addEventListener('submit', async (ev) => {
    ev.preventDefault(); const m = $('#add-msg'); m.className = 'msg';
    if (!S.db || !S.canWrite) { m.className = 'msg err'; m.textContent = 'You need edit access to add bids.'; return; }
    const f = { project: $('#f-project').value.trim(), folder: $('#f-folder').value.trim(), date: $('#f-date').value, time: $('#f-time').value.trim(), bid_opening: $('#f-open').value.trim(), owner: $('#f-owner').value.trim(), architect: $('#f-arch').value.trim(), location: $('#f-loc').value.trim(), value: $('#f-val').value.trim() };
    if (!f.project || !f.date) { m.className = 'msg err'; m.textContent = 'Project name and bid date are required.'; return; }
    try { await addBid(f); $('#addform').reset(); $('#addform').hidden = true; m.textContent = ''; }
    catch (e) { m.className = 'msg err'; m.textContent = e.message && !e.code ? e.message : 'That bid did not save.'; if (e.code) writeFailed(e); }
  });
  $('#sync-btn').addEventListener('click', () => { S.forceReread = $('#force-reread').checked; runSync(true); });
  $('#comp-add').addEventListener('click', addCompFromBox);
  $('#comp-new').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addCompFromBox(); } });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && (S.editing || S.confirmDel)) { S.editing = null; S.confirmDel = null; S.tableStale = false; renderTable(); } });

  renderAll();

  (async () => {
    const db = await claude.use('db');
    if (!db) { $('#lede').textContent = 'Sign in to FM Workforce to see the live bid schedule.'; showBanner('Live data is not available in this view.'); return; }
    S.db = db;
    const user = await claude.use('user');
    if (user) { try { const c = await user.can('data.write'); if (c === false) { S.canWrite = false; showBanner('You can view this board. Ask Chris for Contributor access to assign estimators or add bids.'); } } catch (e) {} }
    const err = () => showBanner('The connection to FM Workforce dropped. It will retry on its own; reload the page if this stays.');
    db.collection('bids').onSnapshot(s => { S.bids = s.docs.map(d => Object.assign({ _id: d.id }, d.data())); S.loaded = true; renderAll(); }, err);
    db.collection('deadlines').onSnapshot(s => { S.deadlines = s.docs.map(d => Object.assign({ _id: d.id }, d.data())); renderAll(); }, err);
    db.doc('config/team').onSnapshot(s => { S.team = s.exists ? s.data() : { estimators: [] }; renderAll(); }, err);
    db.doc('config/sharepoint').onSnapshot(s => { S.sp = s.exists ? s.data() : { folders: [] }; }, err);
    db.doc('config/holidays').onSnapshot(s => { S.holidaysCfg = s.exists ? s.data() : {}; renderAll(); }, err);
    db.collection('ignored').onSnapshot(s => { S.ignored = new Set(s.docs.map(d => d.id)); renderSync(); }, err);
    db.doc('config/competitors').onSnapshot(s => { S.comps = s.exists ? (s.data().names || []) : []; renderComps(); renderResults(); }, err);
    db.doc('config/sync').onSnapshot(s => { S.sync = s.exists ? s.data() : null; renderSync(); }, err);
    db.doc('timeoff/current').onSnapshot(s => { const d = s.exists ? s.data() : null; if (d && (!S.timeoff || (d.fetchedAt || '') >= (S.timeoff.fetchedAt || ''))) S.timeoff = d; renderAll(); }, err);
    try {
      const perms = await claude.use('permissions');
      const st = perms ? await perms.state('mcp:' + SERVER).catch(() => 'unavailable') : 'unavailable';
      if (st === 'granted') setTimeout(() => runSync(false), 1200);
      const st2 = perms ? await perms.state('mcp:' + TO_SERVER).catch(() => 'unavailable') : 'unavailable';
      if (st2 === 'granted') setTimeout(() => refreshTimeOff(true), 600);
    } catch (e) {}
  })();
})();
