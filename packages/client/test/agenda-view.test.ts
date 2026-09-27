import test from 'node:test';
import assert from 'node:assert/strict';
import { agendaDays } from '../src/agenda-view.js';
import type { AgendaCalendarSnapshot, AgendaEvent, AgendaTiming } from '@our-place/contracts';
const event = (eventId: string, timing: AgendaTiming): AgendaEvent => ({
  eventId,
  timing,
  instanceKey: '',
  recurringEventId: null,
  providerVersion: '',
  title: eventId,
  description: '',
  location: '',
  sourceUrl: null,
  status: 'confirmed',
  participation: null,
  visibility: 'default',
  busy: true,
});
const calendar = (events: AgendaEvent[]): AgendaCalendarSnapshot => ({
  calendarId: 'fixture',
  scopeId: 'scope',
  context: 'home',
  title: 'Fixture',
  timeZone: 'America/Toronto',
  refreshedAt: null,
  lastAttemptAt: null,
  errorCode: null,
  window: null,
  events,
});
test('all-day dates stay civil and their exclusive end does not occupy the next day', () => {
  const days = agendaDays(
    [calendar([event('all day', { kind: 'all_day', startDate: '2026-03-08', endDate: '2026-03-10' })])],
    '2026-03-07',
    4,
    'Pacific/Honolulu',
  );
  assert.deepEqual(
    days.map((d) => d.events.length),
    [0, 1, 1, 0],
  );
});
test('DST nights, midnight ends and zero-duration events occupy the correct display dates', () => {
  const timed = (id: string, start: string, end: string) =>
    event(id, {
      kind: 'timed',
      startAt: Date.parse(start),
      endAt: Date.parse(end),
      timeZone: 'America/Toronto',
      endUnspecified: false,
    });
  const days = agendaDays(
    [
      calendar([
        timed('overnight', '2026-03-08T04:30:00Z', '2026-03-08T07:30:00Z'),
        timed('midnight-end', '2026-03-09T03:30:00Z', '2026-03-09T04:00:00Z'),
        timed('instant', '2026-03-09T04:00:00Z', '2026-03-09T04:00:00Z'),
      ]),
    ],
    '2026-03-07',
    3,
    'America/Toronto',
  );
  assert.deepEqual(
    days.map((d) => d.events.map((x) => x.event.eventId)),
    [['overnight'], ['overnight', 'midnight-end'], ['instant']],
  );
});
test('all-day cards sort before timed cards, and an invalid range is rejected', () => {
  const events = [
    event('later', {
      kind: 'timed',
      startAt: Date.parse('2026-03-08T15:00Z'),
      endAt: Date.parse('2026-03-08T16:00Z'),
      timeZone: 'UTC',
      endUnspecified: false,
    }),
    event('day', { kind: 'all_day', startDate: '2026-03-08', endDate: '2026-03-09' }),
  ];
  assert.deepEqual(
    agendaDays([calendar(events)], '2026-03-08', 1, 'UTC')[0]!.events.map((x) => x.event.eventId),
    ['day', 'later'],
  );
  assert.throws(() => agendaDays([], '2026-03-08', 100, 'UTC'), RangeError);
});
