import test from 'node:test';
import assert from 'node:assert/strict';
import { AgendaEvent, isValid } from '@our-place/contracts';
import { googleInstant, normalizeGoogleEvent } from '../src/features/calendars/google-events.js';
import { GoogleCalendarProvider } from '../src/features/calendars/google-provider.js';
import { CalendarProviderError } from '../src/features/calendars/provider.js';
const tz = 'America/Toronto';
const window = { from: Date.parse('2026-03-01T00:00:00Z'), until: Date.parse('2026-12-01T00:00:00Z') };
const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  etag: '"version1"',
  status: 'confirmed',
  summary: 'Fixture event',
  start: { dateTime: '2026-03-08T01:30:00-05:00', timeZone: tz },
  end: { dateTime: '2026-03-08T03:30:00-04:00', timeZone: tz },
  ...overrides,
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const isCode = (code: string) => (error: unknown) =>
  error instanceof CalendarProviderError && error.code === code;

test('calendar normalization preserves all-day exclusive dates and actual DST duration', () => {
  const timed = normalizeGoogleEvent(event(), tz)!;
  assert.ok(isValid(AgendaEvent, timed));
  assert.equal(timed.timing.kind, 'timed');
  if (timed.timing.kind === 'timed') assert.equal(timed.timing.endAt - timed.timing.startAt, 3600000);
  const allDay = normalizeGoogleEvent(
    event({ start: { date: '2026-03-08' }, end: { date: '2026-03-10' } }),
    tz,
  )!;
  assert.deepEqual(allDay.timing, { kind: 'all_day', startDate: '2026-03-08', endDate: '2026-03-10' });
  assert.ok(isValid(AgendaEvent, allDay));
  const unspecified = normalizeGoogleEvent(event({ endTimeUnspecified: true }), tz)!;
  assert.equal(unspecified.timing.kind === 'timed' && unspecified.timing.endUnspecified, true);
});

test('calendar instances retain original identity when moved; cancelled rows can omit timing', () => {
  const moved = normalizeGoogleEvent(
    event({
      id: 'event-instance',
      recurringEventId: 'series-1',
      originalStartTime: { dateTime: '2026-03-01T09:00:00-05:00' },
    }),
    tz,
  )!;
  assert.equal(moved.instanceKey, `instant:${Date.parse('2026-03-01T14:00:00Z')}`);
  assert.equal(moved.recurringEventId, 'series-1');
  const allDay = normalizeGoogleEvent(
    event({ recurringEventId: 'series-2', originalStartTime: { date: '2026-03-01' } }),
    tz,
  )!;
  assert.equal(allDay.instanceKey, 'date:2026-03-01');
  assert.equal(normalizeGoogleEvent({ id: 'cancelled-instance', status: 'cancelled' }, tz), null);
  assert.throws(
    () => normalizeGoogleEvent(event({ recurrence: ['RRULE:FREQ=WEEKLY'] }), tz),
    isCode('invalid_provider_response'),
  );
});

test('calendar projection drops attendee lists and active HTML while retaining self response and visibility', () => {
  const result = normalizeGoogleEvent(
    event({
      description: '<p>Bring &amp; share</p><script>hidden credential</script><p><b>Notes</b></p>',
      htmlLink: 'https://calendar.google.com/calendar/event?eid=fixture',
      visibility: 'private',
      transparency: 'transparent',
      attendees: [
        { email: 'other@example.com', comment: 'Never cached', responseStatus: 'accepted' },
        { self: true, email: 'me@example.com', responseStatus: 'declined' },
      ],
      conferenceData: { entryPoints: [{ password: 'Not projected' }] },
    }),
    tz,
  )!;
  assert.equal(result.description, 'Bring & share\nNotes');
  assert.equal(
    normalizeGoogleEvent(event({ description: 'Before<p>Middle <b>words</b></p>After<br><br>End' }), tz)!
      .description,
    'Before\nMiddle words\nAfter\n\nEnd',
  );
  assert.equal(result.participation, 'declined');
  assert.equal(result.visibility, 'private');
  assert.equal(result.busy, false);
  assert.equal(JSON.stringify(result).includes('example.com'), false);
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.equal(normalizeGoogleEvent(event({ htmlLink: 'javascript:alert(1)' }), tz)!.sourceUrl, null);
  assert.equal(
    normalizeGoogleEvent(event({ htmlLink: 'https://calendar.google.com.evil.example/event' }), tz)!
      .sourceUrl,
    null,
  );
  const credentialLink = new URL('https://calendar.google.com/event');
  credentialLink.username = 'synthetic-user';
  credentialLink.password = 'synthetic-password';
  assert.equal(normalizeGoogleEvent(event({ htmlLink: credentialLink.href }), tz)!.sourceUrl, null);
});

