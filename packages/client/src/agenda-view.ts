import {
  addCalendarDate,
  calendarDateAt,
  type AgendaCalendarSnapshot,
  type AgendaEvent,
} from '@our-place/contracts';

export type AgendaDay = { date: string; events: { calendar: AgendaCalendarSnapshot; event: AgendaEvent }[] };
/** All-day ends and timed ends are exclusive; overnight events appear on every day they occupy. */
export function agendaDays(
  calendars: AgendaCalendarSnapshot[],
  start: string,
  count: number,
  timeZone: string,
): AgendaDay[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 31) throw new RangeError('Invalid agenda range');
  const days = Array.from(
    { length: count },
    (_, offset) => ({ date: addCalendarDate(start, offset, 'days'), events: [] }) as AgendaDay,
  );
  for (const calendar of calendars)
    for (const event of calendar.events) {
      const timing = event.timing;
      const first = timing.kind === 'all_day' ? timing.startDate : calendarDateAt(timing.startAt, timeZone);
      const last =
        timing.kind === 'all_day'
          ? addCalendarDate(timing.endDate, -1, 'days')
          : calendarDateAt(Math.max(timing.startAt, timing.endAt - 1), timeZone);
      for (const day of days) if (day.date >= first && day.date <= last) day.events.push({ calendar, event });
    }
  for (const day of days)
    day.events.sort((a, b) => {
      const at = a.event.timing,
        bt = b.event.timing;
      return (
        (at.kind === 'all_day' ? 0 : 1) - (bt.kind === 'all_day' ? 0 : 1) ||
        (at.kind === 'timed' ? at.startAt : 0) - (bt.kind === 'timed' ? bt.startAt : 0) ||
        a.event.title.localeCompare(b.event.title) ||
        a.calendar.calendarId.localeCompare(b.calendar.calendarId) ||
        a.event.eventId.localeCompare(b.event.eventId)
      );
    });
  return days;
}
