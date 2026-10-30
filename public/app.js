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
// Project leads are employees picked by classification.
const isSuperOrForeman = (e) => /superintendent|foreman/i.test(e.classification || '');
const isProjectManager = (e) => /project manager/i.test(e.classification || '');
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
  filterSuper: store('wf_supt') || '',
  filterPm: store('wf_pm') || '',
  onlyWithHours: store('wf_only_hours') !== '0', // hide jobs with no crew scheduled (on by default)
  boardSort: store('wf_sort') || 'job',
  filterTrade: '',
};
const canSchedule = () => S.user && ['admin', 'super'].includes(S.user.role);
// Manager edits any job; a superintendent edits only jobs where they are the listed superintendent.
const canEditProject = (pid) => {
  if (!S.user) return false;
  if (S.user.role === 'admin') return true;
  if (S.user.role !== 'super' || !S.user.employee_id) return false;
  const p = (S.projects || []).find((x) => x.id === Number(pid)) || (S.sched?.projects || []).find((x) => x.id === Number(pid));
  return !!p && p.superintendent_employee_id === S.user.employee_id;
};
const myProjects = () => (S.projects || []).filter((p) => p.status !== 'complete' && canEditProject(p.id));
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
  // Field crew = everyone except office staff (project managers), who aren't scheduled.
  S.crew = employees.filter((e) => !isProjectManager(e));
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
  const activeEmployees = S.crew.length;
  const leadList = (idKey, nameKey) => [...new Map(data.projects.filter((p) => p[nameKey]).map((p) => [p[idKey], p[nameKey]])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const supers = leadList('superintendent_employee_id', 'superintendent_name');
  const pms = leadList('project_manager_employee_id', 'project_manager_name');
  const trades = [...new Set(S.crew.map((e) => e.trade).filter(Boolean))].sort();
  const overDay = t.over_day || [];
  const appr = t.approval || { pending: 0, rejected: 0 };
  if (S.view === 'dispatch' && mobile()) S.view = 'project';

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
        ${mobile() ? '' : `<button data-view="dispatch" class="${S.view === 'dispatch' ? 'on' : ''}" title="Every job and all available crew for one day – drag and drop to schedule">All Jobs</button>`}
      </div>
      ${S.view !== 'person' && pms.length ? `<select data-act="pm" title="Filter by project manager"><option value="">All project managers</option>${pms.map(([id, n]) => opt(id, n, S.filterPm)).join('')}</select>` : ''}
      ${S.view !== 'person' && supers.length ? `<select data-act="super" title="Filter by superintendent / foreman"><option value="">All superintendents</option>${supers.map(([id, n]) => opt(id, n, S.filterSuper)).join('')}</select>` : ''}
      ${S.view !== 'person' ? `<label class="check toggle-hours" title="Hide jobs with no crew scheduled, to shorten the list"><input type="checkbox" data-act="only-hours" ${S.onlyWithHours ? 'checked' : ''}> Only jobs with hours</label>` : ''}
      ${S.view !== 'person' ? `<select data-act="sort" title="Sort projects">${[['job', 'Sort: Job #'], ['pm', 'Sort: Project manager'], ['super', 'Sort: Superintendent']].map(([v, l]) => opt(v, l, S.boardSort)).join('')}</select>` : ''}
      ${S.view === 'person' ? `<select data-act="trade"><option value="">All trades</option>${trades.map((x) => opt(x, x, S.filterTrade)).join('')}</select>` : ''}
      ${canSchedule() ? `<button data-act="requests" class="${appr.pending ? 'attn' : ''}">${isAdmin() ? `Requests${appr.pending ? ` (${appr.pending})` : ''}` : `My requests${appr.pending || appr.rejected ? ` (${appr.pending + appr.rejected})` : ''}`}</button>
        <button data-act="copy">Copy last week →</button><button data-act="timeoff">Time off</button>
        <button class="primary" data-act="add">${isAdmin() ? '+ Schedule crew' : '+ Request crew'}</button>` : ''}
      <button data-act="print">Print</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${fmtH(t.hours)}</div><div class="l">Scheduled hours (week)</div></div>
      <div class="stat"><div class="v">${t.people} / ${activeEmployees}</div><div class="l">Employees scheduled</div></div>
      <div class="stat"><div class="v">${Object.keys(t.by_project).length}</div><div class="l">Projects staffed</div></div>
      ${todayCount !== null ? `<div class="stat"><div class="v">${todayCount}</div><div class="l">On site today</div></div>` : ''}
      ${(() => { const o = Object.values(t.by_employee).filter((h) => h > 40).length; return `<div class="stat ${o ? 'warn' : ''}"><div class="v">${o}</div><div class="l">Over 40 hrs (OT)</div></div>`; })()}
      <div class="stat ${overDay.length ? 'warn' : ''}"><div class="v">${overDay.length}</div><div class="l">Days over ${fmtH(t.warn_daily_hours || 8)} hrs</div></div>
      ${canSchedule() ? `<div class="stat ${appr.pending ? 'warn' : ''}"><div class="v">${appr.pending}</div><div class="l">Awaiting approval</div></div>` : ''}
    </div>
    ${canSchedule() ? `<div class="legend small"><span class="chip mini approved">✓ Approved</span><span class="chip mini pending">Pending approval</span><span class="chip mini rejected">✕ Rejected</span><span class="chip mini verified">✓✓ Hours verified</span>
      ${S.user.role === 'super' ? '<span class="muted">You can request crew on the jobs where you are the superintendent. The workforce manager approves them.</span>' : ''}</div>` : ''}
    ${S.user.role === 'super' && appr.rejected ? `<div class="alert warn-box"><b>${appr.rejected} request${appr.rejected > 1 ? 's were' : ' was'} rejected this week.</b> Click a struck-through name, or <button class="link" data-act="requests2">see the reasons</button>.</div>` : ''}
    ${overDay.length ? `<div class="alert warn-box"><b>⚠ Over ${fmtH(t.warn_daily_hours || 8)} hours in a day:</b> ${overDay.slice(0, 12).map((o) => {
      const e = S.employees.find((x) => x.id === o.employee_id);
      return `${esc(e ? fullName(e) : 'Employee')} ${esc(DOW[data.days.indexOf(o.work_date)])} (${fmtH(o.hours)} h)`;
    }).join(' · ')}${overDay.length > 12 ? ` · and ${overDay.length - 12} more` : ''}</div>` : ''}
    <div class="print-head"><img src="/logo.jpg" alt="Fager-McGee"><div>Weekly Crew Schedule  •  ${weekLabel(data.start)}</div></div>
    <div id="board"></div>`;

  const go = (w) => { S.week = weekStart(w); renderSchedule(page); };
  $('[data-act=prev]', page).onclick = () => go(addDays(S.week, -7));
  $('[data-act=next]', page).onclick = () => go(addDays(S.week, 7));
  $('[data-act=this]', page).onclick = () => go(todayStr());
  $('[data-act=pick]', page).onchange = (e) => e.target.value && go(e.target.value);
  $('[data-act=print]', page).onclick = () => window.print();
  $$('[data-view]', page).forEach((b) => (b.onclick = () => { S.view = store('wf_view', b.dataset.view); renderSchedule(page); }));
  const sup = $('[data-act=super]', page); if (sup) sup.onchange = (e) => { S.filterSuper = store('wf_supt', e.target.value); drawBoard(); };
  const pmSel = $('[data-act=pm]', page); if (pmSel) pmSel.onchange = (e) => { S.filterPm = store('wf_pm', e.target.value); drawBoard(); };
  const sortSel = $('[data-act=sort]', page); if (sortSel) sortSel.onchange = (e) => { S.boardSort = store('wf_sort', e.target.value); drawBoard(); };
  const onlyHours = $('[data-act=only-hours]', page);
  if (onlyHours) onlyHours.onchange = (e) => { S.onlyWithHours = e.target.checked; store('wf_only_hours', e.target.checked ? '1' : '0'); drawBoard(); };
  const tr = $('[data-act=trade]', page); if (tr) tr.onchange = (e) => { S.filterTrade = e.target.value; drawBoard(); };
  if (canSchedule()) {
    $('[data-act=requests]', page).onclick = requestsModal;
    const r2 = $('[data-act=requests2]', page); if (r2) r2.onclick = requestsModal;
    $('[data-act=add]', page).onclick = () => assignModal({});
    $('[data-act=copy]', page).onclick = copyWeekModal;
    $('[data-act=timeoff]', page).onclick = () => timeOffModal({});
  }
  drawBoard();
}

function drawBoard() {
  const el = $('#board');
  if (!el) return;
  if (S.view === 'dispatch' && !mobile()) dispatchBoard(el);
  else {
    if (S.view === 'person') el.innerHTML = mobile() ? personMobile() : personBoard();
    else el.innerHTML = mobile() ? projectMobile() : projectBoard();
    bindBoard(el);
  }
  $$('[data-act=show-all-jobs]', el).forEach((b) => (b.onclick = () => {
    S.onlyWithHours = false; store('wf_only_hours', '0');
    const box = $('[data-act=only-hours]'); if (box) box.checked = false;
    drawBoard();
  }));
}

function sortProjects(list, by) {
  const key = { pm: 'project_manager_name', super: 'superintendent_name' }[by];
  if (!key) return list;
  // Projects without a name for the sort key go last.
  return [...list].sort((a, b) => (a[key] || '\uffff').localeCompare(b[key] || '\uffff') || a.job_number.localeCompare(b.job_number));
}

// Projects for the board after the superintendent / PM filters. With "Only jobs
// with hours" on, jobs with no crew scheduled that week (or that day, for the
// day views) are left out so the list stays short.
function visibleProjects(day) {
  const d = S.sched;
  const filtered = d.projects.filter((p) =>
    (!S.filterSuper || String(p.superintendent_employee_id) === String(S.filterSuper)) &&
    (!S.filterPm || String(p.project_manager_employee_id) === String(S.filterPm)));
  const withHours = new Set(d.assignments.filter((a) => a.approval_status !== 'rejected' && (!day || a.work_date === day)).map((a) => a.project_id));
  const shown = S.onlyWithHours ? filtered.filter((p) => withHours.has(p.id)) : filtered;
  S.boardCounts = { shown: shown.length, total: filtered.length, day };
  return sortProjects(shown, S.boardSort);
}

// "Showing 8 of 51 jobs" line with a one-click way to see them all.
function hiddenJobsNote() {
  const c = S.boardCounts;
  if (!S.onlyWithHours || !c || c.shown === c.total) return '';
  return `<div class="hidden-note small">Showing <b>${c.shown}</b> of ${c.total} jobs – ${c.total - c.shown} with no crew scheduled ${c.day ? 'this day' : 'this week'} are hidden.
    <button class="link" data-act="show-all-jobs">Show all jobs</button></div>`;
}

// Total hours per person per day, to flag anyone over the daily warning threshold.
function overDayMap() {
  const m = {};
  for (const o of S.sched.totals.over_day || []) m[`${o.employee_id}|${o.work_date}`] = o.hours;
  return m;
}

function chip(a, label = shortName(a)) {
  const hrs = a.source === 'timecard' ? `<span class="hr" title="Worked but not scheduled – from time card">${fmtH(a.actual_hours)}h TC</span>`
    : a.planned_hours !== 8 ? `<span class="hr">${fmtH(a.planned_hours)}h</span>` : '';
  const dayTotal = S.sched ? overDayMap()[`${a.employee_id}|${a.work_date}`] : null;
  const over = dayTotal ? `<span class="over-flag" title="Scheduled ${fmtH(dayTotal)} hrs this day">⚠${fmtH(dayTotal)}</span>` : '';
  const st = a.status === 'scheduled' ? '' : a.status === 'no_show' ? 'no_show' : 'verified';
  const ap = a.approval_status || 'approved';
  const apMark = ap === 'rejected' ? '<span class="ap-mark">✕</span>' : ap === 'pending' ? '<span class="ap-tag">Pending</span>' : st === 'verified' ? '<span class="ap-mark">✓✓</span>' : '<span class="ap-mark">✓</span>';
  const apText = ap === 'pending' ? `\nPending approval – requested by ${a.requested_by_name || 'superintendent'}`
    : ap === 'rejected' ? `\nRejected${a.approved_by_name ? ' by ' + a.approved_by_name : ''}: ${a.reject_reason || ''}`
      : `\nApproved${a.approved_by_name ? ' by ' + a.approved_by_name : ''}`;
  const title = `${fullName(a)} – ${a.trade || ''} ${a.classification || ''}\n${a.job_number} ${a.project_name}\n${fmtH(a.planned_hours)} hrs${dayTotal ? ` (${fmtH(dayTotal)} hrs total this day)` : ''}${a.task ? '\n' + a.task : ''}${a.status !== 'scheduled' ? '\nVerified: ' + fmtH(a.actual_hours) + ' hrs' : ''}${apText}`;
  const clickable = canSchedule();
  return `<div class="chip ${st} ap-${ap} ${over && ap !== 'rejected' ? 'over' : ''} ${clickable ? 'can' : ''}" data-aid="${a.id}" title="${esc(title)}" style="border-left-color:${esc(a.color || '#F15A22')}">
    <span class="nm">${esc(label)}</span>${hrs}${ap !== 'rejected' ? over : ''}${apMark}</div>`;
}

function projectSub(p) {
  const budget = p.total_budget_hours ?? p.budget_hours;
  const pct = budget ? Math.round((p.hours_through_week / budget) * 100) : null;
  return `<div class="small muted">Supt: ${esc(p.superintendent_name || '—')} · PM: ${esc(p.project_manager_name || '—')}</div>
    ${pct !== null ? `<div class="small muted">${fmtH(p.hours_through_week)} / ${fmtH(budget)} budget hrs (${pct}%)</div>
      <div class="bar ${pct > 100 ? 'over' : pct > 85 ? 'near' : ''}"><span style="width:${Math.min(pct, 100)}%"></span></div>` : ''}`;
}

function projectBoard() {
  const d = S.sched; const t = d.totals; const today = todayStr();
  const projects = visibleProjects();
  const note = hiddenJobsNote();
  const byCell = {};
  for (const a of d.assignments) (byCell[`${a.project_id}|${a.work_date}`] ||= []).push(a);
  const offByDay = {};
  for (const o of d.time_off) (offByDay[o.off_date] ||= []).push(o);
  const scheduledByDay = {};
  for (const a of d.assignments) (scheduledByDay[a.work_date] ||= new Set()).add(a.employee_id);

  if (!projects.length) {
    if (S.onlyWithHours && S.boardCounts.total) return `<div class="card muted">No jobs have crew scheduled this week. <button class="link" data-act="show-all-jobs">Show all ${S.boardCounts.total} jobs</button> to start scheduling.</div>`;
    return `<div class="card muted">No active projects. ${canSchedule() ? '<a href="#/projects">Add a project</a> to start scheduling.' : ''}</div>`;
  }

  return `${note}<div class="table-wrap"><table class="board">
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
            ${canEditProject(p.id) ? `<button class="add-btn" data-add="${p.id}|${day}">+</button>` : ''}
          </td>`;
        }).join('')}
        <td class="tot"><b>${fmtH(pt.hours)}</b> h<br><span class="small muted">${pt.headcount} ppl</span></td>
      </tr>`;
    }).join('')}</tbody>
    <tfoot>
      <tr><th class="proj">Daily totals</th>${d.days.map((day) => `<td>${t.by_day[day].headcount} ppl<br>${fmtH(t.by_day[day].hours)} h</td>`).join('')}<td>${fmtH(t.hours)} h</td></tr>
      <tr><th class="proj small">Not scheduled / off</th>${d.days.map((day) => {
        const sched = scheduledByDay[day]?.size || 0; const off = (offByDay[day] || []).length;
        return `<td class="small" title="${esc((offByDay[day] || []).map((o) => `${o.first_name} ${o.last_name}: ${o.reason || 'off'}`).join('\n'))}">${Math.max(S.crew.length - sched - off, 0)} open${off ? ` · ${off} off` : ''}</td>`;
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
  const list = visibleProjects(day).map((p) => ({ p, a: d.assignments.filter((a) => a.project_id === p.id && a.work_date === day) }));
  const off = d.time_off.filter((o) => o.off_date === day);
  return `${dayTabs()}
    <div class="muted small" style="margin-bottom:8px">${dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })} · ${d.totals.by_day[day].headcount} people · ${fmtH(d.totals.by_day[day].hours)} hrs</div>
    ${hiddenJobsNote()}
    ${!list.length && S.onlyWithHours ? `<div class="card muted">No jobs have crew this day. <button class="link" data-act="show-all-jobs">Show all jobs</button></div>` : ''}
    ${list.map(({ p, a }) => `<div class="pcard">
      <div class="ph"><div><div class="proj-name"><span class="proj-swatch" style="background:${esc(p.color || '#F15A22')}"></span>${esc(p.job_number)} – ${esc(p.name)}</div>
        ${p.address ? `<div class="small"><a href="https://maps.google.com/?q=${encodeURIComponent(p.address)}" target="_blank" rel="noopener">${esc(p.address)}</a></div>` : ''}${projectSub(p)}</div>
        <div class="right nowrap"><b>${a.filter((x) => x.approval_status !== 'rejected').length}</b> ppl<br><span class="small muted">${fmtH(a.filter((x) => x.approval_status !== 'rejected').reduce((sum, x) => sum + x.planned_hours, 0))} h</span></div></div>
      <div class="pb">${a.map((x) => chip(x, [fullName(x), x.trade].filter(Boolean).join(' · '))).join('') || '<div class="small muted">Nobody scheduled</div>'}
        ${canEditProject(p.id) ? `<button class="add-btn" style="margin-top:6px;min-height:36px" data-add="${p.id}|${day}">${isAdmin() ? '+ Add crew' : '+ Request crew'}</button>` : ''}</div>
    </div>`).join('')}
    ${off.length ? `<div class="pcard"><div class="ph"><b>Off</b></div><div class="pb">${off.map((o) => `<div class="chip off">${esc(o.first_name)} ${esc(o.last_name)} <span class="hr">${esc(o.reason || '')}</span></div>`).join('')}</div></div>` : ''}`;
}

function personRows() {
  const d = S.sched;
  const ids = new Set(d.assignments.map((a) => a.employee_id));
  return S.crew.filter((e) => !S.filterTrade || e.trade === S.filterTrade).concat(
    // include inactive people who still appear on this week's schedule
    [...ids].filter((id) => !S.crew.some((e) => e.id === id)).map((id) => {
      const a = d.assignments.find((x) => x.employee_id === id);
      return { id, first_name: a.first_name, last_name: a.last_name, trade: a.trade };
    }).filter((e) => !S.filterTrade || e.trade === S.filterTrade));
}

function personBoard() {
  const d = S.sched; const today = todayStr();
  const map = {}; for (const a of d.assignments) (map[`${a.employee_id}|${a.work_date}`] ||= []).push(a);
  const off = {}; for (const o of d.time_off) off[`${o.employee_id}|${o.off_date}`] = o;
  const rows = personRows();
  if (!rows.length) return `<div class="card muted">No employees yet. <a href="#/employees">Add employees</a>.</div>`;
  return `<div class="table-wrap"><table class="board">
    <thead><tr><th class="proj">Employee</th>${d.days.map((day) => `<th class="${day === today ? 'today' : ''}">${dayLabel(day)}</th>`).join('')}<th class="tot">Hours</th></tr></thead>
    <tbody>${rows.map((e) => {
      const wk = d.totals.by_employee[e.id] || 0;
      return `<tr><th class="proj"><div class="proj-name">${esc(e.last_name)}, ${esc(e.first_name)}</div><div class="small muted">${esc([e.trade, e.classification].filter(Boolean).join(' · '))}</div></th>
        ${d.days.map((day, i) => {
          const list = map[`${e.id}|${day}`] || []; const o = off[`${e.id}|${day}`];
          const split = list.length > 1;
          const inner = list.length ? list.map((a) => chip(a, split ? a.job_number : `${a.job_number} ${a.project_name}`)).join('')
              + (canSchedule() ? `<button class="add-btn split" data-emp="${e.id}|${day}" title="Add a second job this day">+ split</button>` : '')
            : o ? `<div class="chip off" data-off="${o.id}" title="${esc(o.reason || '')}">Off${o.reason ? ' – ' + esc(o.reason) : ''}</div>`
            : `<span class="avail">available</span>`;
          const total = list.reduce((sum, a) => sum + a.planned_hours, 0);
          return `<td class="person-cell ${total > (d.totals.warn_daily_hours || 8) ? 'over-day' : ''} ${!list.length && !o && canSchedule() ? 'can' : ''} ${isWeekend(i) ? 'weekend' : ''} ${day === today ? 'today' : ''}" ${!list.length && !o ? `data-emp="${e.id}|${day}"` : ''}>${inner}</td>`;
        }).join('')}
        <td class="tot ${wk > 40 ? 'over40' : ''}">${fmtH(wk)}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function personMobile() {
  const d = S.sched; const day = d.days[S.dayIdx];
  const map = {}; for (const a of d.assignments) if (a.work_date === day) (map[a.employee_id] ||= []).push(a);
  const off = {}; for (const o of d.time_off) if (o.off_date === day) off[o.employee_id] = o;
  return `${dayTabs()}<div class="pcard"><div class="pb">${personRows().map((e) => {
    const list = map[e.id] || []; const o = off[e.id];
    const total = list.reduce((sum, a) => sum + a.planned_hours, 0);
    return `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--tint)" ${!list.length && !o ? `data-emp="${e.id}|${day}" class="person-cell ${canSchedule() ? 'can' : ''}"` : ''}>
      <div><b>${esc(fullName(e))}</b><div class="small muted">${esc(e.trade || '')}</div></div>
      <div class="right" style="max-width:60%;display:grid;gap:4px;justify-items:end;align-content:start">${list.length
        ? list.map((a) => `<span class="pill job" data-aid="${a.id}">${esc(a.job_number)} ${list.length > 1 ? `${fmtH(a.planned_hours)}h` : esc(a.project_name)}</span>`).join('')
          + (total > (d.totals.warn_daily_hours || 8) ? `<span class="over-flag">⚠ ${fmtH(total)} h</span>` : '')
        : o ? '<span class="pill off">Off</span>' : '<span class="avail">available</span>'}</div>
    </div>`;
  }).join('')}</div></div>`;
}

// All Jobs (desktop): one day, every job side by side with its crew, and the
// crew still available on the left. Drag a person onto a job to schedule (or
// request) them, between jobs to move them, or back to Available to remove.
function dispatchBoard(el) {
  const d = S.sched; const day = d.days[S.dayIdx]; const warnAt = d.totals.warn_daily_hours || 8;
  const dayAsg = d.assignments.filter((a) => a.work_date === day);
  const live = dayAsg.filter((a) => a.approval_status !== 'rejected');
  const byPerson = {}; for (const a of live) (byPerson[a.employee_id] ||= []).push(a);
  const personHours = (eid) => (byPerson[eid] || []).reduce((sum, a) => sum + a.planned_hours, 0);
  const off = new Map(d.time_off.filter((o) => o.off_date === day).map((o) => [o.employee_id, o]));
  const trades = [...new Set(S.crew.map((e) => e.trade).filter(Boolean))].sort();
  const trade = S.dispatchTrade || '';
  const pool = S.crew.filter((e) => !byPerson[e.id] && !off.has(e.id) && (!trade || e.trade === trade));
  const groups = {};
  for (const e of pool) (groups[e.trade || 'No trade'] ||= []).push(e);
  const projects = visibleProjects(day);
  const dropHours = S.dropHours || S.settings.default_hours || 8;

  const card = (a) => {
    const ap = a.approval_status || 'approved';
    const total = personHours(a.employee_id);
    const drag = ap !== 'rejected' && canEditProject(a.project_id);
    const mark = ap === 'rejected' ? '✕' : ap === 'pending' ? '' : a.status !== 'scheduled' ? '✓✓' : '✓';
    return `<div class="dcard ap-${ap}" data-aid="${a.id}" ${drag ? `draggable="true" data-drag="asg:${a.id}"` : ''}
      title="${esc(`${fullName(a)}${a.trade ? ' – ' + a.trade : ''}\n${fmtH(a.planned_hours)} hrs${ap === 'pending' ? '\nPending approval' : ap === 'rejected' ? '\nRejected: ' + (a.reject_reason || '') : ''}`)}">
      <span class="nm">${esc(fullName(a))}<span class="small muted"> ${esc(a.trade || '')}</span></span>
      <span class="hr">${fmtH(a.planned_hours)}h</span>
      ${ap !== 'rejected' && total > warnAt ? `<span class="over-flag" title="${fmtH(total)} hrs this day">⚠${fmtH(total)}</span>` : ''}
      ${ap === 'pending' ? '<span class="ap-tag">Pending</span>' : `<span class="ap-mark">${mark}</span>`}</div>`;
  };

  el.innerHTML = `
    <div class="dispatch-head">
      ${dayTabs()}
      <div class="toolbar" style="margin:0">
        <span class="small muted">${dayLabel(day, { weekday: 'long', month: 'long', day: 'numeric' })} · ${d.totals.by_day[day].headcount} on jobs · ${pool.length} available · ${off.size} off</span>
        <span class="spacer"></span>
        ${S.onlyWithHours && S.boardCounts.shown < S.boardCounts.total ? '<span class="small muted">Turn off “Only jobs with hours” to drop crew onto an empty job.</span>' : ''}
        <label class="check">Hours when dropped <input type="number" step="0.5" min="0.5" max="24" data-act="drop-hours" value="${dropHours}" style="width:70px"></label>
      </div>
    </div>
    ${hiddenJobsNote()}
    <div class="dispatch">
      <aside class="dpool" data-drop="pool">
        <div class="dpool-h"><b>Available (${pool.length})</b>
          <select data-act="dtrade" aria-label="Trade"><option value="">All trades</option>${trades.map((t) => opt(t, t, trade)).join('')}</select></div>
        ${Object.keys(groups).sort().map((g) => `<div class="dgroup">${esc(g)} <span class="muted">(${groups[g].length})</span></div>
          ${groups[g].map((e) => `<div class="dcard pool" ${canSchedule() ? `draggable="true" data-drag="emp:${e.id}" data-pick="${e.id}"` : ''} title="${esc(fullName(e))}${canSchedule() ? ' – drag onto a job, or click to choose' : ''}">
            <span class="nm">${esc(fullName(e))}</span><span class="small muted">${esc(e.classification || '')}</span></div>`).join('')}`).join('') || '<div class="small muted" style="padding:8px">Everyone is on a job or off today.</div>'}
        ${off.size ? `<div class="dgroup">Off <span class="muted">(${off.size})</span></div>${[...off.values()].map((o) => `<div class="dcard off-card"><span class="nm">${esc(o.first_name)} ${esc(o.last_name)}</span><span class="small muted">${esc(o.reason || '')}</span></div>`).join('')}` : ''}
        ${canSchedule() ? '<div class="small muted dpool-tip">Drag a job card back here to take that person off the job.</div>' : ''}
      </aside>
      <div class="djobs">${projects.map((p) => {
        const list = dayAsg.filter((a) => a.project_id === p.id);
        const liveList = list.filter((a) => a.approval_status !== 'rejected');
        const pending = list.filter((a) => a.approval_status === 'pending');
        const editable = canEditProject(p.id);
        return `<section class="djob ${editable ? '' : 'locked'}" data-drop="job:${p.id}" style="border-top-color:${esc(p.color || '#F15A22')}">
          <header><div class="djob-title">${esc(p.job_number)} <span>${esc(p.name)}</span></div>
            <div class="small muted">Supt: ${esc(p.superintendent_name || '—')} · PM: ${esc(p.project_manager_name || '—')}</div>
            <div class="djob-tot"><b>${new Set(liveList.map((a) => a.employee_id)).size}</b> ppl · <b>${fmtH(liveList.reduce((sum, a) => sum + a.planned_hours, 0))}</b> h
              ${isAdmin() && pending.length ? `<button class="ok mini-btn" data-approve-job="${p.id}">✓ Approve ${pending.length}</button>` : ''}</div></header>
          <div class="djob-body">${list.map(card).join('') || `<div class="djob-empty">${editable ? 'Drop crew here' : 'No crew'}</div>`}</div>
        </section>`;
      }).join('') || (S.onlyWithHours && S.boardCounts.total ? '<div class="card muted">No jobs have crew this day. <button class="link" data-act="show-all-jobs">Show all jobs</button></div>' : '<div class="card muted">No projects match the filters.</div>')}</div>
    </div>`;

  // ---- interactions
  $$('[data-day]', el).forEach((b) => (b.onclick = () => { S.dayIdx = Number(b.dataset.day); drawBoard(); }));
  $('[data-act=dtrade]', el).onchange = (e) => { S.dispatchTrade = e.target.value; drawBoard(); };
  $('[data-act=drop-hours]', el).onchange = (e) => { S.dropHours = Number(e.target.value) || 8; };
  $$('.dcard[data-aid]', el).forEach((c) => (c.onclick = () => canSchedule() && editAssignmentModal(d.assignments.find((a) => a.id === Number(c.dataset.aid)))));
  $$('[data-pick]', el).forEach((c) => (c.onclick = () => assignModal({ employee_ids: [Number(c.dataset.pick)], dates: [day] })));
  $$('[data-approve-job]', el).forEach((b) => (b.onclick = async () => {
    const ids = dayAsg.filter((a) => a.project_id === Number(b.dataset.approveJob) && a.approval_status === 'pending').map((a) => a.id);
    const r = await api('POST', '/assignments/approve', { ids });
    toast(r.conflicts.length ? `Approved ${r.approved}; ${r.conflicts.length} would double book` : `Approved ${r.approved}`, !!r.conflicts.length);
    renderSchedule($('#page'));
  }));

  let dragging = null;
  $$('[data-drag]', el).forEach((c) => {
    c.addEventListener('dragstart', (e) => { dragging = c.dataset.drag; e.dataTransfer.setData('text/plain', dragging); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); });
    c.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.drop-ok', el).forEach((z) => z.classList.remove('drop-ok')); });
  });
  const allowed = (zone) => {
    if (!dragging) return false;
    const [kind, id] = dragging.split(':');
    const target = zone.dataset.drop;
    if (target === 'pool') return kind === 'asg';
    const pid = Number(target.split(':')[1]);
    if (!canEditProject(pid)) return false;
    if (kind === 'asg') return d.assignments.find((a) => a.id === Number(id))?.project_id !== pid;
    return true;
  };
  $$('[data-drop]', el).forEach((zone) => {
    zone.addEventListener('dragover', (e) => { if (allowed(zone)) { e.preventDefault(); zone.classList.add('drop-ok'); } });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-ok'); });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); zone.classList.remove('drop-ok');
      if (!allowed(zone)) return;
      const [kind, id] = dragging.split(':'); dragging = null;
      const target = zone.dataset.drop;
      try {
        let r;
        if (target === 'pool') {
          await api('DELETE', `/assignments/${id}`); toast('Taken off the job');
        } else {
          const pid = Number(target.split(':')[1]);
          if (kind === 'emp') {
            r = await api('POST', '/assignments', { project_id: pid, employee_ids: [Number(id)], dates: [day], planned_hours: S.dropHours || S.settings.default_hours || 8 });
            if (r.conflicts.length) toast(r.conflicts[0].message, true);
            else toast(r.approval_status === 'pending' ? 'Requested – waiting for approval' : 'Scheduled');
          } else {
            r = await api('PUT', `/assignments/${id}`, { project_id: pid });
            toast(r.approval_status === 'pending' && !isAdmin() ? 'Moved – sent for approval' : 'Moved');
          }
          if (r?.warnings?.length) toast(`⚠ ${r.warnings[0].message}`, true);
        }
      } catch (err) { toast(err.message, true); }
      renderSchedule($('#page'));
    });
  });
}

