'use strict';
/* Workforce Scheduler – single page front end (no build step). */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtH = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString();
const money = (n) => (Number(n) || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const money2 = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' }));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStart(s) {
  const d = new Date(s + 'T00:00:00Z');
  return addDays(s, -((d.getUTCDay() + 6) % 7));
}
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
function dayLabel(s, opts = { weekday: 'short', month: 'numeric', day: 'numeric' }) {
  return new Date(s + 'T12:00:00Z').toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}
function weekLabel(start) {
  const end = addDays(start, 6);
  const o = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return `${new Date(start + 'T12:00:00Z').toLocaleDateString(undefined, o)} – ${new Date(end + 'T12:00:00Z').toLocaleDateString(undefined, { ...o, year: 'numeric' })}`;
}
const fullName = (e) => `${e.first_name} ${e.last_name}`;
const shortName = (e) => `${e.first_name} ${e.last_name.charAt(0)}.`;
const isWeekend = (i) => i >= 5;

function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { return null; }
  return val;
}

async function api(method, url, body) {
  const res = await fetch('/api' + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && url !== '/login') { S.user = null; renderLogin(); throw new Error('Please sign in.'); }
  if (!res.ok && !(data && data.created)) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), bad ? 5000 : 2500);
}

function modal({ title, body, footer = '', wide = false }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="mh"><h3>${esc(title)}</h3><button class="x" data-close aria-label="Close">×</button></div>
    <div class="mb">${body}</div>
    ${footer ? `<div class="mf">${footer}</div>` : ''}
  </div></div>`;
  const el = $('.modal', root);
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('.modal-bg', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-bg')) close(); });
  $$('[data-close]', el).forEach((b) => b.addEventListener('click', close));
  const first = $('input:not([type=checkbox]),select,textarea', el);
  if (first && window.innerWidth > 600) setTimeout(() => first.focus(), 30);
  return { el, close };
}

function formData(el) {
  const out = {};
  $$('[name]', el).forEach((f) => {
    if (f.type === 'checkbox') {
      if (f.dataset.multi) { (out[f.name] ||= []); if (f.checked) out[f.name].push(f.value); } else out[f.name] = f.checked;
    } else out[f.name] = f.value;
  });
  return out;
}

function errorBox(el, msg, list) {
  let box = $('.form-error', el);
  if (!box) { box = document.createElement('div'); box.className = 'form-error'; $('.mb', el)?.prepend(box) || el.prepend(box); }
  box.innerHTML = msg ? `<div class="alert bad">${esc(msg)}${list && list.length ? `<ul>${list.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</div>` : '';
}

const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(sel ?? '') === String(v) ? 'selected' : ''}>${esc(label)}</option>`;

// ---------------------------------------------------------------------------
// State + routing
// ---------------------------------------------------------------------------
const FOOTER = '<span>Fager-McGee Commercial Construction</span><span class="dot">•</span><span>347 S. Williams St., Murphysboro, IL 62966</span><span class="dot">•</span><span><a href="tel:6186873900">618-687-3900</a></span><span class="dot">•</span><span><a href="https://www.fager-mcgee.com" target="_blank" rel="noopener">www.fager-mcgee.com</a></span>';

const S = {
  user: null,
  settings: {},
  week: weekStart(todayStr()),
  view: store('wf_view') || 'project',
  dayIdx: Math.min((new Date().getDay() + 6) % 7, 6),
  filterSuper: store('wf_super') || '',
  filterTrade: '',
};
const canSchedule = () => S.user && ['admin', 'super'].includes(S.user.role);
const isAdmin = () => S.user && S.user.role === 'admin';
const mobile = () => window.innerWidth < 760;

const ROUTES = [
  { path: 'schedule', label: 'Schedule', render: renderSchedule },
  { path: 'my', label: 'My Schedule', render: renderMy, show: () => S.user.employee_id },
  { path: 'verify', label: 'Verify Hours', render: renderVerify, show: canSchedule },
  { path: 'projects', label: 'Projects', render: renderProjects },
  { path: 'employees', label: 'Employees', render: renderEmployees },
  { path: 'records', label: 'Records', render: renderRecords },
  { path: 'payroll', label: '🔒 Payroll', render: renderPayroll, show: () => S.user.can_view_payroll, cls: 'private' },
  { path: 'admin', label: 'Admin', render: renderAdmin, show: isAdmin },
];

function currentRoute() {
  const p = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'schedule';
  return ROUTES.find((r) => r.path === p && (!r.show || r.show())) || ROUTES[0];
}

function shell() {
  const r = currentRoute();
  const roleName = { admin: 'Workforce Manager', super: 'Superintendent', viewer: 'Field' }[S.user.role];
  $('#app').innerHTML = `
    <header class="top">
      <button class="menu-btn" aria-label="Menu">☰</button>
      <a class="brand" href="#/schedule" title="${esc(S.settings.company_name || '')}"><img src="/logo.jpg" alt="Fager-McGee Commercial Construction"></a>
      <nav>${ROUTES.filter((x) => !x.show || x.show()).map((x) => `<a href="#/${x.path}" class="${x === r ? 'active' : ''} ${x.cls || ''}">${esc(x.label)}</a>`).join('')}<a href="#" class="nav-account">My account</a></nav>
      <div class="who" title="Account">${esc(S.user.name)} · ${roleName} ▾</div>
    </header>
    <main id="page"></main>
    <footer class="site">${FOOTER}</footer>`;
  $('.menu-btn').onclick = () => $('header.top nav').classList.toggle('open');
  $$('header.top nav a').forEach((a) => a.addEventListener('click', () => $('header.top nav').classList.remove('open')));
  $('.who').onclick = accountMenu;
  $('.nav-account').onclick = (e) => { e.preventDefault(); accountMenu(); };
  r.render($('#page'));
}

function accountMenu() {
  const m = modal({
    title: 'My account',
    body: `<div>${esc(S.user.name)} <span class="muted">(${esc(S.user.username)})</span></div>
      <h2 style="margin:0">Change password</h2>
      <label>Current password<input type="password" name="current" autocomplete="current-password"></label>
      <label>New password (8+ characters)<input type="password" name="next" autocomplete="new-password"></label>`,
    footer: `<button class="danger" data-act="logout">Sign out</button><span class="spacer"></span><button data-close>Close</button><button class="primary" data-act="pw">Update password</button>`,
  });
  $('[data-act=logout]', m.el).onclick = async () => { await api('POST', '/logout'); location.hash = ''; location.reload(); };
  $('[data-act=pw]', m.el).onclick = async () => {
    try { await api('POST', '/me/password', formData(m.el)); m.close(); toast('Password updated'); } catch (e) { errorBox(m.el, e.message); }
  };
}

function renderLogin() {
  $('#modal-root').innerHTML = '';
  $('#app').innerHTML = `<div class="login"><div class="card">
    <img class="logo" src="/logo.jpg" alt="Fager-McGee Commercial Construction">
    <div class="sub">Field Workforce Scheduling</div>
    <form id="login-form" style="display:grid;gap:12px">
      <label>Username<input name="username" autocomplete="username" autocapitalize="none" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <div id="login-err"></div>
      <button class="primary" type="submit" style="justify-content:center">Sign in</button>
    </form></div></div><footer class="site">${FOOTER}</footer>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', '/login', formData(e.target)); await boot(); } catch (err) {
      $('#login-err').innerHTML = `<div class="alert bad">${esc(err.message)}</div>`;
    }
  };
}

async function boot() {
  try {
    const me = await api('GET', '/me');
    S.user = me.user; S.settings = me.settings;
    shell();
  } catch { if (!S.user) renderLogin(); }
}
// Close any open dialog when the page changes (e.g. phone Back button).
window.addEventListener('hashchange', () => { $('#modal-root').innerHTML = ''; if (S.user) shell(); });
let wasMobile = mobile();
window.addEventListener('resize', () => {
  if (mobile() !== wasMobile && S.user && currentRoute().path === 'schedule') { wasMobile = mobile(); renderSchedule($('#page')); }
});

// Shared lookups (refetched when pages need them)
async function loadLookups() {
  const [projects, employees] = await Promise.all([api('GET', '/projects'), api('GET', '/employees')]);
  S.projects = projects; S.employees = employees;
  return { projects, employees };
}

