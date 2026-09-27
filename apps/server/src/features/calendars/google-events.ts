import { parseFragment } from 'parse5';
import { isCalendarDate, isTimeZone, type AgendaEvent, type AgendaTiming } from '@our-place/contracts';
import { CalendarProviderError } from './provider.js';
type Fields = Record<string, unknown>;
export function fields(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CalendarProviderError('invalid_provider_response');
  return value as Fields;
}
export function text(value: unknown, max: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.length))
    throw new CalendarProviderError('invalid_provider_response');
  return value;
}
export function zone(value: unknown): string {
  const result = text(value, 100, true);
  if (!isTimeZone(result)) throw new CalendarProviderError('invalid_provider_response');
  return result;
}
function flag(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new CalendarProviderError('invalid_provider_response');
  return value;
}
/** A timezone-only wall time must identify one instant; ambiguous/gap times require an offset. */
export function googleInstant(value: unknown, timeZone?: unknown): number {
  const raw = text(value, 100, true);
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (
    !match ||
    !isCalendarDate(match[1]!) ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59
  )
    throw new CalendarProviderError('invalid_provider_response');
  const offset = match[6];
  if (offset) {
    if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59))
      throw new CalendarProviderError('invalid_provider_response');
    const instant = Date.parse(raw);
    if (!Number.isFinite(instant) || instant < -62135596800000 || instant > 253402300799999)
      throw new CalendarProviderError('invalid_provider_response');
    return instant;
  }
  const tz = zone(timeZone),
    wall = Date.parse(raw + 'Z');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const civil = (instant: number) => {
    const parts = formatter.formatToParts(instant);
    const at = (key: string) => parts.find((p) => p.type === key)!.value;
    return `${at('year').padStart(4, '0')}-${at('month')}-${at('day')}T${at('hour')}:${at('minute')}:${at('second')}`;
  };
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = Math.floor((wall + hours * 3600000) / 1000) * 1000;
    offsets.add(Date.parse(civil(sample) + 'Z') - sample);
  }
  const matches = [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => civil(instant) === raw.slice(0, 19));
  if (matches.length !== 1 || matches[0]! < -62135596800000 || matches[0]! > 253402300799999)
    throw new CalendarProviderError('invalid_provider_response');
  return matches[0]!;
}
function description(html: string): string {
  const root = parseFragment(html),
    stack: ((typeof root.childNodes)[number] | '\n')[] = [...root.childNodes].reverse(),
    pieces: string[] = [];
  const newline = () => {
    if (pieces.length && !pieces.at(-1)!.endsWith('\n')) pieces.push('\n');
  };
  while (stack.length) {
    const node = stack.pop()!;
    if (node === '\n') newline();
    else if (node.nodeName === '#text' && 'value' in node) pieces.push(node.value);
    else if ('tagName' in node && !['script', 'style', 'template'].includes(node.tagName)) {
      if (node.tagName === 'br') pieces.push('\n');
      else if (
        ['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote'].includes(node.tagName)
      ) {
        newline();
        stack.push('\n');
      }
      stack.push(...node.childNodes.slice().reverse());
    }
  }
  return pieces
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function webLink(value: unknown): string | null {
  const raw = text(value, 4096);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.href.length <= 4096 &&
      ['calendar.google.com', 'www.google.com', 'google.com'].includes(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
/** Google expanded events -> provider-neutral data; cancelled rows disappear on snapshot replacement. */
export function normalizeGoogleEvent(value: unknown, calendarTimeZone: string): AgendaEvent | null {
  const event = fields(value),
    eventId = text(event.id, 2048, true);
  if (event.status === 'cancelled') return null;
  if (event.status !== 'confirmed' && event.status !== 'tentative')
    throw new CalendarProviderError('invalid_provider_response');
  if (event.recurrence !== undefined) throw new CalendarProviderError('invalid_provider_response');
  const start = fields(event.start),
    end = fields(event.end);
  const timeZone = zone(start.timeZone ?? calendarTimeZone);
  let timing: AgendaTiming;
  if (start.date !== undefined || end.date !== undefined) {
    const startDate = text(start.date, 10, true),
      endDate = text(end.date, 10, true);
    if (
      start.dateTime !== undefined ||
      end.dateTime !== undefined ||
      !isCalendarDate(startDate) ||
      !isCalendarDate(endDate) ||
      endDate <= startDate
    )
      throw new CalendarProviderError('invalid_provider_response');
    timing = { kind: 'all_day', startDate, endDate };
  } else {
    const startAt = googleInstant(start.dateTime, start.timeZone ?? calendarTimeZone),
      endAt = googleInstant(end.dateTime, end.timeZone ?? calendarTimeZone);
    if (endAt < startAt) throw new CalendarProviderError('invalid_provider_response');
    timing = { kind: 'timed', startAt, endAt, timeZone, endUnspecified: flag(event.endTimeUnspecified) };
  }
  const recurringEventId =
    event.recurringEventId === undefined ? null : text(event.recurringEventId, 2048, true);
  let instanceKey = '';
  if (recurringEventId) {
    const original = fields(event.originalStartTime);
    if (original.date !== undefined) {
      const date = text(original.date, 10, true);
      if (!isCalendarDate(date) || original.dateTime !== undefined)
        throw new CalendarProviderError('invalid_provider_response');
      instanceKey = `date:${date}`;
    } else instanceKey = `instant:${googleInstant(original.dateTime, original.timeZone ?? calendarTimeZone)}`;
  } else if (event.originalStartTime !== undefined)
    throw new CalendarProviderError('invalid_provider_response');
  let participation: AgendaEvent['participation'] = null;
  if (event.attendees !== undefined) {
    if (!Array.isArray(event.attendees) || event.attendees.length > 10000)
      throw new CalendarProviderError('invalid_provider_response');
    for (const raw of event.attendees) {
      const attendee = fields(raw);
      if (attendee.self === true) {
        if (
          participation !== null ||
          !['accepted', 'declined', 'tentative', 'needsAction'].includes(String(attendee.responseStatus))
        )
          throw new CalendarProviderError('invalid_provider_response');
        participation = attendee.responseStatus as AgendaEvent['participation'];
      }
    }
  }
  const visibility = event.visibility ?? 'default';
  if (!['default', 'public', 'private', 'confidential'].includes(String(visibility)))
    throw new CalendarProviderError('invalid_provider_response');
  if (
    event.transparency !== undefined &&
    event.transparency !== 'opaque' &&
    event.transparency !== 'transparent'
  )
    throw new CalendarProviderError('invalid_provider_response');
  return {
    eventId,
    instanceKey,
    recurringEventId,
    providerVersion: text(event.etag, 2048),
    title: text(event.summary, 1000),
    description: description(text(event.description, 20000)),
    location: text(event.location, 4000),
    sourceUrl: webLink(event.htmlLink),
    status: event.status,
    participation,
    visibility: visibility as AgendaEvent['visibility'],
    busy: event.transparency !== 'transparent',
    timing,
  };
}
