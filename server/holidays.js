'use strict';
// Union holidays. When a fixed-date holiday lands on a Saturday it is observed
// the Friday before; on a Sunday, the Monday after.
const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

// nth weekday (0 = Sunday) of a month; n = -1 for the last one.
function nthWeekday(y, m, weekday, n) {
  if (n > 0) {
    const first = dow(y, m, 1);
    return iso(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = dow(y, m, lastDay);
  return iso(y, m, lastDay - ((last - weekday + 7) % 7));
}

function observed(y, m, d) {
  const w = dow(y, m, d);
  const t = new Date(Date.UTC(y, m - 1, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return t.toISOString().slice(0, 10);
}

// Holidays observed in calendar year `year` (New Year's Day of the next year can
// be observed on Dec 31 of this one).
function holidaysForYear(year) {
  const list = [];
  for (const y of [year, year + 1]) {
    list.push(
      { date: observed(y, 1, 1), name: "New Year's Day" },
      { date: nthWeekday(y, 5, 1, -1), name: 'Memorial Day' },
      { date: observed(y, 7, 4), name: 'Independence Day' },
      { date: nthWeekday(y, 9, 1, 1), name: 'Labor Day' },
      { date: observed(y, 11, 11), name: 'Veterans Day' },
      { date: nthWeekday(y, 11, 4, 4), name: 'Thanksgiving Day' },
      { date: observed(y, 12, 25), name: 'Christmas Day' },
    );
  }
  return list.filter((h) => h.date.startsWith(String(year))).sort((a, b) => a.date.localeCompare(b.date));
}

// Holidays between two dates (inclusive) as { 'YYYY-MM-DD': 'Name' }.
function holidayMap(start, end) {
  const out = {};
  for (let y = Number(start.slice(0, 4)); y <= Number(end.slice(0, 4)); y++) {
    for (const h of holidaysForYear(y)) if (h.date >= start && h.date <= end) out[h.date] = h.name;
  }
  return out;
}

module.exports = { holidaysForYear, holidayMap };