// ---------------------------------------------------------------------------
// Schedule board
// ---------------------------------------------------------------------------
async function renderSchedule(page) {
  page.innerHTML = '<div class="muted">Loading schedule…</div>';
  const [data] = await Promise.all([api('GET', `/schedule?start=${S.week}`), loadLookups()]);
  S.sched = data;
  const t = data.totals;
  const today = todayStr();
  const activeEmployees = S.employees.length;
  const supers = [...new Map(data.projects.filter((p) => p.superintendent_name).map((p) => [p.superintendent_user_id, p.superintendent_name])).entries()];
  const trades = [...new Set(S.employees.map((e) => e.trade).filter(Boolean))].sort();

  const todayIdx = data.days.indexOf(today);
  const todayCount = todayIdx >= 0 ? t.by_day[today].headcount : null;

  page.innerHTML = `
    <div class="toolbar">
      <h1 style="margin:0">Schedule</h1>
      <span class="spacer"></span>
      <button data-act="prev" aria-label="Previous week">‹</button>
      <button data-act="this">This week</button>
      <button data-act="next" aria-label="Next week">›</button>
      <input type="date" data-act="pick" value="${S.week}" title="Jump to week">
    </div>
    <div class="toolbar">
      <strong>${weekLabel(data.start)}</strong>
      <span class="spacer"></span>
      <div class="seg">
        <button data-view="project" class="${S.view === 'project' ? 'on' : ''}">By Project</button>
        <button data-view="person" class="${S.view === 'person' ? 'on' : ''}">Who's Where</button>
      </div>
      ${S.view === 'project' && supers.length ? `<select data-act="super"><option value="">All superintendents</option>${supers.map(([id, n]) => opt(id, n, S.filterSuper)).join('')}</select>` : ''}
      ${S.view === 'person' ? `<select data-act="trade"><option value="">All trades</option>${trades.map((x) => opt(x, x, S.filterTrade)).join('')}</select>` : ''}
      ${canSchedule() ? `<button data-act="copy">Copy last week →</button><button data-act="timeoff">Time off</button><button class="primary" data-act="add">+ Schedule crew</button>` : ''}
      <button data-act="print">Print</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${fmtH(t.hours)}</div><div class="l">Scheduled hours (week)</div></div>
      <div class="stat"><div class="v">${t.people} / ${activeEmployees}</div><div class="l">Employees scheduled</div></div>
      <div class="stat"><div class="v">${Object.keys(t.by_project).length}</div><div class="l">Projects staffed</div></div>
      ${todayCount !== null ? `<div class="stat"><div class="v">${todayCount}</div><div class="l">On site today</div></div>` : ''}
      ${(() => { const o = Object.values(t.by_employee).filter((h) => h > 40).length; return `<div class="stat ${o ? 'warn' : ''}"><div class="v">${o}</div><div class="l">Over 40 hrs (OT)</div></div>`; })()}
    </div>
    <div class="print-head"><img src="/logo.jpg" alt="Fager-McGee"><div>Weekly Crew Schedule  •  ${weekLabel(data.start)}</div></div>
    <div id="board"></div>`;

  const go = (w) => { S.week = weekStart(w); renderSchedule(page); };
  $('[data-act=prev]', page).onclick = () => go(addDays(S.week, -7));
  $('[data-act=next]', page).onclick = () => go(addDays(S.week, 7));
  $('[data-act=this]', page).onclick = () => go(todayStr());
  $('[data-act=pick]', page).onchange = (e) => e.target.value && go(e.target.value);
  $('[data-act=print]', page).onclick = () => window.print();
  $$('[data-view]', page).forEach((b) => (b.onclick = () => { S.view = store('wf_view', b.dataset.view); renderSchedule(page); }));
  const sup = $('[data-act=super]', page); if (sup) sup.onchange = (e) => { S.filterSuper = store('wf_super', e.target.value); drawBoard(); };
  const tr = $('[data-act=trade]', page); if (tr) tr.onchange = (e) => { S.filterTrade = e.target.value; drawBoard(); };
  if (canSchedule()) {
    $('[data-act=add]', page).onclick = () => assignModal({});
    $('[data-act=copy]', page).onclick = copyWeekModal;
    $('[data-act=timeoff]', page).onclick = () => timeOffModal({});
  }
  drawBoard();
}

function drawBoard() {
  const el = $('#board');
  if (!el) return;
  if (S.view === 'person') el.innerHTML = mobile() ? personMobile() : personBoard();
  else el.innerHTML = mobile() ? projectMobile() : projectBoard();
  bindBoard(el);
}

function visibleProjects() {
  const d = S.sched;
  return d.projects.filter((p) => !S.filterSuper || String(p.superintendent_user_id) === String(S.filterSuper));
}

function chip(a, label = shortName(a)) {
  const hrs = a.planned_hours !== 8 ? `<span class="hr">${fmtH(a.planned_hours)}h</span>` : '';
  const st = a.status === 'scheduled' ? '' : a.status === 'no_show' ? 'no_show' : 'verified';
  const title = `${fullName(a)} – ${a.trade || ''} ${a.classification || ''}\n${a.job_number} ${a.project_name}\n${fmtH(a.planned_hours)} hrs${a.start_time ? ' @ ' + a.start_time : ''}${a.task ? '\n' + a.task : ''}${a.status !== 'scheduled' ? '\nVerified: ' + fmtH(a.actual_hours) + ' hrs' : ''}`;
  return `<div class="chip ${st} ${canSchedule() ? 'can' : ''}" data-aid="${a.id}" title="${esc(title)}" style="border-left-color:${esc(a.color || '#F15A22')}">
    <span class="nm">${esc(label)}</span>${hrs}${st === 'verified' ? '✓' : ''}</div>`;
}

function projectSub(p) {
  const pct = p.budget_hours ? Math.round((p.hours_through_week / p.budget_hours) * 100) : null;
  return `<div class="small muted">${esc(p.superintendent_name || 'No superintendent')}</div>
    ${pct !== null ? `<div class="small muted">${fmtH(p.hours_through_week)} / ${fmtH(p.budget_hours)} budget hrs (${pct}%)</div>
      <div class="bar ${pct > 100 ? 'over' : pct > 85 ? 'near' : ''}"><span style="width:${Math.min(pct, 100)}%"></span></div>` : ''}`;
}

