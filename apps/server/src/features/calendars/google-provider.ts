import type { AgendaEvent } from '@our-place/contracts';
import {
  CalendarProviderError,
  calendarWindow,
  type CalendarProvider,
  type CalendarWindow,
  type ProviderCalendar,
} from './provider.js';
import { fields, normalizeGoogleEvent, text, zone } from './google-events.js';
type Transport = (url: string, init: RequestInit) => Promise<Response>;
const api = 'https://www.googleapis.com/calendar/v3/';
const pageBytes = 4 * 1024 * 1024,
  totalBytes = 16 * 1024 * 1024,
  itemLimit = 10000,
  pageLimit = 80;
async function readJson(response: Response, signal: AbortSignal, limit: number) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
    throw new CalendarProviderError('invalid_provider_response');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new CalendarProviderError('calendar_limit');
  if (!response.body) throw new CalendarProviderError('invalid_provider_response');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new CalendarProviderError('calendar_limit');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new CalendarProviderError('invalid_provider_response');
  }
  return { body: fields(body), bytes: size };
}
/** Reads only fixed Google API endpoints. No redirects, token logging or partial successful results. */
export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly transport: Transport = fetch,
    private readonly timeoutMs = 20000,
  ) {}
  private async page(path: string, params: URLSearchParams, token: string, signal: AbortSignal) {
    if (!token || token.length > 16384 || /[\r\n]/.test(token))
      throw new CalendarProviderError('authentication_required');
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await this.transport(api + path + '?' + params.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal,
      });
      if (!response.ok) {
        if (
          response.status === 403 &&
          /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
        ) {
          const diagnostic = await readJson(response, signal, 65536),
            details = fields(diagnostic.body.error);
          const reasons = Array.isArray(details.errors)
            ? details.errors.slice(0, 100).map((item) => fields(item).reason)
            : [];
          if (
            reasons.some((reason) =>
              ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded'].includes(
                String(reason),
              ),
            )
          )
            throw new CalendarProviderError('rate_limited');
        }
        const code =
          response.status === 401
            ? 'authentication_required'
            : response.status === 403
              ? 'access_denied'
              : response.status === 404 || response.status === 410
                ? 'calendar_unavailable'
                : response.status === 429
                  ? 'rate_limited'
                  : 'provider_unavailable';
        throw new CalendarProviderError(code);
      }
      return await readJson(response, signal, pageBytes);
    } catch (error) {
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      if (error instanceof CalendarProviderError) throw error;
      // Provider/network errors can contain URLs or headers. Persist only an application code.
      throw new CalendarProviderError('provider_unavailable');
    }
  }
  private async collect(path: string, params: URLSearchParams, token: string, cancellation?: AbortSignal) {
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(cancellation ? [cancellation] : []),
    ]);
    const result: Record<string, unknown>[] = [],
      seen = new Set<string>();
    let bytes = 0,
      count = 0,
      pageToken = '';
    do {
      if (result.length >= pageLimit || seen.has(pageToken))
        throw new CalendarProviderError('calendar_limit');
      seen.add(pageToken);
      const query = new URLSearchParams(params);
      if (pageToken) query.set('pageToken', pageToken);
      const page = await this.page(path, query, token, signal);
      bytes += page.bytes;
      const items = page.body.items ?? [];
      if (!Array.isArray(items)) throw new CalendarProviderError('invalid_provider_response');
      count += items.length;
      if (bytes > totalBytes || count > itemLimit) throw new CalendarProviderError('calendar_limit');
      result.push(page.body);
      pageToken = text(page.body.nextPageToken, 8192);
    } while (pageToken);
    if (signal.aborted) throw new CalendarProviderError('provider_unavailable');
    return result;
  }
  async listCalendars(accessToken: string, cancellation?: AbortSignal): Promise<ProviderCalendar[]> {
    const pages = await this.collect(
      'users/me/calendarList',
      new URLSearchParams({ maxResults: '250', showDeleted: 'false', showHidden: 'true' }),
      accessToken,
      cancellation,
    );
    const calendars: ProviderCalendar[] = [],
      seen = new Set<string>();
    for (const page of pages)
      for (const raw of (page.items ?? []) as unknown[]) {
        const item = fields(raw);
        if (item.deleted === true) continue;
        const providerId = text(item.id, 2048, true),
          role = item.accessRole;
        if (seen.has(providerId) || !['owner', 'writer', 'reader', 'freeBusyReader'].includes(String(role)))
          throw new CalendarProviderError('invalid_provider_response');
        seen.add(providerId);
        if (item.primary !== undefined && typeof item.primary !== 'boolean')
          throw new CalendarProviderError('invalid_provider_response');
        calendars.push({
          providerId,
          title: text(item.summaryOverride ?? item.summary, 1000),
          timeZone: zone(item.timeZone),
          accessRole: role as ProviderCalendar['accessRole'],
          primary: item.primary === true,
        });
      }
    return calendars;
  }
  async readEvents(
    accessToken: string,
    providerCalendarId: string,
    window: CalendarWindow,
    cancellation?: AbortSignal,
  ) {
    text(providerCalendarId, 2048, true);
    window = calendarWindow(window);
    const pages = await this.collect(
      `calendars/${encodeURIComponent(providerCalendarId)}/events`,
      new URLSearchParams({
        timeMin: new Date(window.from).toISOString(),
        timeMax: new Date(window.until).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        showDeleted: 'false',
        maxResults: '250',
      }),
      accessToken,
      cancellation,
    );
    let timeZone: string | undefined;
    const events: AgendaEvent[] = [],
      seen = new Set<string>();
    for (const page of pages) {
      const currentZone = zone(page.timeZone);
      if (timeZone && timeZone !== currentZone) throw new CalendarProviderError('invalid_provider_response');
      timeZone = currentZone;
      for (const raw of (page.items ?? []) as unknown[]) {
        const event = normalizeGoogleEvent(raw, timeZone);
        if (!event) continue;
        const identity = JSON.stringify([event.eventId, event.instanceKey]);
        if (seen.has(identity)) throw new CalendarProviderError('invalid_provider_response');
        seen.add(identity);
        events.push(event);
      }
    }
    return { events, timeZone: timeZone!, window: { ...window } };
  }
}
