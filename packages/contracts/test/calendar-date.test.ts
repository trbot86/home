import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDate, calendarDateAt, isCalendarDate, isTimeZone } from '../src/calendar-date.js';
test('civil dates reject normalization and add intervals with month-end clamping', () => {
  for (const valid of ['2024-02-29', '2026-01-31', '0001-01-01', '9999-12-31'])
    assert.equal(isCalendarDate(valid), true, valid);
  for (const invalid of [
    '2026-02-29',
    '2026-04-31',
    '2026-00-01',
    '2026-1-01',
    '0000-01-01',
    '2026-01-00',
    '2026-13-01',
  ])
    assert.equal(isCalendarDate(invalid), false, invalid);
  assert.equal(addCalendarDate('2024-01-31', 1, 'months'), '2024-02-29');
  assert.equal(addCalendarDate('2026-01-31', 1, 'months'), '2026-02-28');
  assert.equal(addCalendarDate('2024-02-29', 12, 'months'), '2025-02-28');
  assert.equal(addCalendarDate('2026-12-28', 1, 'weeks'), '2027-01-04');
  assert.equal(addCalendarDate('2026-03-01', -1, 'days'), '2026-02-28');
  assert.throws(() => addCalendarDate('9999-12-31', 1, 'days'), RangeError);
});
test('an explicit timezone supplies the actual completion date across DST and UTC boundaries', () => {
  assert.equal(isTimeZone('America/Toronto'), true);
  assert.equal(isTimeZone('invented/zone'), false);
  assert.equal(calendarDateAt(Date.parse('2026-03-09T03:30:00Z'), 'America/Toronto'), '2026-03-08');
  assert.equal(
    addCalendarDate(calendarDateAt(Date.parse('2026-03-09T03:30:00Z'), 'America/Toronto'), 1, 'days'),
    '2026-03-09',
  );
  assert.equal(calendarDateAt(Date.parse('2026-11-01T05:30:00Z'), 'America/Toronto'), '2026-11-01');
  assert.equal(calendarDateAt(Date.parse('2026-11-01T06:30:00Z'), 'America/Toronto'), '2026-11-01');
  assert.equal(calendarDateAt(Date.parse('2026-01-01T00:30:00Z'), 'America/Los_Angeles'), '2025-12-31');
});
