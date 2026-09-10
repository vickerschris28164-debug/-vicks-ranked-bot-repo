const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWeekdayList, computeNextOccurrence } = require('../event-scheduler');

test('parseWeekdayList normalizes weekday names and removes duplicates', () => {
  assert.deepEqual(parseWeekdayList('mon, wed, fri'), [1, 3, 5]);
  assert.deepEqual(parseWeekdayList('Thu Thurs, sunday'), [0, 4]);
  assert.deepEqual(parseWeekdayList(''), []);
});

test('computeNextOccurrence returns the first future matching weekday and time', () => {
  const from = Date.UTC(2026, 0, 5, 9, 0, 0); // Monday 2026-01-05 09:00 UTC
  const next = computeNextOccurrence(from, [1, 3, 5], '18:00');

  assert.equal(next, Date.UTC(2026, 0, 5, 18, 0, 0));
});

test('computeNextOccurrence skips times that already passed that day', () => {
  const from = Date.UTC(2026, 0, 5, 20, 0, 0); // Monday 20:00 UTC
  const next = computeNextOccurrence(from, [1, 3, 5], '18:00');

  assert.equal(next, Date.UTC(2026, 0, 7, 18, 0, 0));
});