test('timezone-only wall times require a unique instant; malformed dates never normalize silently', () => {
  assert.equal(googleInstant('2026-03-08T01:30:00', tz), Date.parse('2026-03-08T06:30:00Z'));
  assert.equal(googleInstant('2026-07-08T01:30:00.123', tz), Date.parse('2026-07-08T05:30:00.123Z'));
  assert.equal(googleInstant('2026-01-01T12:00:00', 'Asia/Kathmandu'), Date.parse('2026-01-01T06:15:00Z'));
  for (const raw of [
    '2026-03-08T02:30:00',
    '2026-11-01T01:30:00',
    '2026-02-30T12:00:00Z',
    '2026-02-01T24:00:00Z',
    '2026-02-01T12:00:00+25:00',
  ])
    assert.throws(() => googleInstant(raw, tz), isCode('invalid_provider_response'), raw);
  assert.notEqual(
    googleInstant('2026-11-01T01:30:00-04:00', tz),
    googleInstant('2026-11-01T01:30:00-05:00', tz),
  );
  for (const overrides of [
    { start: { date: '2026-02-30' }, end: { date: '2026-03-02' } },
    { start: { date: '2026-03-08' }, end: { date: '2026-03-08' } },
    { start: { date: '2026-03-08', dateTime: '2026-03-08T12:00:00Z' }, end: { date: '2026-03-09' } },
    { end: { dateTime: '2026-03-07T01:30:00-05:00' } },
    { endTimeUnspecified: 'true' },
    { visibility: 'secret' },
  ])
    assert.throws(() => normalizeGoogleEvent(event(overrides), tz), isCode('invalid_provider_response'));
});

test('Google reader paginates the same expanded window and returns only a complete snapshot', async () => {
  const calls: URL[] = [];
  const provider = new GoogleCalendarProvider(async (url, init) => {
    calls.push(new URL(url));
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer synthetic-token');
    return response({
      timeZone: tz,
      items:
        calls.length === 1 ? [event()] : [event({ id: 'event-2' }), { id: 'removed', status: 'cancelled' }],
      ...(calls.length === 1 ? { nextPageToken: 'second-page' } : {}),
    });
  });
  const result = await provider.readEvents(
    'synthetic-token',
    'name/with?reserved#characters@example.com',
    window,
  );
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.window, window);
  assert.equal(result.timeZone, tz);
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.pathname.includes('name%2Fwith%3Freserved%23characters%40example.com'));
  for (const url of calls) {
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(url.searchParams.get('singleEvents'), 'true');
    assert.equal(url.searchParams.get('orderBy'), 'startTime');
    assert.equal(url.searchParams.get('showDeleted'), 'false');
    assert.equal(url.searchParams.get('timeMin'), new Date(window.from).toISOString());
  }
  assert.equal(calls[0]!.searchParams.has('pageToken'), false);
  assert.equal(calls[1]!.searchParams.get('pageToken'), 'second-page');
  const broken = new GoogleCalendarProvider(async (url) =>
    new URL(url).searchParams.has('pageToken')
      ? new Response('private provider diagnostic', { status: 503 })
      : response({ timeZone: tz, items: [event()], nextPageToken: 'next' }),
  );
  await assert.rejects(
    broken.readEvents('synthetic-token', 'fixture-calendar', window),
    isCode('provider_unavailable'),
  );
});

test('calendar discovery preserves owner-only source identity, role and timezone across pages', async () => {
  let calls = 0;
  const provider = new GoogleCalendarProvider(async () =>
    response(
      ++calls === 1
        ? {
            items: [
              {
                id: 'private-work@example.com',
                summary: 'Work',
                summaryOverride: 'My work',
                timeZone: tz,
                accessRole: 'reader',
                primary: true,
              },
            ],
            nextPageToken: 'second',
          }
        : {
            items: [
              { id: 'shared-fixture', summary: 'Household', timeZone: 'UTC', accessRole: 'writer' },
              { id: 'gone', deleted: true },
            ],
          },
    ),
  );
  const result = await provider.listCalendars('synthetic-token');
  assert.equal(result.length, 2);
  assert.equal(result[0]!.title, 'My work');
  assert.equal(result[0]!.primary, true);
  assert.equal(result[1]!.accessRole, 'writer');
  assert.equal(result[1]!.primary, false);
});

