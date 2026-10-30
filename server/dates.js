'use strict';
// All dates are handled as 'YYYY-MM-DD' strings and computed in UTC so the
// server's time zone never shifts a work day.

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing s.
function weekStart(s) {
  const d = new Date(s + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  return addDays(s, -dow);
}

function weekDates(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
}

module.exports = { isDate, addDays, weekStart, weekDates, daysBetween };
