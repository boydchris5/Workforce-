'use strict';
// Policy Manual §7.1 / §7.2 / §7.1(A): prorated only in the starting year; otherwise
// front-loaded on Jan 1 at the tier reached by Jan 1.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../server/leavepolicy');

const pol = L.policy({}, 2026);
const g = (type, kind, hire, y, tier) => L.yearlyGrant(pol, type, kind, hire, y, tier).hours;

test('office PTO: 56 h front-loaded, prorated only in the hire year', () => {
  assert.equal(g('staff', 'pto', '2015-03-01', 2026), 56);
  assert.equal(g('staff', 'pto', '2026-07-01', 2026), 28);
  assert.equal(g('staff', 'pto', '2026-07-01', 2027), 56);
});

test('vacation tiers: quarterly in the hire year, then the tier reached by Jan 1', () => {
  assert.equal(g('staff', 'vacation', '2026-05-15', 2026), 30); // hire year: 10 h per quarter left
  assert.equal(g('staff', 'vacation', '2024-02-10', 2026), 40);
  assert.equal(g('staff', 'vacation', '2022-07-01', 2026), 40); // reaches 4 years in July -> new tier next year
  assert.equal(g('staff', 'vacation', '2022-07-01', 2027), 80);
  assert.equal(g('staff', 'vacation', '2016-07-01', 2026), 80); // reaches 10 years in July
  assert.equal(g('staff', 'vacation', '2016-07-01', 2027), 120);
  assert.equal(g('staff', 'vacation', '2024-02-10', 2026, 3), 120); // tier set on the employee
});

test('superintendent PTO: prorated only the year eligibility starts', () => {
  assert.equal(g('superintendent', 'pto', '2026-03-01', 2026), 0); // not yet 1 year
  assert.equal(g('superintendent', 'pto', '2025-07-01', 2026), 20); // eligible July 1 -> prorated
  assert.equal(g('superintendent', 'pto', '2025-07-01', 2027), 40);
  assert.equal(g('superintendent', 'pto', '2021-07-01', 2026), 40); // reaches 5 years mid-year -> 80 next year
  assert.equal(g('superintendent', 'pto', '2021-07-01', 2027), 80);
});

test('superintendent PTO tier set on the employee overrides the hire date', () => {
  assert.equal(g('superintendent', 'pto', '2026-03-01', 2026, null), 0);
  assert.equal(L.yearlyGrant(pol, 'superintendent', 'pto', '2026-03-01', 2026, null, 2).hours, 80);
  assert.equal(L.yearlyGrant(pol, 'superintendent', 'pto', '2015-01-01', 2026, null, 0).hours, 0);
  assert.equal(L.yearlyGrant(pol, 'superintendent', 'pto', '2015-01-01', 2026, null, 1).hours, 40);
});

test('carry-over and caps', () => {
  assert.equal(L.startingBalance(pol, 'staff', 'pto', 160, 56), 216); // 160 carried + 56 = 216
  assert.equal(L.startingBalance(pol, 'staff', 'pto', 140, 56), 196);
  assert.equal(L.startingBalance(pol, 'superintendent', 'pto', 150, 40), 160); // superintendents never above 160
  assert.deepEqual(L.yearEnd(pol, 'staff', 'pto', 200), { carry: 160, paidOut: 0, forfeited: 40 });
  assert.equal(L.startingBalance(pol, 'staff', 'pto', 60, 56), 116);
  assert.equal(L.startingBalance(pol, 'staff', 'vacation', 160, 120), 280); // may start above the cap
  assert.deepEqual(L.yearEnd(pol, 'staff', 'vacation', 200), { carry: 160, paidOut: 40, forfeited: 0 });
  assert.deepEqual(L.yearEnd(pol, 'superintendent', 'pto', 175), { carry: 160, paidOut: 0, forfeited: 15 });
});