function bindBoard(el) {
  $$('[data-day]', el).forEach((b) => (b.onclick = () => { S.dayIdx = Number(b.dataset.day); drawBoard(); }));
  if (!canSchedule()) return;
  $$('[data-add]', el).forEach((b) => (b.onclick = () => { const [pid, day] = b.dataset.add.split('|'); assignModal({ project_id: Number(pid), dates: [day] }); }));
  $$('[data-aid]', el).forEach((c) => (c.onclick = (ev) => { ev.stopPropagation(); editAssignmentModal(S.sched.assignments.find((a) => a.id === Number(c.dataset.aid))); }));
  $$('[data-emp]', el).forEach((c) => (c.onclick = (ev) => {
    ev.stopPropagation();
    const [eid, day] = c.dataset.emp.split('|');
    const split = c.classList.contains('split');
    assignModal({ employee_ids: [Number(eid)], dates: [day], splitFor: split ? S.sched.assignments.filter((a) => a.employee_id === Number(eid) && a.work_date === day) : null });
  }));
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
  const projects = myProjects();
  if (!projects.length) {
    modal({ title: 'Request crew', body: `<div class="alert">${S.user.employee_id ? 'You are not the superintendent on any active project yet.' : 'Your login is not linked to your employee record.'} Ask the workforce manager to ${S.user.employee_id ? 'set you as superintendent on your projects' : 'link your login'} so you can request crew.</div>`, footer: '<button data-close>Close</button>' });
    return;
  }
  const preDates = new Set(pre.dates || [todayStr() >= d.start && todayStr() <= d.end ? todayStr() : d.days[0]]);
  const preEmp = new Set(pre.employee_ids || []);
  const trades = [...new Set(S.crew.map((e) => e.trade).filter(Boolean))].sort();
  const skills = [...new Set(S.crew.flatMap((e) => e.skills.map((s) => s.name)))].sort();
  const warnAt = S.settings.warn_daily_hours || 8;

  // Split day: fill the rest of a normal day on a different job.
  let defHours = S.settings.default_hours || 8; let defProject = pre.project_id;
  if (pre.splitFor?.length) {
    const used = pre.splitFor.reduce((sum, a) => sum + a.planned_hours, 0);
    defHours = used >= warnAt ? 2 : warnAt - used;
    defProject = projects.find((p) => !pre.splitFor.some((a) => a.project_id === p.id))?.id;
  }
  const splitNote = pre.splitFor?.length ? `<div class="alert">${esc(fullName(pre.splitFor[0]))} is on ${esc(pre.splitFor.map((a) => `${a.job_number} (${fmtH(a.planned_hours)} h)`).join(', '))}.
    To split a normal ${fmtH(warnAt)}-hour day between two jobs, reduce the hours on that job first (click it on the board), then add the second job here.</div>` : '';

  const m = modal({
    title: pre.splitFor ? 'Split day – add another job' : isAdmin() ? 'Schedule crew' : 'Request crew',
    wide: true,
    body: `${splitNote}
      <div class="grid2">
        <label>Project<select name="project_id">${projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, defProject)).join('')}</select></label>
        <label>Total hours scheduled per day<input name="planned_hours" type="number" step="0.5" min="0" max="24" value="${defHours}"></label>
      </div>
      <div><div class="small muted" style="margin-bottom:4px">Days <button class="link" data-days="wk">Mon–Fri</button><button class="link" data-days="none">clear</button></div>
        <div class="days-pick">${d.days.map((day, i) => `<label><input type="checkbox" name="dates" data-multi="1" value="${day}" ${preDates.has(day) ? 'checked' : ''}>${DOW[i]} ${day.slice(5).replace('-', '/')}</label>`).join('')}</div></div>
      <label>Task / scope (optional)<input name="task" maxlength="500" placeholder="e.g. Level 2 framing, pour prep"></label>
      <div class="toolbar" style="margin:0">
        <input type="search" data-f="q" placeholder="Search name…" style="flex:1;min-width:140px">
        <select data-f="trade"><option value="">All trades</option>${trades.map((x) => opt(x, x)).join('')}</select>
        <select data-f="skill"><option value="">Any skill</option>${skills.map((x) => opt(x, x)).join('')}</select>
        <label class="check" title="Uncheck to show people already on another job, for a split day"><input type="checkbox" data-f="availOnly" ${pre.splitFor ? '' : 'checked'}> Open only</label>
      </div>
      <div class="emp-pick" id="emp-pick"></div>
      <div class="small muted" id="pick-count"></div>`,
    footer: `${isAdmin() ? '' : '<span class="small muted" style="margin-right:auto">Requests go to the workforce manager for approval.</span>'}<button data-close>Cancel</button><button class="primary" data-act="save">${isAdmin() ? 'Schedule' : 'Send request'}</button>`,
  });

  // Per person per day: jobs already booked (a split day is allowed) or time off.
  const booked = {}; const offMap = {};
  for (const a of d.assignments) ((booked[a.employee_id] ||= {})[a.work_date] ||= []).push(a);
  for (const o of d.time_off) (offMap[o.employee_id] ||= {})[o.off_date] = true;

  const drawList = () => {
    const f = Object.fromEntries($$('[data-f]', m.el).map((x) => [x.dataset.f, x.type === 'checkbox' ? x.checked : x.value.toLowerCase()]));
    const dates = $$('[name=dates]:checked', m.el).map((x) => x.value);
    const checked = new Set($$('#emp-pick input:checked', m.el).map((x) => Number(x.value)));
    for (const id of preEmp) checked.add(id);
    preEmp.clear();
    const hrs = Number($('[name=planned_hours]', m.el).value) || 0;
    const rows = S.crew.filter((e) =>
      (!f.q || fullName(e).toLowerCase().includes(f.q)) &&
      (!f.trade || (e.trade || '').toLowerCase() === f.trade) &&
      (!f.skill || e.skills.some((s) => s.name.toLowerCase() === f.skill)));
    const pid = Number($('[name=project_id]', m.el).value);
    const html = rows.map((e) => {
      const dow = (day) => DOW[d.days.indexOf(day)];
      // Blocked: off that day, or already on this same job that day.
      const blocked = dates.filter((day) => offMap[e.id]?.[day] || (booked[e.id]?.[day] || []).some((a) => a.project_id === pid));
      const elsewhere = dates.filter((day) => !blocked.includes(day) && booked[e.id]?.[day]);
      const allBlocked = dates.length > 0 && blocked.length === dates.length;
      const anyBooked = dates.length > 0 && dates.every((day) => blocked.includes(day) || elsewhere.includes(day));
      if (f.availOnly && anyBooked && !checked.has(e.id)) return '';
      const wk = d.totals.by_employee[e.id] || 0;
      const dayTotal = (day) => (booked[e.id]?.[day] || []).reduce((sum, a) => sum + a.planned_hours, 0) + hrs;
      const tags = [
        ...blocked.map((day) => `<span class="pill bad">${dow(day)}: ${offMap[e.id]?.[day] ? 'OFF' : 'already on this job'}</span>`),
        ...elsewhere.map((day) => `<span class="pill warn" title="Can be added as a split day">${dow(day)}: ${esc(booked[e.id][day].map((a) => `${a.job_number} ${fmtH(a.planned_hours)}h`).join(', '))}${dayTotal(day) > warnAt ? ` → ⚠ ${fmtH(dayTotal(day))} h` : ''}</span>`),
      ].join(' ');
      return `<label class="${allBlocked ? 'busy' : ''}"><input type="checkbox" value="${e.id}" ${checked.has(e.id) && !allBlocked ? 'checked' : ''} ${allBlocked ? 'disabled' : ''}>
        <span><b>${esc(fullName(e))}</b><br><span class="small muted">${esc([e.trade, e.classification, e.union_local && 'Local ' + e.union_local].filter(Boolean).join(' · '))}</span></span>
        <span class="meta">${tags ? tags + '<br>' : ''}${fmtH(wk)} h this wk</span></label>`;
    }).join('');
    $('#emp-pick', m.el).innerHTML = html || `<div class="muted" style="padding:12px">${f.availOnly && dates.length ? 'Everyone matching is already booked or off on the selected day(s). Uncheck “Open only” to add someone for a split day.' : 'No matching employees.'}</div>`;
    const n = $$('#emp-pick input:checked', m.el).length;
    $('#pick-count', m.el).textContent = `${n} selected × ${dates.length} day(s)`;
    $$('#emp-pick input', m.el).forEach((x) => (x.onchange = () => { $('#pick-count', m.el).textContent = `${$$('#emp-pick input:checked', m.el).length} selected × ${dates.length} day(s)`; }));
  };
  $$('[data-f]', m.el).forEach((x) => (x.oninput = drawList));
  $('[name=project_id]', m.el).onchange = drawList;
  $('[name=planned_hours]', m.el).oninput = drawList;
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
      project_id: Number(f.project_id), dates: f.dates, planned_hours: f.planned_hours, task: f.task,
      employee_ids: $$('#emp-pick input:checked', m.el).map((x) => Number(x.value)),
    };
    try {
      const r = await api('POST', '/assignments', body);
      if (r.conflicts.length || r.warnings?.length) {
        errorBox(m.el, '');
        if (r.conflicts.length) errorBox(m.el, `Scheduled ${r.created.length}. These were skipped to prevent double booking:`, r.conflicts.map((c) => c.message));
        if (r.warnings?.length) showWarnings(m.el, r.warnings);
        $('[data-act=save]', m.el).textContent = 'Schedule more';
        renderSchedule($('#page'));
      } else { m.close(); toast(r.approval_status === 'pending' ? `Requested ${r.created.length} crew-day(s) – waiting for approval` : `Scheduled ${r.created.length} crew-day(s)`); renderSchedule($('#page')); }
    } catch (e) { errorBox(m.el, e.message, e.data?.conflicts?.map((c) => c.message)); }
  };
}