function projectBoard() {
  const d = S.sched; const t = d.totals; const today = todayStr();
  const projects = visibleProjects();
  const byCell = {};
  for (const a of d.assignments) (byCell[`${a.project_id}|${a.work_date}`] ||= []).push(a);
  const offByDay = {};
  for (const o of d.time_off) (offByDay[o.off_date] ||= []).push(o);
  const scheduledByDay = {};
  for (const a of d.assignments) (scheduledByDay[a.work_date] ||= new Set()).add(a.employee_id);

  if (!projects.length) return `<div class="card muted">No active projects. ${canSchedule() ? '<a href="#/projects">Add a project</a> to start scheduling.' : ''}</div>`;

  return `<div class="table-wrap"><table class="board">
    <thead><tr><th class="proj">Project</th>${d.days.map((day, i) => `<th class="${day === today ? 'today' : ''}">${dayLabel(day)}</th>`).join('')}<th class="tot">Week</th></tr></thead>
    <tbody>${projects.map((p) => {
      const pt = t.by_project[p.id] || { hours: 0, headcount: 0, days: {} };
      return `<tr>
        <th class="proj"><div class="proj-name"><span class="proj-swatch" style="background:${esc(p.color || '#F15A22')}"></span>${esc(p.job_number)} – ${esc(p.name)}</div>${projectSub(p)}</th>
        ${d.days.map((day, i) => {
          const list = byCell[`${p.id}|${day}`] || [];
          const ct = pt.days[day];
          return `<td class="${isWeekend(i) ? 'weekend' : ''} ${day === today ? 'today' : ''}">
            ${ct ? `<div class="cell-tot"><span>${ct.headcount} ppl</span><span>${fmtH(ct.hours)} h</span></div>` : ''}
            ${list.map((a) => chip(a)).join('')}
            ${canSchedule() ? `<button class="add-btn" data-add="${p.id}|${day}">+</button>` : ''}
          </td>`;
        }).join('')}
        <td class="tot"><b>${fmtH(pt.hours)}</b> h<br><span class="small muted">${pt.headcount} ppl</span></td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot>
      <tr><th class="proj">Daily totals</th>${d.days.map((day) => `<td>${t.by_day[day].headcount} ppl<br>${fmtH(t.by_day[day].hours)} h</td>`).join('')}<td>${fmtH(t.hours)} h</td></tr>
      <tr><th class="proj small">Not scheduled / off</th>${d.days.map((day) => {
        const sched = scheduledByDay[day]?.size || 0; const off = (offByDay[day] || []).length;
        return `<td class="small" title="${esc((offByDay[day] || []).map((o) => `${o.first_name} ${o.last_name}: ${o.reason || 'off'}`).join('\n'))}">${Math.max(S.employees.length - sched - off, 0)} open${off ? ` · ${off} off` : ''}</td>`;
      }).join('')}<td></td></tr>
    </tfoot>
  </table></div>`;
}

function dayTabs() {
  const d = S.sched; const today = todayStr();
  return `<div class="daytabs">${d.days.map((day, i) => `<button data-day="${i}" class="${i === S.dayIdx ? 'on' : ''} ${day === today ? 'today' : ''}">${DOW[i]}<b>${day.slice(8)}</b><span class="small">${d.totals.by_day[day].headcount} ppl</span></button>`).join('')}</div>`;
}

function projectMobile() {
  const d = S.sched; const day = d.days[S.dayIdx];
  const list = visibleProjects().map((p) => ({ p, a: d.assignments.filter((a) => a.project_id === p.id && a.work_date === day) }));
  const off = d.time_off.filter((o) => o.off_date === day);
  return `${dayTabs()}
    <div class="muted small" style="margin-bottom:8px">${dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })} · ${d.totals.by_day[day].headcount} people · ${fmtH(d.totals.by_day[day].hours)} hrs</div>
    ${list.map(({ p, a }) => `<div class="pcard">
      <div class="ph"><div><div class="proj-name"><span class="proj-swatch" style="background:${esc(p.color || '#F15A22')}"></span>${esc(p.job_number)} – ${esc(p.name)}</div>
        ${p.address ? `<div class="small"><a href="https://maps.google.com/?q=${encodeURIComponent(p.address)}" target="_blank" rel="noopener">${esc(p.address)}</a></div>` : ''}${projectSub(p)}</div>
        <div class="right nowrap"><b>${a.length}</b> ppl<br><span class="small muted">${fmtH(a.reduce((s, x) => s + x.planned_hours, 0))} h</span></div></div>
      <div class="pb">${a.map((x) => chip(x, [fullName(x), x.trade, x.start_time].filter(Boolean).join(' · '))).join('') || '<div class="small muted">Nobody scheduled</div>'}
        ${canSchedule() ? `<button class="add-btn" style="margin-top:6px;min-height:36px" data-add="${p.id}|${day}">+ Add crew</button>` : ''}</div>
    </div>`).join('')}
    ${off.length ? `<div class="pcard"><div class="ph"><b>Off</b></div><div class="pb">${off.map((o) => `<div class="chip off">${esc(o.first_name)} ${esc(o.last_name)} <span class="hr">${esc(o.reason || '')}</span></div>`).join('')}</div></div>` : ''}`;
}

function personRows() {
  const d = S.sched;
  const ids = new Set(d.assignments.map((a) => a.employee_id));
  return S.employees.filter((e) => !S.filterTrade || e.trade === S.filterTrade).concat(
    // include inactive people who still appear on this week's schedule
    [...ids].filter((id) => !S.employees.some((e) => e.id === id)).map((id) => {
      const a = d.assignments.find((x) => x.employee_id === id);
      return { id, first_name: a.first_name, last_name: a.last_name, trade: a.trade };
    }).filter((e) => !S.filterTrade || e.trade === S.filterTrade));
}

function personBoard() {
  const d = S.sched; const today = todayStr();
  const map = {}; for (const a of d.assignments) map[`${a.employee_id}|${a.work_date}`] = a;
  const off = {}; for (const o of d.time_off) off[`${o.employee_id}|${o.off_date}`] = o;
  const rows = personRows();
  if (!rows.length) return `<div class="card muted">No employees yet. <a href="#/employees">Add employees</a>.</div>`;
  return `<div class="table-wrap"><table class="board">
    <thead><tr><th class="proj">Employee</th>${d.days.map((day) => `<th class="${day === today ? 'today' : ''}">${dayLabel(day)}</th>`).join('')}<th class="tot">Hours</th></tr></thead>
    <tbody>${rows.map((e) => {
      const wk = d.totals.by_employee[e.id] || 0;
      return `<tr><th class="proj"><div class="proj-name">${esc(e.last_name)}, ${esc(e.first_name)}</div><div class="small muted">${esc([e.trade, e.classification].filter(Boolean).join(' · '))}</div></th>
        ${d.days.map((day, i) => {
          const a = map[`${e.id}|${day}`]; const o = off[`${e.id}|${day}`];
          const inner = a ? chip(a, `${a.job_number} ${a.project_name}`)
            : o ? `<div class="chip off" data-off="${o.id}" title="${esc(o.reason || '')}">Off${o.reason ? ' – ' + esc(o.reason) : ''}</div>`
            : `<span class="avail">available</span>`;
          return `<td class="person-cell ${!a && !o && canSchedule() ? 'can' : ''} ${isWeekend(i) ? 'weekend' : ''} ${day === today ? 'today' : ''}" ${!a && !o ? `data-emp="${e.id}|${day}"` : ''}>${inner}</td>`;
        }).join('')}
        <td class="tot ${wk > 40 ? 'over40' : ''}">${fmtH(wk)}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function personMobile() {
  const d = S.sched; const day = d.days[S.dayIdx];
  const map = {}; for (const a of d.assignments) if (a.work_date === day) map[a.employee_id] = a;
  const off = {}; for (const o of d.time_off) if (o.off_date === day) off[o.employee_id] = o;
  return `${dayTabs()}<div class="pcard"><div class="pb">${personRows().map((e) => {
    const a = map[e.id]; const o = off[e.id];
    return `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid #eef1f4" ${!a && !o ? `data-emp="${e.id}|${day}" class="person-cell ${canSchedule() ? 'can' : ''}"` : ''}>
      <div><b>${esc(fullName(e))}</b><div class="small muted">${esc(e.trade || '')}</div></div>
      <div class="right" style="max-width:60%">${a ? `<span class="pill job" data-aid="${a.id}">${esc(a.job_number)} ${esc(a.project_name)}</span>` : o ? `<span class="pill off">Off</span>` : '<span class="avail">available</span>'}</div>
    </div>`;
  }).join('')}</div></div>`;
}

function bindBoard(el) {
  $$('[data-day]', el).forEach((b) => (b.onclick = () => { S.dayIdx = Number(b.dataset.day); drawBoard(); }));
  if (!canSchedule()) return;
  $$('[data-add]', el).forEach((b) => (b.onclick = () => { const [pid, day] = b.dataset.add.split('|'); assignModal({ project_id: Number(pid), dates: [day] }); }));
  $$('[data-aid]', el).forEach((c) => (c.onclick = (ev) => { ev.stopPropagation(); editAssignmentModal(S.sched.assignments.find((a) => a.id === Number(c.dataset.aid))); }));
  $$('[data-emp]', el).forEach((c) => (c.onclick = () => { const [eid, day] = c.dataset.emp.split('|'); assignModal({ employee_ids: [Number(eid)], dates: [day] }); }));
  $$('[data-off]', el).forEach((c) => (c.onclick = async (ev) => {
    ev.stopPropagation();
    if (!confirm('Remove this time-off day?')) return;
    await api('DELETE', `/time-off/${c.dataset.off}`); toast('Time off removed'); renderSchedule($('#page'));
  }));
}

// Assign crew: pick project, employees, days. Booked/off employees are disabled so
// double booking can't even be attempted (the server enforces it regardless).
function assignModal(pre) {
  const d = S.sched;
  const projects = S.projects.filter((p) => p.status !== 'complete');
  const preDates = new Set(pre.dates || [todayStr() >= d.start && todayStr() <= d.end ? todayStr() : d.days[0]]);
  const preEmp = new Set(pre.employee_ids || []);
  const trades = [...new Set(S.employees.map((e) => e.trade).filter(Boolean))].sort();
  const skills = [...new Set(S.employees.flatMap((e) => e.skills.map((s) => s.name)))].sort();

  const m = modal({
    title: 'Schedule crew',
    wide: true,
    body: `
      <div class="grid2">
        <label>Project<select name="project_id">${projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, pre.project_id)).join('')}</select></label>
        <div class="grid2" style="grid-template-columns:1fr 1fr">
          <label>Hours / day<input name="planned_hours" type="number" step="0.5" min="0" max="24" value="${S.settings.default_hours || 8}"></label>
          <label>Start time<input name="start_time" type="time" value="${esc(S.settings.default_start_time || '')}"></label>
        </div>
      </div>
      <div><div class="small muted" style="margin-bottom:4px">Days <button class="link" data-days="wk">Mon–Fri</button><button class="link" data-days="none">clear</button></div>
        <div class="days-pick">${d.days.map((day, i) => `<label><input type="checkbox" name="dates" data-multi="1" value="${day}" ${preDates.has(day) ? 'checked' : ''}>${DOW[i]} ${day.slice(5).replace('-', '/')}</label>`).join('')}</div></div>
      <label>Task / scope (optional)<input name="task" maxlength="500" placeholder="e.g. Level 2 framing, pour prep"></label>
      <div class="toolbar" style="margin:0">
        <input type="search" data-f="q" placeholder="Search name…" style="flex:1;min-width:140px">
        <select data-f="trade"><option value="">All trades</option>${trades.map((x) => opt(x, x)).join('')}</select>
        <select data-f="skill"><option value="">Any skill</option>${skills.map((x) => opt(x, x)).join('')}</select>
        <label class="check"><input type="checkbox" data-f="availOnly" checked> Available only</label>
      </div>
      <div class="emp-pick" id="emp-pick"></div>
      <div class="small muted" id="pick-count"></div>`,
    footer: `<button data-close>Cancel</button><button class="primary" data-act="save">Schedule</button>`,
  });

  const busyMap = {};
  for (const a of d.assignments) (busyMap[a.employee_id] ||= {})[a.work_date] = `${a.job_number}`;
  for (const o of d.time_off) (busyMap[o.employee_id] ||= {})[o.off_date] = 'OFF';

  const drawList = () => {
    const f = Object.fromEntries($$('[data-f]', m.el).map((x) => [x.dataset.f, x.type === 'checkbox' ? x.checked : x.value.toLowerCase()]));
    const dates = $$('[name=dates]:checked', m.el).map((x) => x.value);
    const checked = new Set($$('#emp-pick input:checked', m.el).map((x) => Number(x.value)));
    for (const id of preEmp) checked.add(id);
    preEmp.clear();
    const rows = S.employees.filter((e) =>
      (!f.q || fullName(e).toLowerCase().includes(f.q)) &&
      (!f.trade || (e.trade || '').toLowerCase() === f.trade) &&
      (!f.skill || e.skills.some((s) => s.name.toLowerCase() === f.skill)));
    const html = rows.map((e) => {
      const conflicts = dates.filter((day) => busyMap[e.id]?.[day]).map((day) => `${DOW[d.days.indexOf(day)]}: ${busyMap[e.id][day]}`);
      const allBusy = dates.length > 0 && conflicts.length === dates.length;
      if (f.availOnly && allBusy && !checked.has(e.id)) return '';
      const wk = d.totals.by_employee[e.id] || 0;
      return `<label class="${allBusy ? 'busy' : ''}"><input type="checkbox" value="${e.id}" ${checked.has(e.id) && !allBusy ? 'checked' : ''} ${allBusy ? 'disabled' : ''}>
        <span><b>${esc(fullName(e))}</b><br><span class="small muted">${esc([e.trade, e.classification, e.union_local && 'Local ' + e.union_local].filter(Boolean).join(' · '))}</span></span>
        <span class="meta">${conflicts.length ? `<span class="pill ${allBusy ? 'bad' : 'warn'}">${esc(conflicts.join(', '))}</span><br>` : ''}${fmtH(wk)} h this wk</span></label>`;
    }).join('');
    $('#emp-pick', m.el).innerHTML = html || `<div class="muted" style="padding:12px">${f.availOnly && dates.length ? 'Everyone matching is already booked or off on the selected day(s). Uncheck “Available only” to see where they are.' : 'No matching employees.'}</div>`;
    const n = $$('#emp-pick input:checked', m.el).length;
    $('#pick-count', m.el).textContent = `${n} selected × ${dates.length} day(s)`;
    $$('#emp-pick input', m.el).forEach((x) => (x.onchange = () => { $('#pick-count', m.el).textContent = `${$$('#emp-pick input:checked', m.el).length} selected × ${dates.length} day(s)`; }));
  };
  $$('[data-f]', m.el).forEach((x) => (x.oninput = drawList));
  $$('[name=dates]', m.el).forEach((x) => (x.onchange = drawList));
  $$('[data-days]', m.el).forEach((b) => (b.onclick = (e) => {
    e.preventDefault();
    $$('[name=dates]', m.el).forEach((x, i) => (x.checked = b.dataset.days === 'wk' && i < 5));
    drawList();
  }));
  drawList();

  $('[data-act=save]', m.el).onclick = async () => {
    const f = formData(m.el);
    const body = {
      project_id: Number(f.project_id), dates: f.dates, planned_hours: f.planned_hours, start_time: f.start_time, task: f.task,
      employee_ids: $$('#emp-pick input:checked', m.el).map((x) => Number(x.value)),
    };
    try {
      const r = await api('POST', '/assignments', body);
      if (r.conflicts.length) {
        errorBox(m.el, `Scheduled ${r.created.length}. These were skipped to prevent double booking:`, r.conflicts.map((c) => c.message));
        $('[data-act=save]', m.el).textContent = 'Schedule more';
        renderSchedule($('#page'));
      } else { m.close(); toast(`Scheduled ${r.created.length} crew-day(s)`); renderSchedule($('#page')); }
    } catch (e) { errorBox(m.el, e.message, e.data?.conflicts?.map((c) => c.message)); }
  };
}

function editAssignmentModal(a) {
  if (!a) return;
  const m = modal({
    title: `${fullName(a)} – ${dayLabel(a.work_date, { weekday: 'long', month: 'short', day: 'numeric' })}`,
    body: `
      <div class="small muted">${esc([a.trade, a.classification].filter(Boolean).join(' · '))}${a.status !== 'scheduled' ? ` · <span class="pill ok">Verified ${fmtH(a.actual_hours)} h</span>` : ''}</div>
      <label>Project<select name="project_id">${S.projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, a.project_id)).join('')}</select></label>
      <div class="grid2">
        <label>Date<input type="date" name="work_date" value="${a.work_date}"></label>
        <label>Hours<input type="number" step="0.5" min="0" max="24" name="planned_hours" value="${a.planned_hours}"></label>
        <label>Start time<input type="time" name="start_time" value="${esc(a.start_time || '')}"></label>
      </div>
      <label>Task / scope<input name="task" value="${esc(a.task || '')}"></label>`,
    footer: `<button class="danger" data-act="del">Remove</button><span class="spacer"></span><button data-close>Cancel</button><button class="primary" data-act="save">Save</button>`,
  });
  $('[data-act=save]', m.el).onclick = async () => {
    try { await api('PUT', `/assignments/${a.id}`, formData(m.el)); m.close(); toast('Updated'); renderSchedule($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
  $('[data-act=del]', m.el).onclick = async () => {
    if (!confirm(`Remove ${fullName(a)} from ${a.job_number} on ${a.work_date}?`)) return;
    try { await api('DELETE', `/assignments/${a.id}`); m.close(); toast('Removed'); renderSchedule($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
}

function copyWeekModal() {
  const from = addDays(S.week, -7);
  const m = modal({
    title: 'Copy a week forward',
    body: `<p class="muted" style="margin:0">Copies every assignment from the source week into the week you're viewing. Anyone already booked or off is skipped – nobody gets double booked.</p>
      <div class="grid2"><label>Copy from week of<input type="date" name="from" value="${from}"></label>
      <label>Into week of<input type="date" name="to" value="${S.week}"></label></div>
      <label>Project<select name="project_id"><option value="">All projects</option>${S.projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`)).join('')}</select></label>`,
    footer: `<button data-close>Cancel</button><button class="primary" data-act="go">Copy</button>`,
  });
  $('[data-act=go]', m.el).onclick = async () => {
    try {
      const r = await api('POST', '/assignments/copy-week', formData(m.el));
      if (r.conflicts.length) errorBox(m.el, `Copied ${r.created.length}. Skipped:`, r.conflicts.map((c) => c.message));
      else { m.close(); toast(`Copied ${r.created.length} assignments`); }
      S.week = weekStart(formData(m.el).to); renderSchedule($('#page'));
    } catch (e) { errorBox(m.el, e.message); }
  };
}

