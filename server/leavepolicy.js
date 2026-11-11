'use strict';
// Time-off policy math (Company Policy Manual §7.1 PTO, §7.2 Vacation, and the
// §7.1(A) amendment for Field Superintendents). Pure functions: no database.
// All numbers come from Settings so a policy change doesn't need a code change.
const { daysBetween } = require('./dates');

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y) => (isLeap(y) ? 366 : 365);

// Share of calendar year `y` on or after date `d` (1 = whole year, 0 = none).
function shareFrom(y, d) {
  if (!d || d <= `${y}-01-01`) return 1;
  if (d > `${y}-12-31`) return 0;
  return (daysBetween(d, `${y}-12-31`) + 1) / daysInYear(y);
}

// Date `months` months after `date` (service anniversaries).
function plusMonths(date, months) {
  const d = new Date(date + 'T00:00:00Z');
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()));
  return t.toISOString().slice(0, 10);
}

// A yearly rate that steps up on given dates, prorated by the share of the year at
// each rate. steps = [{ from: date|null, rate }] in date order; nothing before the first.
function stepped(y, steps) {
  let total = 0;
  for (let i = 0; i < steps.length; i++) {
    const share = shareFrom(y, steps[i].from) - (steps[i + 1] ? shareFrom(y, steps[i + 1].from) : 0);
    total += steps[i].rate * Math.max(0, share);
  }
  return Math.round(total);
}

// Settings -> policy numbers.
function policy(s, fallbackYear) {
  const n = (k, d) => (s[k] === undefined || s[k] === null || s[k] === '' || Number.isNaN(Number(s[k])) ? d : Number(s[k]));
  return {
    staffPto: n('staff_pto_default_hours', 56), staffPtoCap: n('staff_pto_cap', 160),
    vac: [n('vac_tier1_hours', 40), n('vac_tier2_hours', 80), n('vac_tier3_hours', 120)], vacCap: n('vac_cap', 160),
    sup: [n('super_pto_tier1_hours', 40), n('super_pto_tier2_hours', 80)], supCap: n('super_pto_cap', 160),
    startYear: n('leave_start_year', fallbackYear),
  };
}

// This year's policy amount for one kind of leave, with a short explanation.
// type: 'staff' | 'project_manager' | 'superintendent'; kind: 'pto' | 'vacation'.
// vacTier: the employee's Vacation tier set by hand (1, 2 or 3), or null = from hire date.
function yearlyGrant(pol, type, kind, hire, y, vacTier = null) {
  const hy = hire ? Number(hire.slice(0, 4)) : null;
  if (hire && hy > y) return { hours: 0, note: `hired ${hire}` };
  if (type === 'superintendent') {
    // §7.1(A): nothing until 1 year of service; 40 h/yr through year 5; 80 h/yr after.
    if (!hire) return { hours: pol.sup[0], note: 'no hire date – using the first-tier rate', missingHire: true };
    const h = stepped(y, [{ from: plusMonths(hire, 12), rate: pol.sup[0] }, { from: plusMonths(hire, 60), rate: pol.sup[1] }]);
    const yrs = y - hy;
    const note = yrs < 1 ? 'eligible after 1 year of service' : yrs === 1 ? 'first year eligible – prorated from 1-year anniversary'
      : yrs < 5 ? `${pol.sup[0]} h/yr (1–5 years)` : yrs === 5 ? 'moves to the 5-year rate – prorated' : `${pol.sup[1]} h/yr (5+ years)`;
    return { hours: h, note };
  }
  if (kind === 'pto') {
    // §7.1: 56 h each Jan 1, prorated for the hire year.
    const h = stepped(y, [{ from: hire && hy === y ? hire : null, rate: pol.staffPto }]);
    return { hours: h, note: hire && hy === y ? `prorated from hire ${hire}` : `${pol.staffPto} h/yr`, missingHire: !hire };
  }
  // §7.2 Vacation: 40 h (10 h per quarter in the hire year), 80 h after 48 months, 120 h after 120 months.
  const tierNames = ['Tier 1 (under 4 years)', 'Tier 2 (4+ years)', 'Tier 3 (10+ years)'];
  if (vacTier && !(hire && hy === y)) {
    const t = Math.min(Math.max(Number(vacTier), 1), 3);
    return { hours: pol.vac[t - 1], note: `${tierNames[t - 1]} – set on the employee`, tier: t };
  }
  if (!hire) return { hours: pol.vac[0], note: 'no hire date – using Tier 1 (set the tier or hire date on the employee)', missingHire: true, tier: 1 };
  if (hy === y) {
    const quarters = 4 - Math.floor((Number(hire.slice(5, 7)) - 1) / 3);
    return { hours: Math.round((pol.vac[0] / 4) * quarters), note: `hire year – ${pol.vac[0] / 4} h per quarter`, tier: 1 };
  }
  const h = stepped(y, [{ from: null, rate: pol.vac[0] }, { from: plusMonths(hire, 48), rate: pol.vac[1] }, { from: plusMonths(hire, 120), rate: pol.vac[2] }]);
  const months = (y - hy) * 12;
  const note = months < 36 ? `${pol.vac[0]} h/yr (under 4 years)` : months < 60 && plusMonths(hire, 48) >= `${y}-01-01` && plusMonths(hire, 48) <= `${y}-12-31` ? 'reaches 4 years – prorated'
    : months < 108 ? `${pol.vac[1]} h/yr (4+ years)` : plusMonths(hire, 120) >= `${y}-01-01` && plusMonths(hire, 120) <= `${y}-12-31` ? 'reaches 10 years – prorated' : `${pol.vac[2]} h/yr (10+ years)`;
  const endTier = plusMonths(hire, 120) <= `${y}-12-31` ? 3 : plusMonths(hire, 48) <= `${y}-12-31` ? 2 : 1;
  return { hours: h, note, tier: endTier };
}

// Jan 1 balance from the carry-over and this year's amount.
// PTO (staff and superintendents): topped up toward the cap, never above it.
// Vacation: full carry-over (already capped at year end) plus the year's amount – may exceed the cap.
function startingBalance(pol, type, kind, carry, grant) {
  if (kind === 'vacation') return carry + grant;
  const cap = type === 'superintendent' ? pol.supCap : pol.staffPtoCap;
  return Math.max(Math.min(cap, carry + grant), Math.min(carry, cap));
}

// What carries into next year from this year's ending balance, and any payout.
function yearEnd(pol, type, kind, left) {
  if (kind === 'vacation') return { carry: Math.min(left, pol.vacCap), paidOut: Math.max(left - pol.vacCap, 0) };
  const cap = type === 'superintendent' ? pol.supCap : pol.staffPtoCap;
  return { carry: Math.min(left, cap), paidOut: 0 };
}

module.exports = { policy, yearlyGrant, startingBalance, yearEnd, plusMonths };
