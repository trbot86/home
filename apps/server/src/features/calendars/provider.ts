import type { AgendaEvent } from '@our-place/contracts';
export type CalendarWindow = { from: number; until: number };
export function calendarWindow(value: CalendarWindow): CalendarWindow {
  if (
    !Number.isSafeInteger(value.from) ||
    !Number.isSafeInteger(value.until) ||
    value.until <= value.from ||
    value.from < -62135596800000 ||
    value.until > 253402300799999 ||
    value.until - value.from > 366 * 86400000
  )
    throw new RangeError('Calendar window must be ordered and no longer than 366 days');
  return { ...value };
}
/** Provider IDs and discovery metadata remain visible only to the connection owner. */
export type ProviderCalendar = {
  providerId: string;
  title: string;
  timeZone: string;
  accessRole: 'reader' | 'writer' | 'owner' | 'freeBusyReader';
  primary: boolean;
};
export type CalendarEventSnapshot = { events: AgendaEvent[]; timeZone: string; window: CalendarWindow };
export type CalendarProviderErrorCode =
  | 'authentication_required'
  | 'access_denied'
  | 'calendar_unavailable'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invalid_provider_response'
  | 'calendar_limit';
export class CalendarProviderError extends Error {
  constructor(readonly code: CalendarProviderErrorCode) {
    super(code);
    this.name = 'CalendarProviderError';
  }
}
/** Returns complete results or fails. Token refresh and persistence belong to the connection owner. */
export interface CalendarProvider {
  listCalendars(accessToken: string, cancellation?: AbortSignal): Promise<ProviderCalendar[]>;
  readEvents(
    accessToken: string,
    providerCalendarId: string,
    window: CalendarWindow,
    cancellation?: AbortSignal,
  ): Promise<CalendarEventSnapshot>;
}