test('calendar limits, malformed responses, duplicate results and provider errors fail without leaking body text', async () => {
  for (const [status, code] of [
    [401, 'authentication_required'],
    [403, 'access_denied'],
    [404, 'calendar_unavailable'],
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ] as const) {
    const provider = new GoogleCalendarProvider(async () => new Response('sensitive diagnostic', { status }));
    await assert.rejects(provider.readEvents('synthetic-token', 'fixture-calendar', window), isCode(code));
  }
  for (const body of [
    { timeZone: tz, items: [event(), event()] },
    { timeZone: tz, items: 'bad' },
    { items: [] },
    { timeZone: tz, items: Array.from({ length: 10001 }, (_, i) => event({ id: String(i) })) },
  ]) {
    const provider = new GoogleCalendarProvider(async () => response(body));
    await assert.rejects(
      provider.readEvents('synthetic-token', 'fixture-calendar', window),
      (e) => e instanceof CalendarProviderError,
    );
  }
  let calls = 0;
  const loop = new GoogleCalendarProvider(async () => {
    calls++;
    return response({ timeZone: tz, items: [], nextPageToken: 'same' });
  });
  await assert.rejects(
    loop.readEvents('synthetic-token', 'fixture-calendar', window),
    isCode('calendar_limit'),
  );
  assert.equal(calls, 2);
  const oversized = new GoogleCalendarProvider(
    async () =>
      new Response('x', {
        headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
      }),
  );
  await assert.rejects(oversized.listCalendars('synthetic-token'), isCode('calendar_limit'));
  const invalid = new GoogleCalendarProvider(
    async () => new Response('secret diagnostic', { headers: { 'content-type': 'text/html' } }),
  );
  await assert.rejects(invalid.listCalendars('synthetic-token'), isCode('invalid_provider_response'));
  const thrown = new GoogleCalendarProvider(async () => {
    throw new Error('Authorization: secret token');
  });
  await assert.rejects(
    thrown.listCalendars('synthetic-token'),
    (e) => isCode('provider_unavailable')(e) && !(e as Error).message.includes('secret'),
  );
});

test('cancellation and invalid windows prevent requests', async () => {
  let calls = 0;
  const provider = new GoogleCalendarProvider(async () => {
    calls++;
    return response({ items: [] });
  });
  await assert.rejects(
    provider.readEvents('synthetic-token', 'fixture-calendar', { from: window.until, until: window.from }),
    RangeError,
  );
  await assert.rejects(
    provider.listCalendars('synthetic-token', AbortSignal.abort()),
    isCode('provider_unavailable'),
  );
  assert.equal(calls, 0);
});

test('streamed body limits and interruption fail without returning partial results', async () => {
  let cancelled = false;
  const large = new GoogleCalendarProvider(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await assert.rejects(large.listCalendars('synthetic-token'), isCode('calendar_limit'));
  assert.equal(cancelled, true);
  const interrupted = new GoogleCalendarProvider(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"items":['));
            controller.error(new Error('sensitive body transport diagnostic'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  await assert.rejects(interrupted.listCalendars('synthetic-token'), isCode('provider_unavailable'));
  const malformed = new GoogleCalendarProvider(
    async () => new Response('{broken', { headers: { 'content-type': 'application/json' } }),
  );
  await assert.rejects(malformed.listCalendars('synthetic-token'), isCode('invalid_provider_response'));
});

test('Google 403 quota errors stay retryable instead of being treated as lost calendar access', async () => {
  for (const reason of [
    'rateLimitExceeded',
    'userRateLimitExceeded',
    'quotaExceeded',
    'dailyLimitExceeded',
  ]) {
    const provider = new GoogleCalendarProvider(
      async () =>
        new Response(JSON.stringify({ error: { errors: [{ reason, message: 'Private diagnostic' }] } }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await assert.rejects(provider.listCalendars('synthetic-token'), isCode('rate_limited'));
  }
  const denied = new GoogleCalendarProvider(
    async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: 'insufficientPermissions' }] } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
  );
  await assert.rejects(denied.listCalendars('synthetic-token'), isCode('access_denied'));
});
