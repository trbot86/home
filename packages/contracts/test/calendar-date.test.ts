import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarDate,
  calendarDateAt,
  isCalendarDate,
  isTimeZone,
  nextAnchoredCalendarDate,
  type CalendarUnit,
} from '../src/calendar-date.js';
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
  assert.equal(addCalendarDate('2026-03-31', -1, 'months'), '2026-02-28');
  assert.equal(addCalendarDate('0001-01-01', 0, 'days'), '0001-01-01');
  assert.throws(() => addCalendarDate('9999-12-31', 1, 'days'), RangeError);
  assert.throws(() => addCalendarDate('0001-01-01', -1, 'days'), RangeError);
  assert.throws(() => addCalendarDate('2026-01-01', 1, 'years' as CalendarUnit), RangeError);
});

test('fixed schedules start at their anchor and advance strictly past a supplied cutoff', () => {
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 1, 'weeks', '2026-09-01'), '2026-09-09');
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 1, 'weeks', '2026-09-09'), '2026-09-16');
  // Both proposed late-reporting policies use the same arithmetic, with a
  // different cutoff chosen by the completion command.
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 1, 'weeks', '2026-09-10'), '2026-09-16');
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 1, 'weeks', '2026-09-21'), '2026-09-23');
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 2, 'weeks', '2026-09-16'), '2026-09-23');
  assert.equal(nextAnchoredCalendarDate('2026-09-09', 2, 'weeks', '2026-09-23'), '2026-10-07');
  assert.equal(nextAnchoredCalendarDate('2026-12-28', 1, 'weeks', '2027-01-03'), '2027-01-04');
  assert.equal(nextAnchoredCalendarDate('2026-12-28', 3, 'days', '2027-01-03'), '2027-01-06');
});

test('monthly slots return to the anchor day after short months, including leap years', () => {
  const cases: [string, number, string, string][] = [
    ['2026-01-31', 1, '2026-02-01', '2026-02-28'],
    ['2026-01-31', 1, '2026-02-28', '2026-03-31'],
    ['2026-01-31', 1, '2026-03-30', '2026-03-31'],
    ['2026-01-31', 1, '2026-04-30', '2026-05-31'],
    ['2026-01-31', 3, '2026-02-28', '2026-04-30'],
    ['2026-01-31', 3, '2026-04-30', '2026-07-31'],
    ['2024-01-31', 1, '2024-02-01', '2024-02-29'],
    ['2024-01-31', 1, '2024-02-29', '2024-03-31'],
    ['2024-02-29', 12, '2025-02-28', '2026-02-28'],
    ['2024-02-29', 12, '2027-02-28', '2028-02-29'],
    ['1896-02-29', 12, '1899-02-28', '1900-02-28'],
    ['1996-02-29', 12, '1999-02-28', '2000-02-29'],
    ['2096-02-29', 12, '2099-02-28', '2100-02-28'],
  ];
  for (const [anchor, count, after, expected] of cases)
    assert.equal(nextAnchoredCalendarDate(anchor, count, 'months', after), expected, `${anchor} / ${after}`);
});

test('fixed slots operate across the full supported civil-date range without walking missed slots', () => {
  assert.equal(nextAnchoredCalendarDate('0001-01-01', 1, 'days', '9999-12-30'), '9999-12-31');
  assert.equal(nextAnchoredCalendarDate('0001-01-31', 1, 'months', '9999-11-30'), '9999-12-31');
  assert.equal(nextAnchoredCalendarDate('0001-01-01', 1, 'weeks', '0001-01-01'), '0001-01-08');
  assert.equal(nextAnchoredCalendarDate('0099-12-31', 1, 'months', '0100-01-31'), '0100-02-28');
  for (const unit of ['days', 'weeks', 'months'] as const) {
    assert.throws(() => nextAnchoredCalendarDate('0001-01-01', 1, unit, '9999-12-31'), RangeError);
    assert.throws(() => nextAnchoredCalendarDate('9999-12-31', 1, unit, '9999-12-31'), RangeError);
  }
});

test('fixed slots reject malformed dates, nonpositive or oversized intervals and unsupported units', () => {
  for (const count of [0, -1, 0.5, NaN, Infinity, 36501, Number.MAX_SAFE_INTEGER])
    assert.throws(() => nextAnchoredCalendarDate('2026-01-01', count, 'days', '2026-01-02'), RangeError);
  for (const date of ['2026-02-29', '2026-04-31', '2026-1-01', '0000-01-01', '10000-01-01']) {
    assert.throws(() => nextAnchoredCalendarDate(date, 1, 'weeks', '2026-01-01'), RangeError);
    assert.throws(() => nextAnchoredCalendarDate('2026-01-01', 1, 'weeks', date), RangeError);
  }
  assert.throws(
    () => nextAnchoredCalendarDate('2026-01-01', 1, 'years' as CalendarUnit, '2026-01-02'),
    RangeError,
  );
});

test('fixed slots accept explicit household dates through daylight-saving boundaries', () => {
  const timeZone = 'America/Toronto';
  const beforeSpringMidnight = calendarDateAt(Date.parse('2026-03-09T03:30:00Z'), timeZone);
  assert.equal(nextAnchoredCalendarDate('2026-03-01', 1, 'weeks', beforeSpringMidnight), '2026-03-15');
  for (const instant of ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']) {
    const after = calendarDateAt(Date.parse(instant), timeZone);
    assert.equal(nextAnchoredCalendarDate('2026-10-25', 1, 'weeks', after), '2026-11-08');
  }
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