function timeOffModal(pre) {
  const d = S.sched;
  const m = modal({
    title: 'Mark time off',
    body: `<label>Employee<select name="employee_id">${S.employees.map((e) => opt(e.id, `${e.last_name}, ${e.first_name}`, pre.employee_id)).join('')}</select></label>
      <div class="days-pick">${d.days.map((day, i) => `<label><input type="checkbox" name="dates" data-multi="1" value="${day}">${DOW[i]} ${day.slice(5).replace('-', '/')}</label>`).join('')}</div>
      <label>Reason<input name="reason" placeholder="Vacation, sick, training, union meeting…"></label>`,
    footer: `<button data-close>Cancel</button><button class="primary" data-act="go">Save</button>`,
  });
  $('[data-act=go]', m.el).onclick = async () => {
    const f = formData(m.el);
    if (!f.dates.length) return errorBox(m.el, 'Pick at least one day.');
    try {
      const r = await api('POST', '/time-off', f);
      if (r.conflicts.length) errorBox(m.el, `Saved ${r.added}. Not saved:`, r.conflicts);
      else { m.close(); toast('Time off saved'); }
      renderSchedule($('#page'));
    } catch (e) { errorBox(m.el, e.message); }
  };
}

// ---------------------------------------------------------------------------
// My schedule (field staff)
// ---------------------------------------------------------------------------
async function renderMy(page) {
  const r = await api('GET', '/my-schedule');
  const today = todayStr();
  const card = (a) => `<div class="pcard" style="${a.work_date === today ? 'border-color:var(--orange);border-width:2px' : ''}${a.work_date < today ? ';opacity:.6' : ''}">
      <div class="ph"><div><b>${dayLabel(a.work_date, { weekday: 'long', month: 'short', day: 'numeric' })}</b>${a.work_date === today ? ' <span class="pill warn">Today</span>' : ''}
        <div class="proj-name" style="margin-top:4px"><span class="proj-swatch" style="background:${esc(a.color || '#F15A22')}"></span>${esc(a.job_number)} – ${esc(a.project_name)}</div>
        ${a.task ? `<div class="small muted">${esc(a.task)}</div>` : ''}</div>
        <div class="right nowrap">${a.start_time ? `<b>${esc(a.start_time)}</b><br>` : ''}<span class="small muted">${fmtH(a.planned_hours)} hrs</span></div></div>
    </div>`;
  // Today and upcoming first; past days collapsed underneath.
  const upcoming = r.assignments.filter((a) => a.work_date >= today);
  const past = r.assignments.filter((a) => a.work_date < today).reverse();
  page.innerHTML = `<h1>My Schedule</h1>
    ${!r.linked ? '<div class="card muted">Your login is not linked to an employee record. Ask the workforce manager.</div>' : ''}
    ${r.linked ? (upcoming.map(card).join('') || '<div class="card muted">Nothing scheduled yet. Check back after the schedule is posted.</div>') : ''}
    ${r.time_off?.length ? `<h2>Time off</h2>${r.time_off.map((o) => `<div class="chip off">${dayLabel(o.off_date)} ${esc(o.reason || '')}</div>`).join('')}` : ''}
    ${past.length ? `<details class="past"><summary>Earlier days (${past.length})</summary>${past.map(card).join('')}</details>` : ''}`;
}