// Over-8-hour days are allowed but called out so they're a deliberate choice.
function showWarnings(el, warnings) {
  let box = $('.form-warn', el);
  if (!box) { box = document.createElement('div'); box.className = 'form-warn'; $('.mb', el).prepend(box); }
  box.innerHTML = `<div class="alert warn-box"><b>⚠ Scheduled, but over ${fmtH(S.settings.warn_daily_hours || 8)} hours in a day:</b><ul>${warnings.map((w) => `<li>${esc(w.message)}</li>`).join('')}</ul></div>`;
}

function editAssignmentModal(a) {
  if (!a) return;
  const ap = a.approval_status || 'approved';
  const editable = canEditProject(a.project_id);
  const statusLine = ap === 'pending' ? `<div class="alert"><b>Pending approval</b> – requested by ${esc(a.requested_by_name || 'superintendent')}</div>`
    : ap === 'rejected' ? `<div class="alert bad"><b>Rejected</b>${a.approved_by_name ? ` by ${esc(a.approved_by_name)}` : ''}: ${esc(a.reject_reason || '')}</div>`
      : `<div class="small"><span class="pill ok">✓ Approved</span>${a.approved_by_name ? ` <span class="muted">by ${esc(a.approved_by_name)}</span>` : ''}</div>`;
  const dis = editable ? '' : 'disabled';
  const projects = isAdmin() ? S.projects : S.projects.filter((p) => canEditProject(p.id) || p.id === a.project_id);
  const m = modal({
    title: `${fullName(a)} – ${dayLabel(a.work_date, { weekday: 'long', month: 'short', day: 'numeric' })}`,
    body: `${statusLine}
      <div class="small muted">${esc([a.trade, a.classification].filter(Boolean).join(' · '))}${a.status !== 'scheduled' ? ` · <span class="pill ok">Hours verified ${fmtH(a.actual_hours)} h</span>` : ''}</div>
      <label>Project<select name="project_id" ${dis}>${projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, a.project_id)).join('')}</select></label>
      <div class="grid2">
        <label>Date<input type="date" name="work_date" value="${a.work_date}" ${dis}></label>
        <label>Total hours<input type="number" step="0.5" min="0" max="24" name="planned_hours" value="${a.planned_hours}" ${dis}></label>
      </div>
      <label>Task / scope<input name="task" value="${esc(a.task || '')}" ${dis}></label>
      ${!editable ? '<div class="small muted">Only the workforce manager or this job\'s superintendent can change this.</div>' : ''}
      ${!isAdmin() && editable && ap === 'approved' ? '<div class="small muted">Changing an approved entry sends it back to the workforce manager for approval.</div>' : ''}
      ${!isAdmin() && editable && ap === 'rejected' ? '<div class="small muted">Change the hours, day or job and save to send it again for approval.</div>' : ''}
      ${isAdmin() && ap !== 'approved' ? `<label>Reason (needed to reject)<input name="reason" maxlength="300" placeholder="e.g. Needed on 24-115 pour" value=""></label>` : ''}`,
    footer: `${editable ? '<button class="danger" data-act="del">Remove</button>' : ''}<span class="spacer"></span><button data-close>${editable ? 'Cancel' : 'Close'}</button>
      ${isAdmin() && ap === 'pending' ? '<button class="danger" data-act="reject">✕ Reject</button>' : ''}
      ${isAdmin() && ap !== 'approved' ? '<button class="ok" data-act="approve">✓ Approve</button>' : ''}
      ${isAdmin() && ap === 'approved' && a.status === 'scheduled' ? '<button data-act="reject-open">Reject…</button>' : ''}
      ${editable ? `<button class="primary" data-act="save">${!isAdmin() && ap === 'rejected' ? 'Resubmit' : 'Save'}</button>` : ''}`,
  });
  const done = (msg) => { m.close(); toast(msg); renderSchedule($('#page')); };
  const save = $('[data-act=save]', m.el);
  if (save) save.onclick = async () => {
    try {
      const f = formData(m.el); delete f.reason;
      const r = await api('PUT', `/assignments/${a.id}`, f);
      renderSchedule($('#page'));
      if (r.warnings?.length) { errorBox(m.el, ''); showWarnings(m.el, r.warnings); save.textContent = 'Save again'; } else { m.close(); toast(r.approval_status === 'pending' && !isAdmin() ? 'Saved – sent for approval' : 'Updated'); }
    } catch (e) { errorBox(m.el, e.message); }
  };
  const del = $('[data-act=del]', m.el);
  if (del) del.onclick = async () => {
    if (!confirm(`Remove ${fullName(a)} from ${a.job_number} on ${a.work_date}?`)) return;
    try { await api('DELETE', `/assignments/${a.id}`); done('Removed'); } catch (e) { errorBox(m.el, e.message); }
  };
  const approve = $('[data-act=approve]', m.el);
  if (approve) approve.onclick = async () => {
    try {
      const r = await api('POST', '/assignments/approve', { ids: [a.id] });
      if (r.conflicts.length) return errorBox(m.el, 'Could not approve:', r.conflicts);
      done('Approved');
    } catch (e) { errorBox(m.el, e.message); }
  };
  const reject = $('[data-act=reject]', m.el);
  if (reject) reject.onclick = async () => {
    try { await api('POST', '/assignments/reject', { ids: [a.id], reason: $('[name=reason]', m.el).value }); done('Rejected – the superintendent will see the reason'); } catch (e) { errorBox(m.el, e.message); }
  };
  const rejectOpen = $('[data-act=reject-open]', m.el);
  if (rejectOpen) rejectOpen.onclick = () => { m.close(); rejectModal([a]); };
}

