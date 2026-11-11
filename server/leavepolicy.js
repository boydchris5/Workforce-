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
// ptoTier: a superintendent's PTO tier set by hand (0 = not yet eligible, 1, 2), or null = from hire date.
function yearlyGrant(pol, type, kind, hire, y, vacTier = null, ptoTier = null) {
  const hy = hire ? Number(hire.slice(0, 4)) : null;
  if (hire && hy > y) return { hours: 0, note: `hired ${hire}` };
  if (type === 'superintendent') {
    // §7.1(A): nothing until 1 year of service; 40 h/yr, then 80 h/yr after 5 years.
    // Only the year eligibility starts is prorated; otherwise the full year is front-loaded on
    // Jan 1, at the rate earned by Jan 1 (a step-up takes effect the next Jan 1).
    if (ptoTier !== null && ptoTier !== undefined && ptoTier !== '') {
      const t = Math.min(Math.max(Number(ptoTier), 0), 2);
      return { hours: t === 0 ? 0 : pol.sup[t - 1], note: `${['Not yet eligible', `Tier 1 (${pol.sup[0]} h)`, `Tier 2 (${pol.sup[1]} h)`][t]} – set on the employee`, tier: t };
    }
    if (!hire) return { hours: pol.sup[0], note: 'no hire date – using Tier 1 (set the tier or hire date on the employee)', missingHire: true, tier: 1 };
    const eligible = plusMonths(hire, 12);
    if (eligible > `${y}-12-31`) return { hours: 0, note: `eligible after 1 year of service (${eligible})`, tier: 0 };
    if (eligible > `${y}-01-01`) return { hours: Math.round(pol.sup[0] * shareFrom(y, eligible)), note: `first year eligible – prorated from ${eligible}`, tier: 1 };
    const five = plusMonths(hire, 60) <= `${y}-01-01`;
    return { hours: five ? pol.sup[1] : pol.sup[0], note: five ? `${pol.sup[1]} h/yr (5+ years)` : `${pol.sup[0]} h/yr (1–5 years; ${pol.sup[1]} h from Jan 1 after the 5-year anniversary)`, tier: five ? 2 : 1 };
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
  // After the hire year the full amount is front-loaded on Jan 1, at the tier reached by Jan 1
  // (a tier increase takes effect the Jan 1 after the anniversary).
  const jan1 = `${y}-01-01`;
  const tier = plusMonths(hire, 120) <= jan1 ? 3 : plusMonths(hire, 48) <= jan1 ? 2 : 1;
  const next = tier === 1 ? plusMonths(hire, 48) : tier === 2 ? plusMonths(hire, 120) : null;
  return { hours: pol.vac[tier - 1], note: `${tierNames[tier - 1]}${next && next <= `${y}-12-31` ? ` – next tier from Jan 1, ${y + 1}` : ''}`, tier };
}

// Jan 1 balance from the carry-over and this year's amount.
// PTO (staff and superintendents): topped up toward the cap, never above it.
// Vacation: full carry-over (already capped at year end) plus the year's amount – may exceed the cap.
function startingBalance(pol, type, kind, carry, grant) {
  // Office staff / PM PTO and vacation: the carry-over (capped at year end) plus the full year's
  // amount, so PTO can start at up to 160 + 56 = 216 and vacation up to 160 + 120 = 280.
  if (type !== 'superintendent') return carry + grant;
  // Superintendents (7.1(A)): never above the cap.
  return Math.max(Math.min(pol.supCap, carry + grant), Math.min(carry, pol.supCap));
}

// What carries into next year from this year's ending balance, and any payout.
// Vacation over the cap is paid out; PTO over the cap doesn't carry over and isn't paid (forfeited).
function yearEnd(pol, type, kind, left) {
  if (kind === 'vacation') return { carry: Math.min(left, pol.vacCap), paidOut: Math.max(left - pol.vacCap, 0), forfeited: 0 };
  const cap = type === 'superintendent' ? pol.supCap : pol.staffPtoCap;
  return { carry: Math.min(left, cap), paidOut: 0, forfeited: Math.max(left - cap, 0) };
}

module.exports = { policy, yearlyGrant, startingBalance, yearEnd, plusMonths };
