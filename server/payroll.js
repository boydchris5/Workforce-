'use strict';
const { weekStart } = require('./dates');

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Cost out a list of assignment rows.
 *
 * Hours used per row: verified actual hours when present, otherwise planned.
 * Overtime is assigned chronologically within each employee's Mon-Sun week:
 * once the week passes the OT threshold, every further hour is OT and is
 * charged to whichever project it was worked on.
 *
 * Wage cost   = regular * base + OT * base * ot_multiplier
 * Burden      = wage cost * burden % (payroll taxes, WC, insurance)
 * Fringe      = all hours * fringe rate (union benefits)
 */
function costAssignments(rows, pay, settings) {
  const threshold = Number(settings.ot_threshold_hours) || 40;
  const otMult = Number(settings.ot_multiplier) || 1.5;
  const defBurden = Number(settings.default_burden_pct) || 0;

  const sorted = [...rows].sort((a, b) =>
    a.employee_id - b.employee_id || a.work_date.localeCompare(b.work_date) || a.id - b.id);

  const weekly = new Map();
  return sorted.map((r) => {
    const hours = r.status === 'no_show' ? 0 : (r.actual_hours ?? r.planned_hours ?? 0);
    const key = `${r.employee_id}|${weekStart(r.work_date)}`;
    const before = weekly.get(key) || 0;
    weekly.set(key, before + hours);
    const reg = Math.max(0, Math.min(hours, threshold - before));
    const ot = hours - reg;

    const p = pay.get(r.employee_id) || { base_rate: 0, fringe_rate: 0, burden_pct: null };
    const burdenPct = p.burden_pct ?? defBurden;
    const wages = reg * p.base_rate + ot * p.base_rate * otMult;
    const burden = wages * burdenPct / 100;
    const fringe = hours * p.fringe_rate;
    return {
      ...r,
      hours,
      reg_hours: reg,
      ot_hours: ot,
      wages: round2(wages),
      burden: round2(burden),
      fringe: round2(fringe),
      total: round2(wages + burden + fringe),
      missing_rate: !p.base_rate,
    };
  });
}

function sumInto(map, key, init, c) {
  const t = map.get(key) || { ...init, hours: 0, reg_hours: 0, ot_hours: 0, wages: 0, burden: 0, fringe: 0, total: 0 };
  for (const f of ['hours', 'reg_hours', 'ot_hours', 'wages', 'burden', 'fringe', 'total']) t[f] = round2(t[f] + c[f]);
  map.set(key, t);
  return t;
}

module.exports = { costAssignments, sumInto, round2 };