// Ask for the rejection reason, then reject one or more entries.
function rejectModal(list, after) {
  const m = modal({
    title: list.length > 1 ? `Reject ${list.length} entries` : `Reject ${fullName(list[0])}`,
    body: `<div class="small muted">${list.slice(0, 8).map((a) => `${esc(fullName(a))} · ${esc(a.job_number)} · ${esc(dayLabel(a.work_date))}`).join('<br>')}${list.length > 8 ? `<br>and ${list.length - 8} more` : ''}</div>
      <label>Reason for rejection *<textarea name="reason" maxlength="300" placeholder="e.g. Kyle is needed on 24-115 for the deck pour – use Sam instead"></textarea></label>
      <div class="small muted">The superintendent sees this reason on their schedule.</div>`,
    footer: '<button data-close>Cancel</button><button class="danger" data-act="go">✕ Reject</button>',
  });
  $('[data-act=go]', m.el).onclick = async () => {
    try {
      const r = await api('POST', '/assignments/reject', { ids: list.map((a) => a.id), reason: $('[name=reason]', m.el).value });
      m.close(); toast(`Rejected ${r.rejected}`); (after || (() => renderSchedule($('#page'))))();
    } catch (e) { errorBox(m.el, e.message); }
  };
}

// Manager: approval queue. Superintendent: their pending and rejected requests.
async function requestsModal() {
  const r = await api('GET', '/requests');
  const admin = isAdmin();
  const row = (a, withBox) => `<tr data-id="${a.id}">
    ${withBox ? `<td><input type="checkbox" class="rq" value="${a.id}" aria-label="Select"></td>` : ''}
    <td class="nowrap">${esc(dayLabel(a.work_date))}</td><td>${esc(a.job_number)}<div class="small muted">${esc(a.project_name)}</div></td>
    <td>${esc(fullName(a))}<div class="small muted">${esc(a.trade || '')}</div></td><td class="right">${fmtH(a.planned_hours)} h</td>
    <td class="small">${esc(a.requested_by_name || '')}</td>
    ${a.approval_status === 'rejected' ? `<td class="small"><b>Rejected:</b> ${esc(a.reject_reason || '')}${a.approved_by_name ? `<div class="muted">by ${esc(a.approved_by_name)}</div>` : ''}</td>` : ''}</tr>`;
  const m = modal({
    title: admin ? 'Crew requests to approve' : 'My crew requests',
    wide: true,
    body: `<h2 style="margin-top:0">Pending (${r.pending.length})</h2>
      ${r.pending.length ? `<div class="table-wrap" style="max-height:340px"><table class="list"><thead><tr>${admin ? '<th><input type="checkbox" class="rq-all" aria-label="Select all"></th>' : ''}<th>Day</th><th>Job</th><th>Employee</th><th class="right">Hours</th><th>Requested by</th></tr></thead>
        <tbody>${r.pending.map((a) => row(a, admin)).join('')}</tbody></table></div>` : '<div class="muted">Nothing waiting for approval.</div>'}
      ${r.rejected.length ? `<h2>Rejected, last 2 weeks (${r.rejected.length})</h2><div class="table-wrap" style="max-height:240px"><table class="list"><thead><tr>${admin ? '<th></th>' : ''}<th>Day</th><th>Job</th><th>Employee</th><th class="right">Hours</th><th>Requested by</th><th>Reason</th></tr></thead>
        <tbody>${r.rejected.map((a) => row(a, admin)).join('')}</tbody></table></div>
        ${!admin ? '<div class="small muted">To ask again, open the entry on the schedule, adjust it and click Resubmit, or request someone else.</div>' : ''}` : ''}`,
    footer: admin ? `<span class="small muted" id="rq-count" style="margin-right:auto">0 selected</span><button data-close>Close</button>
      <button class="danger" data-act="reject" disabled>✕ Reject selected…</button><button class="ok" data-act="approve" disabled>✓ Approve selected</button>
      ${r.pending.length ? `<button class="primary" data-act="all">✓ Approve all ${r.pending.length}</button>` : ''}` : '<button data-close>Close</button>',
  });
  if (!admin) return;
  const all = [...r.pending, ...r.rejected];
  const picked = () => $$('.rq:checked', m.el).map((x) => all.find((a) => a.id === Number(x.value)));
  const sync = () => {
    const n = picked().length;
    $('#rq-count', m.el).textContent = `${n} selected`;
    $('[data-act=approve]', m.el).disabled = !n;
    $('[data-act=reject]', m.el).disabled = !n || picked().some((a) => a.approval_status === 'rejected');
  };
  $$('.rq', m.el).forEach((x) => (x.onchange = sync));
  const allBox = $('.rq-all', m.el);
  if (allBox) allBox.onchange = () => { $$('tbody .rq', m.el).slice(0, r.pending.length).forEach((x) => (x.checked = allBox.checked)); sync(); };
  const approve = async (ids) => {
    try {
      const res = await api('POST', '/assignments/approve', { ids });
      m.close(); renderSchedule($('#page'));
      if (res.conflicts.length || res.warnings.length) {
        const w = modal({ title: `Approved ${res.approved}`, body: '', footer: '<button data-close>OK</button>' });
        if (res.conflicts.length) errorBox(w.el, 'Not approved (would double book):', res.conflicts);
        if (res.warnings.length) showWarnings(w.el, res.warnings);
      } else toast(`Approved ${res.approved}`);
    } catch (e) { errorBox(m.el, e.message); }
  };
  $('[data-act=approve]', m.el).onclick = () => approve(picked().map((a) => a.id));
  const allBtn = $('[data-act=all]', m.el); if (allBtn) allBtn.onclick = () => approve(r.pending.map((a) => a.id));
  $('[data-act=reject]', m.el).onclick = () => { const list = picked(); m.close(); rejectModal(list); };
}

function copyWeekModal() {
  const from = addDays(S.week, -7);
  const m = modal({
    title: 'Copy a week forward',
    body: `<p class="muted" style="margin:0">Copies every assignment from the source week into the week you're viewing. Anyone already booked or off is skipped – nobody gets double booked.</p>
      <div class="grid2"><label>Copy from week of<input type="date" name="from" value="${from}"></label>
      <label>Into week of<input type="date" name="to" value="${S.week}"></label></div>
      <label>Project<select name="project_id">${isAdmin() ? '<option value="">All projects</option>' : ''}${myProjects().map((p) => opt(p.id, `${p.job_number} – ${p.name}`)).join('')}</select></label>
      ${isAdmin() ? '' : '<div class="small muted">Copied days go to the workforce manager for approval.</div>'}`,
    footer: `<button data-close>Cancel</button><button class="primary" data-act="go">Copy</button>`,
  });
  $('[data-act=go]', m.el).onclick = async () => {
    try {
      const r = await api('POST', '/assignments/copy-week', formData(m.el));
      if (r.conflicts.length) errorBox(m.el, `Copied ${r.created.length}. Skipped:`, r.conflicts.map((c) => c.message));
      if (r.warnings?.length) showWarnings(m.el, r.warnings);
      if (!r.conflicts.length && !r.warnings?.length) { m.close(); toast(`Copied ${r.created.length} assignments`); }
      S.week = weekStart(formData(m.el).to); renderSchedule($('#page'));
    } catch (e) { errorBox(m.el, e.message); }
  };
}