// ---------------------------------------------------------------------------
// Verify hours
// ---------------------------------------------------------------------------
S.verifyWeek = null; S.verifyProject = '';
async function renderVerify(page) {
  if (!S.verifyWeek) S.verifyWeek = weekStart(addDays(todayStr(), new Date().getDay() === 1 ? -7 : 0));
  const [r] = await Promise.all([api('GET', `/verification?start=${S.verifyWeek}&project_id=${S.verifyProject}`), S.projects ? null : loadLookups()]);
  const s = r.summary;
  const today = todayStr();
  const pastPending = r.rows.filter((x) => x.status === 'scheduled' && x.work_date <= today);
  const byDay = {};
  for (const x of r.rows) (byDay[x.work_date] ||= []).push(x);

  page.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Verify Hours</h1><span class="spacer"></span>
      <button data-act="prev">‹</button><strong>${weekLabel(r.start)}</strong><button data-act="next">›</button></div>
    <div class="toolbar">
      <select data-act="proj"><option value="">All projects</option>${S.projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, S.verifyProject)).join('')}</select>
      <span class="spacer"></span>
      ${pastPending.length ? `<button class="ok" data-act="all">✓ Verify all ${pastPending.length} as scheduled (through today)</button>` : ''}
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${fmtH(s.planned)}</div><div class="l">Projected hours</div></div>
      <div class="stat"><div class="v">${fmtH(s.actual)}</div><div class="l">Verified actual hours</div></div>
      <div class="stat ${s.variance < 0 ? 'bad' : s.variance > 0 ? 'warn' : 'ok'}"><div class="v">${s.variance > 0 ? '+' : ''}${fmtH(s.variance)}</div><div class="l">Variance (verified)</div></div>
      <div class="stat ${pastPending.length ? 'warn' : 'ok'}"><div class="v">${s.verified_count} / ${r.rows.length}</div><div class="l">Verified</div></div>
      <div class="stat ${s.no_show_count ? 'bad' : ''}"><div class="v">${s.no_show_count}</div><div class="l">No-shows</div></div>
    </div>
    ${r.rows.length ? Object.entries(byDay).map(([day, rows]) => `
      <h2>${dayLabel(day, { weekday: 'long', month: 'short', day: 'numeric' })} <span class="muted small">${rows.length} people · ${fmtH(rows.reduce((a, x) => a + x.planned_hours, 0))} h projected</span></h2>
      <div class="table-wrap"><table class="list">
        <thead><tr><th>Project</th><th>Employee</th><th class="right">Projected</th><th style="width:110px">Actual</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((x) => `<tr data-id="${x.id}">
          <td>${esc(x.job_number)}<div class="small muted">${esc(x.project_name)}</div></td>
          <td>${esc(fullName(x))}<div class="small muted">${esc(x.trade || '')}</div></td>
          <td class="right">${fmtH(x.planned_hours)}</td>
          <td><input type="number" step="0.25" min="0" max="24" value="${x.status === 'scheduled' ? x.planned_hours : x.actual_hours ?? 0}" data-actual></td>
          <td>${x.status === 'scheduled' ? `<span class="pill ${day <= today ? 'warn' : ''}">${day <= today ? 'Pending' : 'Upcoming'}</span>`
            : x.status === 'no_show' ? '<span class="pill bad">No-show</span>'
            : `<span class="pill ok">${x.status === 'adjusted' ? 'Adjusted' : 'Verified'}</span>`}
            ${x.verified_by_name ? `<div class="small muted">${esc(x.verified_by_name)}</div>` : ''}</td>
          <td class="nowrap"><button class="ok" data-v="verified" title="Confirm hours">✓</button> <button class="danger" data-v="no_show" title="No-show">✗</button>
            ${x.status !== 'scheduled' ? '<button class="link" data-v="scheduled" title="Undo">undo</button>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>`).join('') : '<div class="card muted">Nothing scheduled this week.</div>'}`;

  const go = (w) => { S.verifyWeek = w; renderVerify(page); };
  $('[data-act=prev]', page).onclick = () => go(addDays(S.verifyWeek, -7));
  $('[data-act=next]', page).onclick = () => go(addDays(S.verifyWeek, 7));
  $('[data-act=proj]', page).onchange = (e) => { S.verifyProject = e.target.value; renderVerify(page); };
  const all = $('[data-act=all]', page);
  if (all) all.onclick = async () => {
    if (!confirm(`Confirm ${pastPending.length} assignments worked as scheduled?`)) return;
    const res = await api('POST', '/verification/bulk', { ids: pastPending.map((x) => x.id) });
    toast(`Verified ${res.verified}`); renderVerify(page);
  };
  $$('tr[data-id] [data-v]', page).forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    try {
      await api('POST', `/assignments/${tr.dataset.id}/verify`, { status: b.dataset.v, actual_hours: $('[data-actual]', tr).value });
      renderVerify(page);
    } catch (e) { toast(e.message, true); }
  }));
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
async function renderProjects(page) {
  const showAll = store('wf_proj_all') === '1';
  const [projects, users] = await Promise.all([api('GET', `/projects${showAll ? '?all=1' : ''}`), canSchedule() ? api('GET', '/users') : []]);
  S.projectUsers = users;
  const statusPill = (s) => `<span class="pill ${s === 'active' ? 'ok' : s === 'on_hold' ? 'warn' : s === 'complete' ? '' : 'job'}">${esc(s.replace('_', ' '))}</span>`;
  page.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Projects</h1><span class="spacer"></span>
      <label class="check"><input type="checkbox" data-act="all" ${showAll ? 'checked' : ''}> Show completed</label>
      ${canSchedule() ? '<button class="primary" data-act="new">+ New project</button>' : ''}</div>
    <div class="table-wrap"><table class="list">
      <thead><tr><th>Job #</th><th>Project</th><th>Superintendent</th><th>Status</th><th>Dates</th><th class="right">Hours to date</th><th class="right">Verified</th><th style="width:160px">Budget</th></tr></thead>
      <tbody>${projects.map((p) => {
        const pct = p.budget_hours ? Math.round((p.hours_to_date / p.budget_hours) * 100) : null;
        return `<tr class="${canSchedule() ? 'click' : ''}" data-id="${p.id}">
          <td class="nowrap"><span class="proj-swatch" style="background:${esc(p.color || '#F15A22')}"></span><b>${esc(p.job_number)}</b></td>
          <td>${esc(p.name)}<div class="small muted">${esc([p.customer, p.address].filter(Boolean).join(' · '))}</div></td>
          <td>${esc(p.superintendent_name || '')}</td><td>${statusPill(p.status)}</td>
          <td class="small nowrap">${esc(p.start_date || '')}${p.end_date ? ' → ' + esc(p.end_date) : ''}</td>
          <td class="right">${fmtH(p.hours_to_date)}</td><td class="right">${fmtH(p.verified_hours)}</td>
          <td>${pct !== null ? `<div class="small">${fmtH(p.budget_hours)} h · ${pct}%</div><div class="bar ${pct > 100 ? 'over' : pct > 85 ? 'near' : ''}"><span style="width:${Math.min(pct, 100)}%"></span></div>` : '<span class="small muted">—</span>'}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="8" class="muted">No projects yet.</td></tr>'}</tbody>
    </table></div>`;
  $('[data-act=all]', page).onchange = (e) => { store('wf_proj_all', e.target.checked ? '1' : '0'); renderProjects(page); };
  if (canSchedule()) {
    $('[data-act=new]', page).onclick = () => projectModal({ status: 'active' });
    $$('tr[data-id]', page).forEach((tr) => (tr.onclick = () => projectModal(projects.find((p) => p.id === Number(tr.dataset.id)))));
  }
}

function projectModal(p) {
  const supers = (S.projectUsers || []).filter((u) => u.role !== 'viewer');
  const m = modal({
    title: p.id ? `Edit ${p.job_number}` : 'New project',
    body: `<div class="grid2">
        <label>Job number *<input name="job_number" value="${esc(p.job_number || '')}"></label>
        <label>Project name *<input name="name" value="${esc(p.name || '')}"></label>
        <label>Customer / GC<input name="customer" value="${esc(p.customer || '')}"></label>
        <label>Superintendent<select name="superintendent_user_id"><option value="">—</option>${supers.map((u) => opt(u.id, u.name, p.superintendent_user_id)).join('')}</select></label>
        <label>Status<select name="status">${['planned', 'active', 'on_hold', 'complete'].map((s) => opt(s, s.replace('_', ' '), p.status)).join('')}</select></label>
        <label>Budgeted labor hours<input type="number" name="budget_hours" min="0" value="${esc(p.budget_hours ?? '')}"></label>
        <label>Start date<input type="date" name="start_date" value="${esc(p.start_date || '')}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(p.end_date || '')}"></label>
        <label>Board color<input type="color" name="color" value="${esc(p.color || '#F15A22')}"></label>
      </div>
      <label>Site address<input name="address" value="${esc(p.address || '')}"></label>
      <label>Notes<textarea name="notes">${esc(p.notes || '')}</textarea></label>`,
    footer: `${p.id && isAdmin() ? '<button class="danger" data-act="del">Delete</button>' : ''}<span class="spacer"></span><button data-close>Cancel</button><button class="primary" data-act="save">Save</button>`,
  });
  $('[data-act=save]', m.el).onclick = async () => {
    try { await api(p.id ? 'PUT' : 'POST', p.id ? `/projects/${p.id}` : '/projects', formData(m.el)); m.close(); toast('Saved'); renderProjects($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
  const del = $('[data-act=del]', m.el);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${p.job_number}?`)) return;
    try { await api('DELETE', `/projects/${p.id}`); m.close(); toast('Deleted'); renderProjects($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
}

// ---------------------------------------------------------------------------
// Employees + skills
// ---------------------------------------------------------------------------
async function renderEmployees(page) {
  const showAll = store('wf_emp_all') === '1';
  const [employees, skills] = await Promise.all([api('GET', `/employees${showAll ? '?all=1' : ''}`), api('GET', '/skills')]);
  const trades = [...new Set(employees.map((e) => e.trade).filter(Boolean))].sort();
  const today = todayStr();
  let q = ''; let trade = ''; let skill = '';
  page.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Employees</h1><span class="spacer"></span>
      <label class="check"><input type="checkbox" data-act="all" ${showAll ? 'checked' : ''}> Show inactive</label>
      ${canSchedule() ? '<button data-act="skills">Manage skills</button><button class="primary" data-act="new">+ New employee</button>' : ''}</div>
    <div class="toolbar">
      <input type="search" data-f="q" placeholder="Search name, phone, local…" style="flex:1;min-width:180px">
      <select data-f="trade"><option value="">All trades</option>${trades.map((x) => opt(x, x)).join('')}</select>
      <select data-f="skill"><option value="">Any skill</option>${skills.map((x) => opt(x.name, `${x.name} (${x.employee_count})`)).join('')}</select>
    </div>
    <div class="stats" id="trade-stats"></div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Trade</th><th>Union local</th><th>Classification</th><th>Skills / certs</th><th>Phone</th></tr></thead><tbody id="emp-rows"></tbody></table></div>`;

  const draw = () => {
    const rows = employees.filter((e) =>
      (!q || [fullName(e), e.phone, e.union_local, e.employee_no, e.email].join(' ').toLowerCase().includes(q)) &&
      (!trade || e.trade === trade) && (!skill || e.skills.some((s) => s.name === skill)));
    const counts = {};
    for (const e of rows) counts[e.trade || 'No trade'] = (counts[e.trade || 'No trade'] || 0) + 1;
    $('#trade-stats', page).innerHTML = `<div class="stat"><div class="v">${rows.length}</div><div class="l">Employees shown</div></div>` +
      Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${esc(k)}</div></div>`).join('');
    $('#emp-rows', page).innerHTML = rows.map((e) => `<tr class="click" data-id="${e.id}" style="${e.active ? '' : 'opacity:.55'}">
      <td><b>${esc(e.last_name)}, ${esc(e.first_name)}</b>${e.employee_no ? `<div class="small muted">#${esc(e.employee_no)}</div>` : ''}${e.active ? '' : ' <span class="pill">inactive</span>'}</td>
      <td>${esc(e.trade || '')}</td><td>${esc(e.union_local || '')}</td><td>${esc(e.classification || '')}</td>
      <td>${e.skills.map((s) => `<span class="tag ${s.expires_on && s.expires_on < today ? 'expired' : ''}" title="${s.expires_on ? 'Expires ' + esc(s.expires_on) : ''}">${esc(s.name)}</span>`).join('')}</td>
      <td class="nowrap">${e.phone ? `<a href="tel:${esc(e.phone)}" data-tel>${esc(e.phone)}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No employees match.</td></tr>';
    $$('tr[data-id]', page).forEach((tr) => (tr.onclick = (ev) => !ev.target.closest('[data-tel]') && employeeModal(employees.find((e) => e.id === Number(tr.dataset.id)), skills)));
  };
  $('[data-f=q]', page).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  $('[data-f=trade]', page).onchange = (e) => { trade = e.target.value; draw(); };
  $('[data-f=skill]', page).onchange = (e) => { skill = e.target.value; draw(); };
  $('[data-act=all]', page).onchange = (e) => { store('wf_emp_all', e.target.checked ? '1' : '0'); renderEmployees(page); };
  if (canSchedule()) {
    $('[data-act=new]', page).onclick = () => employeeModal({ active: 1, skills: [] }, skills);
    $('[data-act=skills]', page).onclick = () => skillsModal(skills);
  }
  draw();
}

function employeeModal(e, skills) {
  const ro = !canSchedule();
  const dis = ro ? 'disabled' : '';
  const have = new Map(e.skills.map((s) => [s.name, s.expires_on]));
  const m = modal({
    title: e.id ? fullName(e) : 'New employee',
    wide: true,
    body: `<div class="grid2">
        <label>First name *<input name="first_name" value="${esc(e.first_name || '')}" ${dis}></label>
        <label>Last name *<input name="last_name" value="${esc(e.last_name || '')}" ${dis}></label>
        <label>Employee #<input name="employee_no" value="${esc(e.employee_no || '')}" ${dis}></label>
        <label>Phone<input name="phone" type="tel" value="${esc(e.phone || '')}" ${dis}></label>
        <label>Email<input name="email" type="email" value="${esc(e.email || '')}" ${dis}></label>
        <label>Hire date<input name="hire_date" type="date" value="${esc(e.hire_date || '')}" ${dis}></label>
        <label>Union trade<input name="trade" list="trade-list" value="${esc(e.trade || '')}" placeholder="Carpenter, Laborer, Ironworker…" ${dis}></label>
        <label>Union local<input name="union_local" value="${esc(e.union_local || '')}" placeholder="e.g. 1445" ${dis}></label>
        <label>Classification<input name="classification" list="class-list" value="${esc(e.classification || '')}" placeholder="Journeyman, Apprentice, Foreman…" ${dis}></label>
      </div>
      <datalist id="trade-list">${['Carpenter', 'Laborer', 'Operating Engineer', 'Ironworker', 'Cement Mason', 'Millwright', 'Teamster', 'Electrician', 'Pipefitter', 'Plumber'].map((t) => `<option value="${t}">`).join('')}</datalist>
      <datalist id="class-list">${['General Foreman', 'Foreman', 'Journeyman', 'Apprentice 1st yr', 'Apprentice 2nd yr', 'Apprentice 3rd yr', 'Apprentice 4th yr', 'Operator', 'Laborer Group 1'].map((t) => `<option value="${t}">`).join('')}</datalist>
      <div><div class="small muted" style="margin-bottom:4px">Skills &amp; certifications (expiration optional)</div>
        <div class="grid2" id="skill-grid">${skills.map((s) => `<div style="display:flex;gap:6px;align-items:center">
          <label class="check" style="flex:1"><input type="checkbox" data-skill="${esc(s.name)}" ${have.has(s.name) ? 'checked' : ''} ${dis}>${esc(s.name)}</label>
          <input type="date" data-exp="${esc(s.name)}" value="${esc(have.get(s.name) || '')}" style="width:150px" ${dis}></div>`).join('')}</div>
        ${ro ? '' : '<input placeholder="Add new skills, comma separated (e.g. OSHA 30, Forklift)" data-newskills style="margin-top:8px">'}</div>
      <label>Notes<textarea name="notes" ${dis}>${esc(e.notes || '')}</textarea></label>
      ${e.id ? `<label class="check"><input type="checkbox" name="active" ${e.active ? 'checked' : ''} ${dis}> Active</label><div id="emp-hist" class="small muted">Loading history…</div>` : ''}`,
    footer: ro ? '<button data-close>Close</button>' : `${e.id && isAdmin() ? '<button class="danger" data-act="del">Delete</button>' : ''}<span class="spacer"></span>
      ${e.id ? '<button data-act="off">Time off…</button>' : ''}<button data-close>Cancel</button><button class="primary" data-act="save">Save</button>`,
  });
  if (e.id) api('GET', `/employees/${e.id}`).then((full) => {
    const h = $('#emp-hist', m.el); if (!h) return;
    const total = full.recent.reduce((s, r) => s + (r.actual_hours ?? r.planned_hours), 0);
    h.innerHTML = full.recent.length ? `<b>Recent work</b> (${full.recent.length} days, ${fmtH(total)} h)<div class="table-wrap" style="max-height:200px;margin-top:4px"><table class="list"><tbody>${full.recent.map((r) => `<tr><td>${esc(r.work_date)}</td><td>${esc(r.job_number)} ${esc(r.project_name)}</td><td class="right">${fmtH(r.actual_hours ?? r.planned_hours)} h</td><td>${esc(r.status)}</td></tr>`).join('')}</tbody></table></div>` : 'No work history yet.';
  });
  if (ro) return;
  $('[data-act=save]', m.el).onclick = async () => {
    const f = formData(m.el);
    const sk = $$('[data-skill]', m.el).filter((x) => x.checked).map((x) => ({ name: x.dataset.skill, expires_on: $(`[data-exp="${CSS.escape(x.dataset.skill)}"]`, m.el).value || null }));
    const extra = ($('[data-newskills]', m.el).value || '').split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }));
    const body = { ...f, active: e.id ? f.active : true, skills: [...sk, ...extra] };
    try { await api(e.id ? 'PUT' : 'POST', e.id ? `/employees/${e.id}` : '/employees', body); m.close(); toast('Saved'); renderEmployees($('#page')); } catch (err) { errorBox(m.el, err.message); }
  };
  const del = $('[data-act=del]', m.el);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${fullName(e)}? (Employees with history are deactivated instead.)`)) return;
    const r = await api('DELETE', `/employees/${e.id}`); m.close(); toast(r.deactivated ? 'Has history – marked inactive' : 'Deleted'); renderEmployees($('#page'));
  };
  const off = $('[data-act=off]', m.el);
  if (off) off.onclick = async () => {
    if (!S.sched || S.sched.start !== S.week) S.sched = await api('GET', `/schedule?start=${S.week}`);
    if (!S.employees) await loadLookups();
    timeOffModal({ employee_id: e.id });
  };
}

function skillsModal(skills) {
  const m = modal({
    title: 'Skills & certifications',
    body: `<div style="display:flex;gap:8px"><input data-new placeholder="New skill (e.g. Crane Signal Person)"><button class="primary" data-act="add">Add</button></div>
      <div class="table-wrap"><table class="list"><tbody>${skills.map((s) => `<tr><td>${esc(s.name)}</td><td class="right muted">${s.employee_count} people</td>
        <td class="right">${isAdmin() ? `<button class="link" data-del="${s.id}">remove</button>` : ''}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table></div>`,
    footer: '<button data-close>Done</button>',
  });
  $('[data-act=add]', m.el).onclick = async () => {
    try {
      await api('POST', '/skills', { name: $('[data-new]', m.el).value });
      await renderEmployees($('#page'));
      skillsModal(await api('GET', '/skills'));
    } catch (e) { errorBox(m.el, e.message); }
  };
  $$('[data-del]', m.el).forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this skill from everyone?')) return;
    await api('DELETE', `/skills/${b.dataset.del}`); m.close(); renderEmployees($('#page'));
  }));
}

// ---------------------------------------------------------------------------
// Records (historical database lookup)
// ---------------------------------------------------------------------------
async function renderRecords(page) {
  if (!S.employees || !S.projects) await loadLookups();
  const [allEmps, allProjs] = await Promise.all([api('GET', '/employees?all=1'), api('GET', '/projects?all=1')]);
  const trades = [...new Set(allEmps.map((e) => e.trade).filter(Boolean))].sort();
  const f = S.recordFilter || { from: addDays(todayStr(), -30), to: todayStr() };
  page.innerHTML = `<h1>Records</h1>
    <div class="card"><div class="grid2" id="rec-f">
      <label>From<input type="date" name="from" value="${esc(f.from || '')}"></label>
      <label>To<input type="date" name="to" value="${esc(f.to || '')}"></label>
      <label>Project<select name="project_id"><option value="">All</option>${allProjs.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, f.project_id)).join('')}</select></label>
      <label>Employee<select name="employee_id"><option value="">All</option>${allEmps.map((e) => opt(e.id, `${e.last_name}, ${e.first_name}`, f.employee_id)).join('')}</select></label>
      <label>Trade<select name="trade"><option value="">All</option>${trades.map((t) => opt(t, t, f.trade)).join('')}</select></label>
      <label>Status<select name="status"><option value="">All</option>${['scheduled', 'verified', 'adjusted', 'no_show'].map((s) => opt(s, s.replace('_', '-'), f.status)).join('')}</select></label>
    </div><div class="toolbar" style="margin:12px 0 0"><button class="primary" data-act="run">Search</button><button data-act="csv">Export CSV (Excel)</button></div></div>
    <div id="rec-out"></div>`;
  const qs = () => new URLSearchParams(Object.entries(formData($('#rec-f', page))).filter(([, v]) => v)).toString();
  const run = async () => {
    S.recordFilter = formData($('#rec-f', page));
    const r = await api('GET', `/records?${qs()}`);
    const s = r.summary;
    $('#rec-out', page).innerHTML = `
      <div class="stats"><div class="stat"><div class="v">${s.rows}</div><div class="l">Crew-days</div></div>
        <div class="stat"><div class="v">${fmtH(s.planned)}</div><div class="l">Projected hrs</div></div>
        <div class="stat"><div class="v">${fmtH(s.actual)}</div><div class="l">Verified actual hrs</div></div></div>
      <div class="grid2">
        <div class="card"><b>Hours by project</b><table class="list">${Object.entries(s.by_project).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right">${fmtH(v)}</td></tr>`).join('')}</table></div>
        <div class="card"><b>Hours by trade</b><table class="list">${Object.entries(s.by_trade).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="right">${fmtH(v)}</td></tr>`).join('')}</table></div>
      </div>
      ${r.truncated ? '<div class="alert warn">Showing first 2,000 rows. Export CSV for the full set.</div>' : ''}
      <div class="table-wrap"><table class="list"><thead><tr><th>Date</th><th>Job</th><th>Employee</th><th>Trade</th><th class="right">Projected</th><th class="right">Actual</th><th>Status</th><th>Task</th></tr></thead>
      <tbody>${r.rows.map((x) => `<tr><td class="nowrap">${esc(x.work_date)}</td><td>${esc(x.job_number)} <span class="small muted">${esc(x.project_name)}</span></td>
        <td>${esc(fullName(x))}</td><td>${esc(x.trade || '')}</td><td class="right">${fmtH(x.planned_hours)}</td><td class="right">${x.actual_hours === null ? '' : fmtH(x.actual_hours)}</td>
        <td><span class="pill ${x.status === 'no_show' ? 'bad' : x.status === 'scheduled' ? '' : 'ok'}">${esc(x.status.replace('_', '-'))}</span></td><td class="small">${esc(x.task || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No records.</td></tr>'}</tbody></table></div>`;
  };
  $('[data-act=run]', page).onclick = run;
  $('[data-act=csv]', page).onclick = () => { window.location = `/api/records?${qs()}&format=csv`; };
  run();
}

// ---------------------------------------------------------------------------
// Payroll forecast (private)
// ---------------------------------------------------------------------------
S.payStart = null; S.payWeeks = 4; S.payTab = 'forecast';
async function renderPayroll(page) {
  if (!S.payStart) S.payStart = weekStart(todayStr());
  page.innerHTML = `<div class="private-banner">🔒 Private – visible only to users with payroll access. Pay rates never appear anywhere else in the app.</div>
    <div class="toolbar"><h1 style="margin:0">Payroll Forecast</h1><span class="spacer"></span>
      <div class="seg"><button data-tab="forecast" class="${S.payTab === 'forecast' ? 'on' : ''}">Forecast</button><button data-tab="rates" class="${S.payTab === 'rates' ? 'on' : ''}">Pay rates</button></div></div>
    <div id="pay-body" class="muted">Loading…</div>`;
  $$('[data-tab]', page).forEach((b) => (b.onclick = () => { S.payTab = b.dataset.tab; renderPayroll(page); }));
  if (S.payTab === 'rates') return payRates($('#pay-body', page));
  const r = await api('GET', `/payroll/forecast?start=${S.payStart}&weeks=${S.payWeeks}`);
  const t = r.totals;
  const cols = ['hours', 'reg_hours', 'ot_hours', 'wages', 'burden', 'fringe', 'total'];
  const heads = '<th class="right">Hours</th><th class="right">Reg</th><th class="right">OT</th><th class="right">Wages</th><th class="right">Burden</th><th class="right">Fringe</th><th class="right">Total cost</th>';
  const cells = (x) => cols.map((c) => `<td class="right ${c === 'ot_hours' && x[c] > 0 ? 'over40' : ''}">${c.includes('hours') ? fmtH(x[c]) : money(x[c])}</td>`).join('');
  const grid = new Map(r.project_week.map((x) => [`${x.project_id}|${x.week}`, x]));
  $('#pay-body', page).classList.remove('muted');
  $('#pay-body', page).innerHTML = `
    <div class="toolbar">
      <button data-act="prev">‹</button><label class="check">Starting week of <input type="date" data-act="start" value="${r.start}"></label><button data-act="next">›</button>
      <select data-act="weeks">${[1, 2, 4, 6, 8, 13, 26].map((w) => opt(w, `${w} week${w > 1 ? 's' : ''}`, S.payWeeks)).join('')}</select>
      <span class="spacer"></span><span class="small muted">OT after ${r.settings.ot_threshold_hours} h/wk @ ${r.settings.ot_multiplier}× · default burden ${r.settings.default_burden_pct}%</span>
    </div>
    ${r.missing_rates.length ? `<div class="alert warn">Missing pay rates (costed at $0): ${esc(r.missing_rates.join(', '))}. <a href="#" data-act="fix">Enter rates</a></div>` : ''}
    <div class="stats" style="margin-top:12px">
      <div class="stat"><div class="v">${money(t.total)}</div><div class="l">Forecast labor cost</div></div>
      <div class="stat"><div class="v">${fmtH(t.hours)}</div><div class="l">Hours</div></div>
      <div class="stat ${t.ot_hours ? 'warn' : ''}"><div class="v">${fmtH(t.ot_hours)}</div><div class="l">Overtime hours</div></div>
      <div class="stat"><div class="v">${t.hours ? money(t.total / t.hours) : '—'}</div><div class="l">Avg cost / hour</div></div>
      <div class="stat"><div class="v">${money(t.wages)}</div><div class="l">Gross wages</div></div>
    </div>
    <h2>By week</h2>
    <div class="table-wrap"><table class="list"><thead><tr><th>Week of</th>${heads}</tr></thead>
      <tbody>${r.by_week.map((w) => `<tr><td>${esc(weekLabel(w.week))}</td>${cells(w)}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${cells(t)}</tr></tfoot></table></div>
    <h2>Project × week (total cost)</h2>
    <div class="table-wrap"><table class="list"><thead><tr><th>Project</th>${r.weeks.map((w) => `<th class="right">${esc(w.slice(5).replace('-', '/'))}</th>`).join('')}<th class="right">Total</th></tr></thead>
      <tbody>${r.by_project.map((p) => `<tr><td>${esc(p.job_number)} <span class="small muted">${esc(p.project_name)}</span></td>${r.weeks.map((w) => `<td class="right">${grid.has(`${p.project_id}|${w}`) ? money(grid.get(`${p.project_id}|${w}`).total) : ''}</td>`).join('')}<td class="right"><b>${money(p.total)}</b></td></tr>`).join('')}</tbody></table></div>
    <h2>By project</h2>
    <div class="table-wrap"><table class="list"><thead><tr><th>Project</th>${heads}</tr></thead>
      <tbody>${r.by_project.map((p) => `<tr><td>${esc(p.job_number)} <span class="small muted">${esc(p.project_name)}</span></td>${cells(p)}</tr>`).join('')}</tbody></table></div>
    <h2>By trade</h2>
    <div class="table-wrap"><table class="list"><thead><tr><th>Trade</th>${heads}</tr></thead>
      <tbody>${r.by_trade.map((p) => `<tr><td>${esc(p.trade)}</td>${cells(p)}</tr>`).join('')}</tbody></table></div>
    <h2>By employee</h2>
    <div class="table-wrap"><table class="list"><thead><tr><th>Employee</th>${heads}</tr></thead>
      <tbody>${r.by_employee.map((p) => `<tr><td>${esc(p.name)} <span class="small muted">${esc(p.trade || '')}</span></td>${cells(p)}</tr>`).join('')}</tbody></table></div>
    <p class="small muted">Uses verified actual hours where entered, otherwise scheduled hours. Wages = Reg × base + OT × base × multiplier. Burden = wages × burden %. Fringe = all hours × fringe rate.</p>`;
  const body = $('#pay-body', page);
  $('[data-act=prev]', body).onclick = () => { S.payStart = addDays(S.payStart, -7); renderPayroll(page); };
  $('[data-act=next]', body).onclick = () => { S.payStart = addDays(S.payStart, 7); renderPayroll(page); };
  $('[data-act=start]', body).onchange = (e) => { if (e.target.value) { S.payStart = weekStart(e.target.value); renderPayroll(page); } };
  $('[data-act=weeks]', body).onchange = (e) => { S.payWeeks = Number(e.target.value); renderPayroll(page); };
  const fix = $('[data-act=fix]', body); if (fix) fix.onclick = (e) => { e.preventDefault(); S.payTab = 'rates'; renderPayroll(page); };
}

async function payRates(el) {
  const rows = await api('GET', '/payroll/rates');
  el.classList.remove('muted');
  el.innerHTML = `<p class="small muted">Enter each person's base hourly wage, union fringe package per hour, and burden % (payroll taxes, WC, GL). Leave burden blank to use the company default.</p>
    <div class="table-wrap"><table class="list"><thead><tr><th>Employee</th><th>Trade / local</th><th style="width:120px">Base $/hr</th><th style="width:120px">Fringe $/hr</th><th style="width:110px">Burden %</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.employee_id}">
      <td>${esc(r.last_name)}, ${esc(r.first_name)}<div class="small muted">${esc(r.classification || '')}</div></td>
      <td>${esc(r.trade || '')}${r.union_local ? ` · L${esc(r.union_local)}` : ''}</td>
      <td><input type="number" step="0.01" min="0" name="base_rate" value="${r.base_rate ?? ''}"></td>
      <td><input type="number" step="0.01" min="0" name="fringe_rate" value="${r.fringe_rate ?? ''}"></td>
      <td><input type="number" step="0.1" min="0" name="burden_pct" value="${r.burden_pct ?? ''}" placeholder="default"></td>
      <td><button data-save>Save</button></td></tr>`).join('')}</tbody></table></div>`;
  $$('tr[data-id]', el).forEach((tr) => {
    const save = async () => {
      try { await api('PUT', `/payroll/rates/${tr.dataset.id}`, formData(tr)); toast('Rate saved'); } catch (e) { toast(e.message, true); }
    };
    $('[data-save]', tr).onclick = save;
    $$('input', tr).forEach((i) => i.addEventListener('keydown', (e) => e.key === 'Enter' && save()));
  });
}

// ---------------------------------------------------------------------------
// Admin: users, settings, audit log
// ---------------------------------------------------------------------------
S.adminTab = 'users';
async function renderAdmin(page) {
  page.innerHTML = `<div class="toolbar"><h1 style="margin:0">Admin</h1><span class="spacer"></span>
    <div class="seg">${[['users', 'Users'], ['settings', 'Settings'], ['audit', 'Activity log']].map(([k, l]) => `<button data-tab="${k}" class="${S.adminTab === k ? 'on' : ''}">${l}</button>`).join('')}</div></div><div id="admin-body"></div>`;
  $$('[data-tab]', page).forEach((b) => (b.onclick = () => { S.adminTab = b.dataset.tab; renderAdmin(page); }));
  const el = $('#admin-body', page);
  if (S.adminTab === 'users') return adminUsers(el);
  if (S.adminTab === 'settings') return adminSettings(el);
  const log = await api('GET', '/audit');
  el.innerHTML = `<div class="table-wrap"><table class="list"><thead><tr><th>When (UTC)</th><th>User</th><th>Action</th><th>Item</th><th>Details</th></tr></thead>
    <tbody>${log.map((l) => `<tr><td class="nowrap small">${esc(l.at)}</td><td>${esc(l.user_name || '')}</td><td>${esc(l.action)}</td><td>${esc(l.entity)}${l.entity_id ? ' #' + l.entity_id : ''}</td><td class="small muted">${esc(l.details || '')}</td></tr>`).join('')}</tbody></table></div>`;
}

async function adminUsers(el) {
  const [users, emps] = await Promise.all([api('GET', '/users'), api('GET', '/employees')]);
  const roleName = { admin: 'Workforce Manager (admin)', super: 'Superintendent', viewer: 'Field staff (view only)' };
  el.innerHTML = `<div class="toolbar"><span class="muted small">Superintendents can schedule and verify hours. Field staff can view the schedule and their own assignments. Payroll access is granted separately.</span><span class="spacer"></span><button class="primary" data-act="new">+ New user</button></div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Payroll</th><th>Linked employee</th><th>Status</th></tr></thead>
    <tbody>${users.map((u) => `<tr class="click" data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(roleName[u.role])}</td>
      <td>${u.role === 'admin' || u.can_view_payroll ? '<span class="pill warn">🔒 Yes</span>' : ''}</td>
      <td>${esc((emps.find((e) => e.id === u.employee_id) && fullName(emps.find((e) => e.id === u.employee_id))) || '')}</td>
      <td>${u.active ? '<span class="pill ok">active</span>' : '<span class="pill">disabled</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  const edit = (u) => {
    const m = modal({
      title: u.id ? `Edit ${u.name}` : 'New user',
      body: `<div class="grid2">
          <label>Full name<input name="name" value="${esc(u.name || '')}"></label>
          <label>Username<input name="username" value="${esc(u.username || '')}" autocapitalize="none"></label>
          <label>Role<select name="role">${Object.entries(roleName).map(([k, v]) => opt(k, v, u.role || 'viewer')).join('')}</select></label>
          <label>Linked employee (for "My Schedule")<select name="employee_id"><option value="">—</option>${emps.map((e) => opt(e.id, `${e.last_name}, ${e.first_name}`, u.employee_id)).join('')}</select></label>
          <label>${u.id ? 'Reset password (leave blank to keep)' : 'Password (8+ characters)'}<input name="password" type="text" autocomplete="new-password"></label>
        </div>
        <label class="check"><input type="checkbox" name="can_view_payroll" ${u.can_view_payroll ? 'checked' : ''}> 🔒 Can view private payroll forecast &amp; pay rates</label>
        <label class="check"><input type="checkbox" name="active" ${u.active !== 0 ? 'checked' : ''}> Account active</label>`,
      footer: '<button data-close>Cancel</button><button class="primary" data-act="save">Save</button>',
    });
    $('[data-act=save]', m.el).onclick = async () => {
      try { await api(u.id ? 'PUT' : 'POST', u.id ? `/users/${u.id}` : '/users', formData(m.el)); m.close(); toast('Saved'); adminUsers(el); } catch (e) { errorBox(m.el, e.message); }
    };
  };
  $('[data-act=new]', el).onclick = () => edit({ active: 1 });
  $$('tr[data-id]', el).forEach((tr) => (tr.onclick = () => edit(users.find((u) => u.id === Number(tr.dataset.id)))));
}

async function adminSettings(el) {
  const s = await api('GET', '/settings');
  el.innerHTML = `<div class="card"><div class="grid2" id="set-f">
      <label>Company / app name<input name="company_name" value="${esc(s.company_name)}"></label>
      <label>Default hours per day<input type="number" step="0.5" name="default_hours" value="${esc(s.default_hours)}"></label>
      <label>Default start time<input type="time" name="default_start_time" value="${esc(s.default_start_time)}"></label>
      <label>OT after (hours / week)<input type="number" name="ot_threshold_hours" value="${esc(s.ot_threshold_hours)}"></label>
      <label>OT multiplier<input type="number" step="0.1" name="ot_multiplier" value="${esc(s.ot_multiplier)}"></label>
      <label>Default burden % (taxes, WC, GL)<input type="number" step="0.1" name="default_burden_pct" value="${esc(s.default_burden_pct)}"></label>
    </div><div style="margin-top:12px"><button class="primary" data-act="save">Save settings</button></div></div>
    <div class="card"><b>Backup</b><p class="small muted">Download a complete copy of the database (schedule history, employees, projects, pay rates). Store it somewhere secure – it contains payroll data.</p>
      <a class="btn" href="/api/backup">Download database backup</a></div>`;
  $('[data-act=save]', el).onclick = async () => {
    await api('PUT', '/settings', formData($('#set-f', el)));
    toast('Settings saved');
    const me = await api('GET', '/me'); S.settings = me.settings;
  };
}

boot();