function timeOffModal(pre) {
  const d = S.sched;
  const first = d.days.includes(todayStr()) ? todayStr() : d.days[0];
  const m = modal({
    title: 'Mark time off',
    body: `<label>Employee<select name="employee_id">${S.crew.map((e) => opt(e.id, `${e.last_name}, ${e.first_name}`, pre.employee_id)).join('')}</select></label>
      <div class="grid2"><label>From<input type="date" name="from" value="${first}"></label><label>To<input type="date" name="to" value="${first}"></label></div>
      <div class="grid2">
        <label>Reason<select name="reason">${['Vacation', 'Sick / medical', 'Personal', 'Family leave', 'Jury duty', 'Union business', 'Training', 'Bereavement', 'Laid off', 'Other'].map((x) => opt(x, x)).join('')}</select></label>
        <label>Note (optional)<input name="note" maxlength="150"></label>
      </div>
      <label class="check"><input type="checkbox" name="weekdays_only" checked> Weekdays only</label>
      <div class="small muted">Any future dates work – e.g. three weeks next spring. It also appears on the employee's record.</div>`,
    footer: `<button data-close>Cancel</button><button class="primary" data-act="go">Save</button>`,
  });
  $('[data-act=go]', m.el).onclick = async () => {
    const f = formData(m.el);
    const body = { employee_id: f.employee_id, from: f.from, to: f.to, weekdays_only: f.weekdays_only, reason: [f.reason, f.note.trim()].filter(Boolean).join(' – ') };
    try {
      const r = await api('POST', '/time-off', body);
      if (r.conflicts.length) errorBox(m.el, `Saved ${r.added} day(s). Not saved – already scheduled:`, r.conflicts);
      else { m.close(); toast(`Time off saved (${r.added} day${r.added === 1 ? '' : 's'})`); }
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
        <div class="right nowrap"><b>${fmtH(a.planned_hours)} hrs</b></div></div>
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
// Verify Hours: the payroll week (e.g. Wed–Tue). Import the weekly time card
// export (Procore), compare it with the schedule, then adjust any number.
const RECON = {
  matched: ['Matches schedule', 'ok'], variance: ['Differs from schedule', 'warn'], unscheduled: ['Not scheduled – from time card', 'bad'],
  no_timecard: ['No time card', 'warn'], not_imported: ['', ''],
};
async function renderVerify(page) {
  if (!S.verifyWeek) S.verifyWeek = addDays(todayStr(), -7); // last payroll week by default
  const [r] = await Promise.all([api('GET', `/verification?start=${S.verifyWeek}&project_id=${S.verifyProject}`), S.projects ? null : loadLookups()]);
  S.verifyWeek = r.start;
  const s = r.summary;
  const today = todayStr();
  const imported = r.imports.length > 0;
  const filter = S.verifyFilter || 'all';
  const shown = r.rows.filter((x) => filter === 'all' || x.recon === filter);
  const pastPending = r.rows.filter((x) => x.status === 'scheduled' && x.work_date <= today);
  const byDay = {};
  for (const x of shown) (byDay[x.work_date] ||= []).push(x);
  const periodLabel = `${dayLabel(r.start, { weekday: 'short', month: 'short', day: 'numeric' })} – ${dayLabel(r.end, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`;
  const chip = (key, label, n) => `<button class="${filter === key ? 'on' : ''}" data-filter="${key}">${label}${n !== undefined ? ` (${n})` : ''}</button>`;
  const variance = (x) => {
    if (x.status === 'scheduled') return '';
    const d = (x.status === 'no_show' ? 0 : x.actual_hours ?? 0) - x.planned_hours;
    return d === 0 ? '<span class="muted">0</span>' : `<b class="${d > 0 ? 'var-up' : 'var-down'}">${d > 0 ? '+' : ''}${fmtH(d)}</b>`;
  };

  page.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Verify Hours</h1><span class="spacer"></span>
      <button data-act="prev" aria-label="Previous payroll week">‹</button><strong>Payroll week ${periodLabel}</strong><button data-act="next" aria-label="Next payroll week">›</button></div>
    <div class="toolbar">
      ${isAdmin() ? '<button class="primary" data-act="import-tc">Import Procore time cards…</button>' : ''}
      <select data-act="proj"><option value="">All projects</option>${S.projects.map((p) => opt(p.id, `${p.job_number} – ${p.name}`, S.verifyProject)).join('')}</select>
      <span class="spacer"></span>
      ${pastPending.length ? `<button class="ok" data-act="all">✓ Verify ${pastPending.length} remaining as scheduled</button>` : ''}
    </div>
    <div class="tc-status small">${imported
      ? r.imports.map((i) => `Time cards imported ${esc(i.imported_at.slice(0, 10))}${i.imported_by_name ? ` by ${esc(i.imported_by_name)}` : ''}: <b>${esc(i.filename || 'file')}</b> – ${i.line_count} lines, ${fmtH(i.total_hours)} h, ${esc(i.period_start)} to ${esc(i.period_end)}`).join('<br>')
      : `No time cards imported for this payroll week yet.${isAdmin() ? ' Export the Procore time card report and click <b>Import Procore time cards</b>.' : ''}`}</div>
    <div class="stats">
      <div class="stat"><div class="v">${fmtH(s.planned)}</div><div class="l">Scheduled hours</div></div>
      <div class="stat"><div class="v">${imported ? fmtH(s.timecard) : '—'}</div><div class="l">Time card hours</div></div>
      <div class="stat"><div class="v">${fmtH(s.actual)}</div><div class="l">Verified actual hours</div></div>
      <div class="stat ${s.variance < 0 ? 'bad' : s.variance > 0 ? 'warn' : 'ok'}"><div class="v">${s.variance > 0 ? '+' : ''}${fmtH(s.variance)}</div><div class="l">Actual vs scheduled</div></div>
      <div class="stat ${pastPending.length ? 'warn' : 'ok'}"><div class="v">${s.verified_count} / ${r.rows.length}</div><div class="l">Verified</div></div>
      <div class="stat ${s.no_show_count ? 'bad' : ''}"><div class="v">${s.no_show_count}</div><div class="l">No-shows</div></div>
    </div>
    ${imported ? `<div class="seg recon-filter">${chip('all', 'All', r.rows.length)}${chip('matched', 'Matches', s.matched)}${chip('variance', 'Differs', s.variances)}${chip('unscheduled', 'Not scheduled', s.unscheduled)}${chip('no_timecard', 'No time card', s.no_timecard)}</div>` : ''}
    ${shown.length ? Object.entries(byDay).map(([day, rows]) => `
      <h2>${dayLabel(day, { weekday: 'long', month: 'short', day: 'numeric' })} <span class="muted small">${rows.length} entries · ${fmtH(rows.reduce((a, x) => a + x.planned_hours, 0))} h scheduled${imported ? ` · ${fmtH(rows.reduce((a, x) => a + (x.timecard_hours ?? 0), 0))} h on time cards` : ''}</span></h2>
      <div class="table-wrap"><table class="list verify">
        <thead><tr><th>Project</th><th>Employee</th><th class="right">Scheduled</th>${imported ? '<th class="right">Time card</th>' : ''}<th style="width:100px">Actual</th><th class="right">+/−</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows.map((x) => `<tr data-id="${x.id}" class="recon-${x.recon}">
          <td>${esc(x.job_number)}<div class="small muted">${esc(x.project_name)}</div></td>
          <td>${esc(fullName(x))}<div class="small muted">${esc(x.trade || '')}</div></td>
          <td class="right">${x.source === 'timecard' ? '<span class="muted">—</span>' : fmtH(x.planned_hours)}</td>
          ${imported ? `<td class="right">${x.timecard_hours === null ? '<span class="muted">—</span>' : `<b>${fmtH(x.timecard_hours)}</b>`}
            ${x.timecard_lines.length > 1 || (x.timecard_lines[0] && (x.timecard_lines[0].cost_code || x.timecard_lines[0].description)) ? `<div class="tc-lines">${x.timecard_lines.map((l) => `<div>${fmtH(l.hours)} h ${esc(l.cost_code || '')} ${esc(l.cost_code_name || '')}${l.description ? ` – <i>${esc(l.description)}</i>` : ''}</div>`).join('')}</div>` : ''}</td>` : ''}
          <td><input type="number" step="0.25" min="0" max="24" value="${x.status === 'scheduled' ? x.planned_hours : x.actual_hours ?? 0}" data-actual aria-label="Actual hours"></td>
          <td class="right">${variance(x)}</td>
          <td>${x.recon && RECON[x.recon][0] ? `<span class="pill ${RECON[x.recon][1]}">${RECON[x.recon][0]}</span>` : ''}
            ${x.source === 'timecard' ? '' : x.status === 'scheduled' ? `<span class="pill ${day <= today ? 'warn' : ''}">${day <= today ? 'Pending' : 'Upcoming'}</span>`
              : x.status === 'no_show' ? '<span class="pill bad">No-show</span>'
              : `<span class="pill job">${x.status === 'adjusted' ? 'Adjusted' : 'Verified'}</span>`}
            ${x.verify_note && !/^(From time card|Not scheduled – from time card)$/.test(x.verify_note) ? `<div class="small">${esc(x.verify_note)}</div>` : ''}
            ${x.verified_by_name ? `<div class="small muted">${esc(x.verified_by_name)}</div>` : ''}</td>
          <td class="nowrap"><button class="ok" data-v="verified" title="Save the actual hours">✓</button>
            ${x.source === 'timecard' ? '<button class="danger" data-v="remove" title="Remove this time card entry">✕</button>' : '<button class="danger" data-v="no_show" title="No-show">✗</button>'}
            ${x.status !== 'scheduled' && x.source !== 'timecard' ? '<button class="link" data-v="scheduled" title="Clear the verification">undo</button>' : ''}</td>
        </tr>`).join('')}</tbody>
      </table></div>`).join('') : `<div class="card muted">${filter === 'all' ? 'Nothing scheduled or on time cards this payroll week.' : 'Nothing in this group.'}</div>`}
    ${r.unmatched.length ? `<h2>Time card lines that didn't match (${r.unmatched.length})</h2>
      <div class="small muted" style="margin-bottom:6px">These people or jobs aren't in the app yet, so their hours aren't counted. Add them, then click Re-match.</div>
      <div class="table-wrap"><table class="list"><thead><tr><th>Date</th><th>Employee</th><th>Job</th><th class="right">Hours</th><th>Cost code</th><th>Why</th><th></th></tr></thead>
      <tbody>${r.unmatched.map((u) => `<tr><td class="nowrap">${esc(u.work_date)}</td><td>${esc(u.employee_name || '')} <span class="muted">#${esc(u.employee_no || '?')}</span></td>
        <td>${esc(u.job_number || '')} <span class="small muted">${esc(u.project_name || '')}</span></td><td class="right">${fmtH(u.hours)}</td>
        <td class="small">${esc([u.cost_code, u.cost_code_name].filter(Boolean).join(' '))}</td><td class="small">${esc(u.reason)}</td>
        <td class="nowrap">${isAdmin() ? `${!u.employee_id ? `<button class="link" data-add-emp="${u.id}">Add employee</button>` : ''}${!u.project_id ? `<button class="link" data-add-job="${u.id}">Add job</button>` : ''}` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${isAdmin() ? '<div class="toolbar" style="margin-top:8px"><button data-act="rematch">Re-match time cards</button></div>' : ''}` : ''}`;

  const go = (d) => { S.verifyWeek = d; renderVerify(page); };
  $('[data-act=prev]', page).onclick = () => go(addDays(r.start, -7));
  $('[data-act=next]', page).onclick = () => go(addDays(r.start, 7));
  $('[data-act=proj]', page).onchange = (e) => { S.verifyProject = e.target.value; renderVerify(page); };
  $$('[data-filter]', page).forEach((b) => (b.onclick = () => { S.verifyFilter = b.dataset.filter; renderVerify(page); }));
  const imp = $('[data-act=import-tc]', page); if (imp) imp.onclick = () => importTimecardsModal(page);
  const all = $('[data-act=all]', page);
  if (all) all.onclick = async () => {
    if (!confirm(`Confirm ${pastPending.length} entries worked as scheduled?`)) return;
    const res = await api('POST', '/verification/bulk', { ids: pastPending.map((x) => x.id) });
    toast(`Verified ${res.verified}`); renderVerify(page);
  };
  $$('tr[data-id] [data-v]', page).forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr'); const row = r.rows.find((x) => x.id === Number(tr.dataset.id));
    if (b.dataset.v === 'no_show') return noShowModal(row, () => renderVerify(page));
    try {
      if (b.dataset.v === 'remove') {
        if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'remove?'; return; }
        await api('DELETE', `/assignments/${row.id}`); toast('Removed'); return renderVerify(page);
      }
      await api('POST', `/assignments/${row.id}/verify`, { status: b.dataset.v, actual_hours: $('[data-actual]', tr).value });
      renderVerify(page);
    } catch (e) { toast(e.message, true); }
  }));
  const rematch = async () => {
    const res = await api('POST', '/timecards/rematch', { from: r.start, to: r.end });
    toast(`Linked ${res.linked} line${res.linked === 1 ? '' : 's'}${res.still_unmatched ? `; ${res.still_unmatched} still unmatched` : ''}`);
    renderVerify(page);
  };
  const rm = $('[data-act=rematch]', page); if (rm) rm.onclick = rematch;
  $$('[data-add-emp]', page).forEach((b) => (b.onclick = () => {
    const u = r.unmatched.find((x) => x.id === Number(b.dataset.addEmp));
    const parts = String(u.employee_name || '').trim().split(/\s+/);
    quickAddModal('Add employee from time card', [
      ['first_name', 'First name', parts.slice(0, -1).join(' ')], ['last_name', 'Last name', parts.slice(-1)[0] || ''],
      ['employee_no', 'Employee # (Procore Employee ID)', u.employee_no || ''], ['trade', 'Union trade', ''], ['classification', 'Classification', ''],
    ], (f) => api('POST', '/employees', f), rematch);
  }));
  $$('[data-add-job]', page).forEach((b) => (b.onclick = () => {
    const u = r.unmatched.find((x) => x.id === Number(b.dataset.addJob));
    quickAddModal('Add job from time card', [['job_number', 'Job number', u.job_number || ''], ['name', 'Project name', u.project_name || '']],
      (f) => api('POST', '/projects', { ...f, status: 'active' }), async () => { await loadLookups(); await rematch(); });
  }));
}

// Small form used to add a missing employee or job straight from the time card review.
function quickAddModal(title, fields, save, after) {
  const m = modal({
    title,
    body: `<div class="grid2">${fields.map(([name, label, value]) => `<label>${esc(label)}<input name="${name}" value="${esc(value)}"></label>`).join('')}</div>`,
    footer: '<button data-close>Cancel</button><button class="primary" data-act="go">Add and re-match</button>',
  });
  $('[data-act=go]', m.el).onclick = async () => {
    try { await save(formData(m.el)); m.close(); await after(); } catch (e) { errorBox(m.el, e.message); }
  };
}

// Import the weekly Procore time card CSV: preview against the schedule, then import.
function importTimecardsModal(page) {
  let rows = []; let filename = '';
  const m = modal({
    title: 'Import Procore time cards',
    wide: true,
    body: `<div class="small muted">In Procore, export the time card report for the payroll week as CSV and choose it here. Lines are matched by
        <b>Employee ID</b> (employee #) and <b>Project Number</b> (job number). Hours for the same person, day and job are added together across cost codes.
        Importing the same dates again replaces those time card lines. Hand-entered changes on those days are replaced by the new time card totals.</div>
      <label>Time card CSV<input type="file" accept=".csv,text/csv" data-act="file"></label>
      <div id="tc-out"></div>`,
    footer: '<button data-close>Cancel</button><button class="primary" data-act="go" disabled>Import</button>',
  });
  const out = $('#tc-out', m.el); const go = $('[data-act=go]', m.el);
  $('[data-act=file]', m.el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    filename = f.name; errorBox(m.el, '');
    rows = parseCsv(await f.text());
    if (!rows.length) { out.innerHTML = ''; go.disabled = true; return errorBox(m.el, 'That file has no rows under the heading row.'); }
    try {
      const { preview: p } = await api('POST', '/timecards/import', { rows, filename });
      out.innerHTML = `<div class="small" style="margin:8px 0">Dates <b>${esc(p.period.from)}</b> to <b>${esc(p.period.to)}</b> · ${p.lines} lines · ${p.people} people · <b>${fmtH(p.total_hours)} h</b></div>
        <div class="stats">
          <div class="stat ok"><div class="v">${p.matched}</div><div class="l">Match the schedule</div></div>
          <div class="stat ${p.variances ? 'warn' : ''}"><div class="v">${p.variances}</div><div class="l">Differ from schedule</div></div>
          <div class="stat ${p.unscheduled ? 'warn' : ''}"><div class="v">${p.unscheduled}</div><div class="l">Worked, not scheduled</div></div>
          <div class="stat ${p.no_timecard ? 'warn' : ''}"><div class="v">${p.no_timecard}</div><div class="l">Scheduled, no time card</div></div>
          <div class="stat ${p.unmatched_lines ? 'bad' : ''}"><div class="v">${p.unmatched_lines}</div><div class="l">Lines not matched</div></div>
        </div>
        ${p.replaces ? `<div class="alert warn-box">${p.replaces} time card lines already imported for these dates will be replaced.</div>` : ''}
        ${p.unmatched.length ? `<div class="alert">Not in the app yet (these lines are kept and can be linked later):<ul>${p.unmatched.map((u) => `<li>${[u.employee && `Employee ${esc(u.employee)}`, u.job && `Job ${esc(u.job)}`].filter(Boolean).join(' · ')}</li>`).join('')}</ul></div>` : ''}
        ${p.errors.length ? `<div class="alert bad">${p.errors.length} line(s) couldn't be read and will be skipped:<ul>${p.errors.slice(0, 10).map((x) => `<li>Row ${x.line}: ${esc(x.reason)}</li>`).join('')}</ul></div>` : ''}`;
      go.disabled = false; go.textContent = `Import ${p.lines} lines`;
    } catch (err) { errorBox(m.el, err.message); go.disabled = true; }
  };
  go.onclick = async () => {
    go.disabled = true;
    try {
      const res = await api('POST', '/timecards/import', { rows, filename, commit: true });
      m.close();
      toast(`Imported ${res.preview.lines} lines: ${res.result.matched} match, ${res.result.variances} differ, ${res.result.unscheduled} not scheduled`);
      S.verifyWeek = res.preview.period.from; S.verifyFilter = 'all';
      renderVerify(page);
    } catch (e) { errorBox(m.el, e.message); go.disabled = false; }
  };
}

// A no-show needs a reason; it is kept on the employee's attendance history.
function noShowModal(a, after) {
  const m = modal({
    title: `No-show – ${fullName(a)}, ${dayLabel(a.work_date, { weekday: 'long', month: 'short', day: 'numeric' })}`,
    body: `<div class="small muted">${esc(a.job_number)} ${esc(a.project_name)} · ${fmtH(a.planned_hours)} h scheduled</div>
      <div class="grid2">
        <label>Reason<select name="reason">${['Sick', 'Family emergency', 'No call / no show', 'Weather', 'Transportation', 'Injury', 'Personal', 'Other'].map((x) => opt(x, x)).join('')}</select></label>
        <label>Excused?<select name="excused"><option value="Excused">Excused</option><option value="Unexcused">Unexcused</option></select></label>
      </div>
      <label>Details<input name="detail" maxlength="300" placeholder="e.g. Called the super at 6:15am"></label>
      <div class="small muted">This is saved on ${esc(a.first_name)}'s attendance history (Employees → their record).</div>`,
    footer: '<button data-close>Cancel</button><button class="danger" data-act="go">Mark no-show</button>',
  });
  $('[data-act=go]', m.el).onclick = async () => {
    const f = formData(m.el);
    const note = `${f.reason} – ${f.excused.toLowerCase()}${f.detail ? `: ${f.detail}` : ''}`;
    try { await api('POST', `/assignments/${a.id}/verify`, { status: 'no_show', note }); m.close(); toast('Marked no-show'); after(); } catch (e) { errorBox(m.el, e.message); }
  };
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
async function renderProjects(page) {
  const showAll = store('wf_proj_all') === '1';
  const [projects, employees] = await Promise.all([api('GET', `/projects${showAll ? '?all=1' : ''}`), api('GET', '/employees?all=1')]);
  S.allEmployees = employees;
  const statusPill = (s) => `<span class="pill ${s === 'active' ? 'ok' : s === 'on_hold' ? 'warn' : s === 'complete' ? '' : 'job'}">${esc(s.replace('_', ' '))}</span>`;
  const pms = [...new Map(projects.filter((p) => p.project_manager_name).map((p) => [String(p.project_manager_employee_id), p.project_manager_name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const sort = S.projSort || { key: 'job_number', dir: 1 };
  const filterPm = S.projPm || '';
  const cols = [
    ['job_number', 'Job #'], ['name', 'Project'], ['project_manager_name', 'Project manager'], ['superintendent_name', 'Superintendent'],
    ['status', 'Status'], ['start_date', 'Dates'], ['hours_to_date', 'Hours to date', 'right'], ['verified_hours', 'Verified', 'right'], ['budget_pct', 'Budget'],
  ];
  const rows = projects
    .map((p) => ({ ...p, budget_pct: p.total_budget_hours ? p.hours_to_date / p.total_budget_hours : null }))
    .filter((p) => !filterPm || String(p.project_manager_employee_id) === filterPm)
    .sort((a, b) => {
      const x = a[sort.key]; const y = b[sort.key];
      if (x === null || x === undefined || x === '') return 1; // blanks last either way
      if (y === null || y === undefined || y === '') return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir || a.job_number.localeCompare(b.job_number);
    });
  page.innerHTML = `
    <div class="toolbar"><h1 style="margin:0">Projects</h1><span class="spacer"></span>
      <select data-act="pm"><option value="">All project managers</option>${pms.map(([id, n]) => opt(id, n, filterPm)).join('')}</select>
      <label class="check"><input type="checkbox" data-act="all" ${showAll ? 'checked' : ''}> Show completed</label>
      ${isAdmin() ? '<button data-act="import">Import from spreadsheet…</button>' : ''}
      ${canSchedule() ? '<button class="primary" data-act="new">+ New project</button>' : ''}</div>
    <div class="table-wrap"><table class="list sortable">
      <thead><tr>${cols.map(([k, l, cls]) => `<th class="${cls || ''}"><button class="sort-h ${sort.key === k ? 'on' : ''}" data-sort="${k}" aria-label="Sort by ${esc(l)}">${esc(l)}${sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('')}</tr></thead>
      <tbody>${rows.map((p) => {
        const pct = p.budget_pct !== null ? Math.round(p.budget_pct * 100) : null;
        return `<tr class="${canSchedule() ? 'click' : ''}" data-id="${p.id}">
          <td class="nowrap"><span class="proj-swatch" style="background:${esc(p.color || '#F15A22')}"></span><b>${esc(p.job_number)}</b></td>
          <td>${esc(p.name)}<div class="small muted">${esc([p.customer, p.address].filter(Boolean).join(' · '))}</div></td>
          <td>${esc(p.project_manager_name || '')}</td>
          <td>${esc(p.superintendent_name || '')}</td><td>${statusPill(p.status)}</td>
          <td class="small nowrap">${esc(p.start_date || '')}${p.end_date ? ' → ' + esc(p.end_date) : ''}</td>
          <td class="right">${fmtH(p.hours_to_date)}</td><td class="right">${fmtH(p.verified_hours)}</td>
          <td title="${esc(`Budget ${fmtH(p.budget_hours || 0)} h + change orders ${fmtH(p.co_hours || 0)} h = ${fmtH(p.total_budget_hours || 0)} h`)}">${pct !== null ? `<div class="small">${fmtH(p.total_budget_hours)} h${p.co_hours ? ` <span class="muted">(incl. ${p.co_hours > 0 ? '+' : ''}${fmtH(p.co_hours)} CO)</span>` : ''} · ${pct}%</div><div class="bar ${pct > 100 ? 'over' : pct > 85 ? 'near' : ''}"><span style="width:${Math.min(pct, 100)}%"></span></div>` : '<span class="small muted">—</span>'}</td>
        </tr>`;
      }).join('') || `<tr><td colspan="${cols.length}" class="muted">No projects${filterPm ? ' for this project manager' : ' yet'}.</td></tr>`}</tbody>
    </table></div>`;
  $('[data-act=all]', page).onchange = (e) => { store('wf_proj_all', e.target.checked ? '1' : '0'); renderProjects(page); };
  $('[data-act=pm]', page).onchange = (e) => { S.projPm = e.target.value; renderProjects(page); };
  $$('[data-sort]', page).forEach((b) => (b.onclick = () => {
    const k = b.dataset.sort;
    S.projSort = { key: k, dir: sort.key === k ? -sort.dir : 1 };
    renderProjects(page);
  }));
  const imp = $('[data-act=import]', page); if (imp) imp.onclick = importProjectsModal;
  if (canSchedule()) {
    $('[data-act=new]', page).onclick = () => projectModal({ status: 'active' });
    $$('tr[data-id]', page).forEach((tr) => (tr.onclick = () => projectModal(projects.find((p) => p.id === Number(tr.dataset.id)))));
  }
}

function projectModal(p) {
  // Superintendent: anyone classified Superintendent or Foreman. PM: classified Project Manager.
  // The person already on the project stays listed even if their classification changed.
  const emps = (S.allEmployees || []).filter((e) => e.active);
  const pick = (test, currentId) => {
    const list = emps.filter(test);
    const cur = (S.allEmployees || []).find((e) => e.id === currentId);
    if (cur && !list.includes(cur)) list.push(cur);
    return list.sort((a, b) => a.last_name.localeCompare(b.last_name) || a.first_name.localeCompare(b.first_name));
  };
  const supers = pick(isSuperOrForeman, p.superintendent_employee_id);
  const pms = pick(isProjectManager, p.project_manager_employee_id);
  const label = (e) => `${e.last_name}, ${e.first_name}${e.classification ? ` – ${e.classification}` : ''}`;
  const m = modal({
    title: p.id ? `Edit ${p.job_number}` : 'New project',
    body: `<div class="grid2">
        <label>Job number *<input name="job_number" value="${esc(p.job_number || '')}"></label>
        <label>Project name *<input name="name" value="${esc(p.name || '')}"></label>
        <label>Customer / GC<input name="customer" value="${esc(p.customer || '')}"></label>
        <label>Project manager<select name="project_manager_employee_id"><option value="">—</option>${pms.map((e) => opt(e.id, label(e), p.project_manager_employee_id)).join('')}</select></label>
        <label>Superintendent / foreman<select name="superintendent_employee_id"><option value="">—</option>${supers.map((e) => opt(e.id, label(e), p.superintendent_employee_id)).join('')}</select></label>
        <label>Status<select name="status">${['planned', 'active', 'on_hold', 'complete'].map((s) => opt(s, s.replace('_', ' '), p.status)).join('')}</select></label>
        <label>Original budget (labor hours)<input type="number" name="budget_hours" min="0" value="${esc(p.budget_hours ?? '')}"></label>
        <label title="Hours already used before this job was set up in the app">Starting hours (already used)<input type="number" name="starting_hours" min="0" step="0.5" value="${esc(p.starting_hours ?? 0)}"></label>
        <label>Start date<input type="date" name="start_date" value="${esc(p.start_date || '')}"></label>
        <label>End date<input type="date" name="end_date" value="${esc(p.end_date || '')}"></label>
        <label>Board color<input type="color" name="color" value="${esc(p.color || '#F15A22')}"></label>
      </div>
      ${!supers.length || !pms.length ? `<div class="small muted">The lists come from Employees: superintendents and foremen by their classification, project managers by "Project Manager". ${!pms.length ? 'No one is classified Project Manager yet.' : ''}</div>` : ''}
      <label>Site address<input name="address" value="${esc(p.address || '')}"></label>
      <label>Notes<textarea name="notes">${esc(p.notes || '')}</textarea></label>
      ${p.id ? '<div id="co-box" class="co-box"><div class="small muted">Loading change orders…</div></div>' : '<div class="small muted">Save the project first, then add change orders.</div>'}`,
    footer: `${p.id && isAdmin() ? '<button class="danger" data-act="del">Delete</button>' : ''}<span class="spacer"></span><button data-close>Cancel</button><button class="primary" data-act="save">Save</button>`,
  });
  $('[data-act=save]', m.el).onclick = async () => {
    try { await api(p.id ? 'PUT' : 'POST', p.id ? `/projects/${p.id}` : '/projects', formData(m.el)); m.close(); toast('Saved'); renderProjects($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
  if (p.id) drawChangeOrders(p, $('#co-box', m.el));
  const del = $('[data-act=del]', m.el);
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${p.job_number}?`)) return;
    try { await api('DELETE', `/projects/${p.id}`); m.close(); toast('Deleted'); renderProjects($('#page')); } catch (e) { errorBox(m.el, e.message); }
  };
}

// Change order log on a project: each CO adds (or deducts) labor hours to the budget.
async function drawChangeOrders(p, box) {
  const list = await api('GET', `/projects/${p.id}/change-orders`);
  const coTotal = list.reduce((sum, c) => sum + c.hours, 0);
  const budget = (p.budget_hours || 0) + coTotal;
  const editable = canEditProject(p.id);
  box.innerHTML = `<div class="co-head"><b>Change orders</b>
      <span class="small">Original ${fmtH(p.budget_hours || 0)} h ${coTotal >= 0 ? '+' : '−'} change orders ${fmtH(Math.abs(coTotal))} h = <b>${fmtH(budget)} h total budget</b>
      · ${fmtH(p.hours_to_date || 0)} h used (incl. ${fmtH(p.starting_hours || 0)} starting)</span></div>
    ${list.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>CO #</th><th>Description</th><th>Date</th><th class="right">Hours</th><th></th></tr></thead>
      <tbody>${list.map((c) => `<tr><td>${esc(c.co_number || '')}</td><td>${esc(c.description || '')}</td><td class="nowrap">${esc(c.co_date || c.created_at.slice(0, 10))}</td>
        <td class="right">${c.hours > 0 ? '+' : ''}${fmtH(c.hours)}</td><td>${editable ? `<button class="link" data-del-co="${c.id}">remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">No change orders yet.</div>'}
    ${editable ? `<div class="co-add"><input name="co_number" placeholder="CO #" aria-label="Change order number"><input name="description" placeholder="Description" aria-label="Description">
      <input type="date" name="co_date" aria-label="Date"><input type="number" step="0.5" name="hours" placeholder="Hours (− for deduct)" aria-label="Hours"><button data-act="add-co">Add change order</button></div>` : ''}`;
  const add = $('[data-act=add-co]', box);
  if (add) add.onclick = async () => {
    const f = Object.fromEntries($$('.co-add [name]', box).map((x) => [x.name, x.value]));
    try { await api('POST', `/projects/${p.id}/change-orders`, f); toast('Change order added'); drawChangeOrders(p, box); renderProjects($('#page')); } catch (e) { toast(e.message, true); }
  };
  $$('[data-del-co]', box).forEach((b) => (b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'click again to remove'; return; }
    await api('DELETE', `/change-orders/${b.dataset.delCo}`); drawChangeOrders(p, box); renderProjects($('#page'));
  }));
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
      ${isAdmin() ? '<button data-act="import">Import from spreadsheet…</button>' : ''}
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
    const imp = $('[data-act=import]', page); if (imp) imp.onclick = importEmployeesModal;
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
      <datalist id="class-list">${['Superintendent', 'General Foreman', 'Foreman', 'Project Manager', 'Journeyman', 'Apprentice 1st yr', 'Apprentice 2nd yr', 'Apprentice 3rd yr', 'Apprentice 4th yr', 'Operator', 'Laborer Group 1'].map((t) => `<option value="${t}">`).join('')}</datalist>
      <div><div class="small muted" style="margin-bottom:4px">Skills &amp; certifications (expiration optional)</div>
        <div class="grid2" id="skill-grid">${skills.map((s) => `<div style="display:flex;gap:6px;align-items:center">
          <label class="check" style="flex:1"><input type="checkbox" data-skill="${esc(s.name)}" ${have.has(s.name) ? 'checked' : ''} ${dis}>${esc(s.name)}</label>
          <input type="date" data-exp="${esc(s.name)}" value="${esc(have.get(s.name) || '')}" style="width:150px" ${dis}></div>`).join('')}</div>
        ${ro ? '' : '<input placeholder="Add new skills, comma separated (e.g. OSHA 30, Forklift)" data-newskills style="margin-top:8px">'}</div>
      <label>Notes<textarea name="notes" ${dis}>${esc(e.notes || '')}</textarea></label>
      ${e.id ? `<label class="check"><input type="checkbox" name="active" ${e.active ? 'checked' : ''} ${dis}> Active</label>
        <div id="emp-off" class="co-box"></div><div id="emp-ns"></div><div id="emp-hist" class="small muted">Loading history…</div>` : ''}`,
    footer: ro ? '<button data-close>Close</button>' : `${e.id && isAdmin() ? '<button class="danger" data-act="del">Delete</button>' : ''}<span class="spacer"></span>
<button data-close>Cancel</button><button class="primary" data-act="save">Save</button>`,
  });
  if (e.id) api('GET', `/employees/${e.id}`).then((full) => {
    const h = $('#emp-hist', m.el); if (!h) return;
    drawTimeOff(e, full.time_off, $('#emp-off', m.el));
    $('#emp-ns', m.el).innerHTML = full.no_shows.length ? `<b class="small">No-shows (${full.no_shows.length})</b><div class="table-wrap" style="max-height:160px;margin-top:4px"><table class="list"><tbody>${full.no_shows.map((n) => `<tr>
      <td class="nowrap">${esc(n.work_date)}</td><td>${esc(n.job_number)}</td><td>${esc(n.verify_note || '')}</td><td class="small muted">${esc(n.verified_by_name || '')}</td></tr>`).join('')}</tbody></table></div>` : '';
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
}

// Time off on the employee record: any future date range, with a reason.
// It shows on the schedule when that week comes up, and blocks scheduling.
function drawTimeOff(e, list, box) {
  const today = todayStr();
  const upcoming = list.filter((t) => t.off_date >= today);
  // Group consecutive entries with the same reason into ranges for display.
  const ranges = [];
  for (const t of upcoming) {
    const last = ranges[ranges.length - 1];
    if (last && last.reason === (t.reason || '') && addDays(last.to, 1) <= t.off_date && t.off_date <= addDays(last.to, 3)) { last.to = t.off_date; last.ids.push(t.id); last.days += 1; }
    else ranges.push({ from: t.off_date, to: t.off_date, reason: t.reason || '', ids: [t.id], days: 1 });
  }
  const can = canSchedule();
  box.innerHTML = `<div class="co-head"><b>Time off</b><span class="small muted">Enter time off for any future dates. It shows on the schedule when that week comes up, and they can't be scheduled those days.</span></div>
    ${ranges.length ? `<div class="table-wrap"><table class="list"><tbody>${ranges.map((r, i) => `<tr><td class="nowrap">${esc(dayLabel(r.from, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}${r.to !== r.from ? ` – ${esc(dayLabel(r.to, { weekday: 'short', month: 'short', day: 'numeric' }))}` : ''}</td>
      <td>${esc(r.reason)}</td><td class="small muted">${r.days} day${r.days > 1 ? 's' : ''}</td><td>${can ? `<button class="link" data-del-off="${i}">remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="small muted">No upcoming time off.</div>'}
    ${can ? `<div class="co-add off-add"><input type="date" name="from" aria-label="From" value="${today}"><input type="date" name="to" aria-label="To" value="${today}">
      <select name="reason" aria-label="Reason">${['Vacation', 'Sick / medical', 'Personal', 'Family leave', 'Jury duty', 'Union business', 'Training', 'Bereavement', 'Laid off', 'Other'].map((x) => opt(x, x)).join('')}</select>
      <input name="note" placeholder="Note (optional)" aria-label="Note"><label class="check"><input type="checkbox" name="weekdays_only" checked> Weekdays only</label>
      <button data-act="add-off">Add time off</button></div><div class="off-msg"></div>` : ''}`;
  const add = $('[data-act=add-off]', box);
  if (add) add.onclick = async () => {
    const g = (n) => $(`.off-add [name=${n}]`, box);
    const reason = [g('reason').value, g('note').value.trim()].filter(Boolean).join(' – ');
    try {
      const r = await api('POST', '/time-off', { employee_id: e.id, from: g('from').value, to: g('to').value, weekdays_only: g('weekdays_only').checked, reason });
      toast(`Added ${r.added} day${r.added === 1 ? '' : 's'} off`);
      const full = await api('GET', `/employees/${e.id}`);
      drawTimeOff(e, full.time_off, box);
      if (r.conflicts.length) $('.off-msg', box).innerHTML = `<div class="alert warn-box">Not added – already scheduled:<ul>${r.conflicts.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>Remove those days from the schedule first, then add the time off again.</div>`;
    } catch (err) { toast(err.message, true); }
  };
  $$('[data-del-off]', box).forEach((b) => (b.onclick = async () => {
    const r = ranges[Number(b.dataset.delOff)];
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = `remove ${r.days} day${r.days > 1 ? 's' : ''}?`; return; }
    for (const id of r.ids) await api('DELETE', `/time-off/${id}`);
    const full = await api('GET', `/employees/${e.id}`);
    drawTimeOff(e, full.time_off, box);
  }));
}

// Minimal CSV parser (quoted fields, embedded commas/quotes/newlines, BOM).
function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Shared spreadsheet import: choose a CSV, preview new / update / skipped / error
// rows from the server, then import. Used for employees and projects.
function importModal(cfg) {
  let rows = [];
  const m = modal({
    title: cfg.title,
    wide: true,
    body: `<div class="small muted">Save your list as a <b>CSV</b> file (in Excel: File → Save As → CSV). Columns can be in any order; recognized headings are ${cfg.headings}.
        ${cfg.matchNote} Blank cells never erase what's already saved. <button class="link" data-act="template">Download a template</button></div>
      <div class="grid2">
        <label>CSV file<input type="file" accept=".csv,text/csv" data-act="file"></label>
        ${cfg.skipDefault !== undefined ? `<label>Skip rows whose trade or classification is (comma separated)<input data-act="skip" value="${esc(cfg.skipDefault)}"></label>` : ''}
      </div>
      ${cfg.warning ? `<div class="small muted">${cfg.warning}</div>` : ''}
      <div id="imp-out"></div>`,
    footer: '<button data-close>Cancel</button><button class="primary" data-act="go" disabled>Import</button>',
  });
  const skipBox = $('[data-act=skip]', m.el);
  const skipList = () => (skipBox ? skipBox.value.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const out = $('#imp-out', m.el); const go = $('[data-act=go]', m.el);
  const show = (r) => {
    const s2 = r.summary;
    const label = { create: 'New', update: 'Update', skip: 'Skipped', error: 'Error' };
    out.innerHTML = `<div class="stats" style="margin:8px 0">
        <div class="stat ok"><div class="v">${s2.create}</div><div class="l">New ${cfg.noun}s</div></div>
        <div class="stat"><div class="v">${s2.update}</div><div class="l">Updates to existing</div></div>
        ${skipBox ? `<div class="stat"><div class="v">${s2.skip}</div><div class="l">Skipped (excluded)</div></div>` : ''}
        <div class="stat ${s2.error ? 'bad' : ''}"><div class="v">${s2.error}</div><div class="l">Rows with errors</div></div></div>
      ${s2.error ? '<div class="alert bad">Fix the rows marked Error in your file and choose it again. Nothing is imported while errors remain.</div>' : ''}
      <div class="table-wrap" style="max-height:320px"><table class="list"><thead><tr><th>Row</th><th>Result</th>${cfg.cols.map((c) => `<th>${esc(c[0])}</th>`).join('')}<th>Note</th></tr></thead>
      <tbody>${r.results.map((x) => `<tr><td>${x.line}</td>
        <td><span class="pill ${x.action === 'error' ? 'bad' : x.action === 'create' ? 'ok' : x.action === 'skip' ? '' : 'job'}">${label[x.action]}</span></td>
        ${cfg.cols.map((c) => `<td>${esc(c[1](x) || '')}</td>`).join('')}
        <td class="small">${esc(x.reason || '')}</td></tr>`).join('')}</tbody></table></div>`;
    go.disabled = !!s2.error || !(s2.create + s2.update);
    go.textContent = `Import ${s2.create + s2.update} ${cfg.noun}${s2.create + s2.update === 1 ? '' : 's'}`;
  };
  const preview = async () => {
    if (!rows.length) return;
    try { show(await api('POST', cfg.endpoint, { rows, skip: skipList() })); } catch (e) { errorBox(m.el, e.message); }
  };
  $('[data-act=template]', m.el).onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([cfg.template], { type: 'text/csv' }));
    a.download = cfg.templateName; a.click();
  };
  $('[data-act=file]', m.el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    errorBox(m.el, '');
    rows = parseCsv(await f.text());
    if (!rows.length) { out.innerHTML = ''; go.disabled = true; return errorBox(m.el, 'That file has no rows under the heading row.'); }
    preview();
  };
  if (skipBox) skipBox.onchange = preview;
  go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await api('POST', cfg.endpoint, { rows, skip: skipList(), commit: true });
      m.close(); toast(`Imported: ${r.summary.create} new, ${r.summary.update} updated${skipBox ? `, ${r.summary.skip} skipped` : ''}`);
      cfg.onDone();
    } catch (e) { errorBox(m.el, e.message); if (e.data?.results) show(e.data); }
  };
}

const importEmployeesModal = () => importModal({
  title: 'Import employees from a spreadsheet', endpoint: '/employees/import', noun: 'employee',
  headings: 'Employee #, First Name, Last Name, Phone, Email, Trade, Union Local, Classification, Hire Date, Active, Skills (separate with ;) and Notes',
  matchNote: 'People are matched by Employee #, so importing an updated list later updates them instead of adding duplicates.',
  skipDefault: 'Clerical, CLER',
  warning: 'Never include Social Security numbers, pay rates or home addresses in this file. Pay rates go in Payroll → Pay rates.',
  template: 'Employee #,First Name,Last Name,Phone,Email,Trade,Union Local,Classification,Hire Date,Active,Skills,Notes\r\n'
    + '9001,Sam,Example,(555)010-0001,,Carpenter,Zone 3 Carpenters,Carpenter Foreman,6/22/2026,Yes,OSHA 30; Forklift,Example row – replace with your own\r\n',
  templateName: 'employee-import-template.csv',
  cols: [['Name', (x) => x.name], ['Emp #', (x) => x.employee_no], ['Classification / trade', (x) => [x.classification, x.trade].filter(Boolean).join(' · ')]],
  onDone: () => renderEmployees($('#page')),
});

const importProjectsModal = () => importModal({
  title: 'Import projects from a spreadsheet', endpoint: '/projects/import', noun: 'project',
  headings: 'Job Number, Project Name, Customer, Address, City, State, ZIP, Status (or Stage), Start Date, End Date, Budget Hours, Starting Hours, Change Order Hours, Superintendent, Project Manager and Notes',
  matchNote: 'Projects are matched by job number, so importing an updated list later updates them. Superintendent and Project Manager are matched to employees by name (e.g. "Sam Example"). Stages like "Course of Construction" become Active; "Pre-Construction" and "Bidding" become Planned.',
  template: 'Job Number,Project Name,Customer,Address,City,State,ZIP,Status,Start Date,End Date,Budget Hours,Starting Hours,Change Order Hours,Superintendent,Project Manager,Notes\r\n'
    + '9999,Example Office Renovation,Example Owner,100 Main Street,Murphysboro,Illinois,62966,Course of Construction,3/2/2026,,6500,1200,140,Sam Example,Pat Planner,Example row – replace with your own\r\n',
  templateName: 'project-import-template.csv',
  cols: [['Job #', (x) => x.job_number], ['Project', (x) => x.name], ['Status', (x) => (x.status || '').replace('_', ' ')]],
  onDone: () => renderProjects($('#page')),
});

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
      <label>Approval<select name="approval"><option value="">All</option>${[['approved', 'Approved'], ['pending', 'Pending'], ['rejected', 'Rejected']].map(([v, l]) => opt(v, l, f.approval)).join('')}</select></label>
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
      <div class="table-wrap"><table class="list"><thead><tr><th>Date</th><th>Job</th><th>Employee</th><th>Trade</th><th class="right">Projected</th><th class="right">Actual</th><th>Status</th><th>Approval</th><th>Task</th></tr></thead>
      <tbody>${r.rows.map((x) => `<tr><td class="nowrap">${esc(x.work_date)}</td><td>${esc(x.job_number)} <span class="small muted">${esc(x.project_name)}</span></td>
        <td>${esc(fullName(x))}</td><td>${esc(x.trade || '')}</td><td class="right">${fmtH(x.planned_hours)}</td><td class="right">${x.actual_hours === null ? '' : fmtH(x.actual_hours)}</td>
        <td><span class="pill ${x.status === 'no_show' ? 'bad' : x.status === 'scheduled' ? '' : 'ok'}">${esc(x.status.replace('_', '-'))}</span></td>
        <td>${x.approval_status === 'approved' ? '<span class="pill job">✓ approved</span>' : x.approval_status === 'pending' ? '<span class="pill warn">pending</span>' : `<span class="pill bad" title="${esc(x.reject_reason || '')}">rejected</span>`}</td>
        <td class="small">${esc(x.task || '')}${x.reject_reason ? `<div class="muted">Rejected: ${esc(x.reject_reason)}</div>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No records.</td></tr>'}</tbody></table></div>`;
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
    ${r.pending_requests?.count ? `<div class="alert">Costs include approved work only. ${r.pending_requests.count} pending crew request${r.pending_requests.count > 1 ? 's' : ''} (${fmtH(r.pending_requests.hours)} h) are not included until approved.</div>` : ''}
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
    <p class="small muted">Each day is costed at the pay rate in effect that day; pick a past week to see what labor actually cost. Uses verified actual hours where entered, otherwise scheduled hours. Wages = Reg × base + OT × base × multiplier. Burden = wages × burden %. Fringe = all hours × fringe rate.</p>`;
  const body = $('#pay-body', page);
  $('[data-act=prev]', body).onclick = () => { S.payStart = addDays(S.payStart, -7); renderPayroll(page); };
  $('[data-act=next]', body).onclick = () => { S.payStart = addDays(S.payStart, 7); renderPayroll(page); };
  $('[data-act=start]', body).onchange = (e) => { if (e.target.value) { S.payStart = weekStart(e.target.value); renderPayroll(page); } };
  $('[data-act=weeks]', body).onchange = (e) => { S.payWeeks = Number(e.target.value); renderPayroll(page); };
  const fix = $('[data-act=fix]', body); if (fix) fix.onclick = (e) => { e.preventDefault(); S.payTab = 'rates'; renderPayroll(page); };
}

async function payRates(el) {
  const rows = await api('GET', '/payroll/rates');
  const today = todayStr();
  const nextMon = addDays(weekStart(today), 7);
  const rateCell = (r) => (r ? `${money2(r.base_rate)}<span class="small muted"> + ${money2(r.fringe_rate)} fringe${r.burden_pct !== null ? ` · ${r.burden_pct}% burden` : ''}</span>` : '<span class="pill warn">No rate</span>');
  el.classList.remove('muted');
  el.innerHTML = `<p class="small muted">Each rate has an effective date. Every day worked is costed at the rate in effect on that day, so past weeks keep the rate that was paid and a union increase only applies from its start date. Leave burden blank to use the company default.</p>
    <div class="toolbar"><button data-act="bulk">Union increase for a trade…</button></div>
    <div class="table-wrap"><table class="list"><thead><tr><th>Employee</th><th>Trade / local</th><th>Current rate</th><th>Since</th><th>Scheduled change</th><th></th></tr></thead>
    <tbody>${rows.map((r) => `<tr data-id="${r.employee_id}">
      <td><b>${esc(r.last_name)}, ${esc(r.first_name)}</b><div class="small muted">${esc(r.classification || '')}</div></td>
      <td>${esc(r.trade || '')}${r.union_local ? ` · L${esc(r.union_local)}` : ''}</td>
      <td>${rateCell(r.current)}</td>
      <td class="nowrap small">${r.current ? esc(r.current.effective_date > today ? 'starts ' + r.current.effective_date : r.current.effective_date) : ''}</td>
      <td class="small">${r.upcoming.map((u) => `<span class="pill job">${esc(u.effective_date)}: ${money2(u.base_rate)}</span>`).join(' ')}</td>
      <td class="nowrap"><button data-act="hist">History (${r.history.length})</button> <button class="primary" data-act="new">New rate</button></td></tr>`).join('')}</tbody></table></div>`;

  const rateForm = (title, emp, preset = {}) => {
    const m = modal({
      title,
      body: `${emp ? `<div class="small muted">${esc(emp.first_name)} ${esc(emp.last_name)} · ${esc(emp.trade || '')}${emp.current ? ` · current ${money2(emp.current.base_rate)}/hr` : ''}</div>` : ''}
        ${preset.extra || ''}
        <div class="grid2">
          <label>Effective date<input type="date" name="effective_date" value="${esc(preset.effective_date || nextMon)}"></label>
          <label>Base $/hr<input type="number" step="0.01" min="0" name="base_rate" value="${esc(preset.base_rate ?? emp?.current?.base_rate ?? '')}"></label>
          <label>Fringe $/hr<input type="number" step="0.01" min="0" name="fringe_rate" value="${esc(preset.fringe_rate ?? emp?.current?.fringe_rate ?? '')}"></label>
          <label>Burden % (blank = default)<input type="number" step="0.1" min="0" name="burden_pct" value="${esc(preset.burden_pct ?? emp?.current?.burden_pct ?? '')}"></label>
        </div>
        <label>Note<input name="note" maxlength="200" placeholder="e.g. June 1 Local 1445 increase, promoted to foreman" value="${esc(preset.note || '')}"></label>
        <div class="small muted">Days on or after the effective date use this rate. Earlier days keep their earlier rate. Entering a date that already has a rate replaces it.</div>`,
      footer: '<button data-close>Cancel</button><button class="primary" data-act="save">Save rate</button>',
    });
    return m;
  };

  $$('tr[data-id]', el).forEach((tr) => {
    const emp = rows.find((r) => r.employee_id === Number(tr.dataset.id));
    $('[data-act=new]', tr).onclick = () => {
      const m = rateForm('New pay rate', emp);
      $('[data-act=save]', m.el).onclick = async () => {
        try { await api('POST', `/payroll/rates/${emp.employee_id}`, formData(m.el)); m.close(); toast('Rate saved'); payRates(el); } catch (e) { errorBox(m.el, e.message); }
      };
    };
    $('[data-act=hist]', tr).onclick = () => {
      const m = modal({
        title: `Rate history – ${emp.first_name} ${emp.last_name}`,
        wide: true,
        body: emp.history.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Effective</th><th class="right">Base</th><th class="right">Fringe</th><th class="right">Burden</th><th>Note</th><th>Entered by</th><th></th></tr></thead>
          <tbody>${emp.history.map((h) => `<tr><td class="nowrap">${esc(h.effective_date)}${emp.current && h.id === emp.current.id ? ' <span class="pill ok">current</span>' : h.effective_date > today ? ' <span class="pill warn">upcoming</span>' : ''}</td>
            <td class="right">${money2(h.base_rate)}</td><td class="right">${money2(h.fringe_rate)}</td><td class="right">${h.burden_pct ?? 'default'}${h.burden_pct !== null ? '%' : ''}</td>
            <td class="small">${esc(h.note || '')}</td><td class="small muted">${esc(h.created_by_name || '')}<br>${esc(h.created_at.slice(0, 10))}</td>
            <td><button class="link" data-del="${h.id}">remove</button></td></tr>`).join('')}</tbody></table></div>
          <div class="small muted">Removing a rate re-costs the days it covered at the rate before it. Use it only to fix a mistake.</div>` : '<div class="muted">No rates yet.</div>',
        footer: '<button data-close>Close</button>',
      });
      $$('[data-del]', m.el).forEach((b) => (b.onclick = async () => {
        if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'click again to remove'; return; }
        try { await api('DELETE', `/payroll/rates/entry/${b.dataset.del}`); m.close(); toast('Rate removed'); payRates(el); } catch (e) { toast(e.message, true); }
      }));
    };
  });

  // Apply the same raise to everyone in a trade (e.g. a union contract increase).
  $('[data-act=bulk]', el).onclick = () => {
    const trades = [...new Set(rows.map((r) => r.trade).filter(Boolean))].sort();
    const m = modal({
      title: 'Union increase for a trade',
      body: `<label>Trade<select name="trade">${trades.map((t) => opt(t, t)).join('')}</select></label>
        <div class="grid2">
          <label>Effective date<input type="date" name="effective_date" value="${nextMon}"></label>
          <label>Base increase $/hr<input type="number" step="0.01" name="base_inc" value="0"></label>
          <label>Fringe increase $/hr<input type="number" step="0.01" name="fringe_inc" value="0"></label>
        </div>
        <label>Note<input name="note" maxlength="200" placeholder="e.g. Local 1445 June 1 increase"></label>
        <div class="small muted" id="bulk-preview"></div>`,
      footer: '<button data-close>Cancel</button><button class="primary" data-act="save">Add rates</button>',
    });
    const targets = () => rows.filter((r) => r.trade === $('[name=trade]', m.el).value && r.current);
    const preview = () => {
      const t = targets(); const f = formData(m.el);
      $('#bulk-preview', m.el).textContent = `${t.length} people get a new rate effective ${f.effective_date}: base +${money2(Number(f.base_inc) || 0)}, fringe +${money2(Number(f.fringe_inc) || 0)}. People without a current rate are skipped.`;
    };
    $$('input,select', m.el).forEach((x) => (x.oninput = preview)); preview();
    $('[data-act=save]', m.el).onclick = async () => {
      const f = formData(m.el);
      try {
        for (const r of targets()) {
          await api('POST', `/payroll/rates/${r.employee_id}`, {
            effective_date: f.effective_date,
            base_rate: Math.round((r.current.base_rate + (Number(f.base_inc) || 0)) * 100) / 100,
            fringe_rate: Math.round((r.current.fringe_rate + (Number(f.fringe_inc) || 0)) * 100) / 100,
            burden_pct: r.current.burden_pct ?? '', note: f.note,
          });
        }
        m.close(); toast(`Added ${targets().length} rates`); payRates(el);
      } catch (e) { errorBox(m.el, e.message); }
    };
  };
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
      <label>Payroll week starts on<select name="payroll_week_start">${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => opt(i, d, s.payroll_week_start)).join('')}</select></label>
      <label>Warn when a person is over (hours / day)<input type="number" step="0.5" min="1" max="24" name="warn_daily_hours" value="${esc(s.warn_daily_hours)}"></label>
      <label>OT after (hours / week)<input type="number" name="ot_threshold_hours" value="${esc(s.ot_threshold_hours)}"></label>
      <label>OT multiplier<input type="number" step="0.1" name="ot_multiplier" value="${esc(s.ot_multiplier)}"></label>
      <label>Default burden % (taxes, WC, GL)<input type="number" step="0.1" name="default_burden_pct" value="${esc(s.default_burden_pct)}"></label>
      <label>Hard limit – never schedule over (hours / day)<input type="number" step="0.5" min="1" max="24" name="max_daily_hours" value="${esc(s.max_daily_hours)}"></label>
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
