import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { googleIcalUrl, IcalProvider, parseIcal } from '../src/features/calendars/ical-provider.js';
import { IcalSubscriptions } from '../src/features/calendars/ical-subscriptions.js';
import { CalendarsRepository } from '../src/features/calendars/calendars.js';
import { CalendarSynchronizer } from '../src/features/calendars/synchronizer.js';
import { AccessService, type HumanRequestContext } from '../src/features/access/access.js';
import { openDatabase, migrate, initialiseInstallation, immediate } from '../src/infrastructure/database.js';
const window = { from: Date.parse('2026-03-01T00:00:00Z'), until: Date.parse('2026-04-01T00:00:00Z') };
const feed = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-TIMEZONE:America/Toronto',
  'BEGIN:VEVENT',
  'UID:meeting',
  'DTSTART;TZID=America/Toronto:20260302T090000',
  'DTEND;TZID=America/Toronto:20260302T100000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'EXDATE;TZID=America/Toronto:20260316T090000',
  'SUMMARY:Weekly meeting',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:holiday',
  'DTSTART;VALUE=DATE:20260308',
  'DTEND;VALUE=DATE:20260310',
  'SUMMARY:Two days',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancel',
  'DTSTART:20260312T140000Z',
  'DTEND:20260312T150000Z',
  'STATUS:CANCELLED',
  'SUMMARY:Cancelled',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');
const url = 'https://calendar.google.com/calendar/ical/example%40example.com/private-fixture/basic.ics';
test('iCal preserves civil dates and recurring wall times across DST and excludes cancellations', async () => {
  const result = await parseIcal(feed, window);
  assert.equal(result.timeZone, 'America/Toronto');
  assert.equal(result.events.length, 4);
  const weekly = result.events.filter((e) => e.title === 'Weekly meeting');
  assert.deepEqual(
    weekly.map((e) => e.timing.kind === 'timed' && new Date(e.timing.startAt).toISOString()),
    ['2026-03-02T14:00:00.000Z', '2026-03-09T13:00:00.000Z', '2026-03-23T13:00:00.000Z'],
  );
  assert.deepEqual(result.events.find((e) => e.title === 'Two days')!.timing, {
    kind: 'all_day',
    startDate: '2026-03-08',
    endDate: '2026-03-10',
  });
  await assert.rejects(parseIcal('<html>Sign in</html>', window));
});
test('iCal fetch rejects arbitrary destinations, oversized feeds and redirects', async () => {
  assert.equal(googleIcalUrl(url), url);
  for (const bad of [
    'http://calendar.google.com/calendar/ical/a/public/basic.ics',
    'https://localhost/a.ics',
    url + '?x=1',
    'https://calendar.google.com.evil.example/a.ics',
  ])
    assert.throws(() => googleIcalUrl(bad));
  const provider = new IcalProvider(async (_url, options) => {
    assert.equal(options?.redirect, 'error');
    return new Response('x'.repeat(5 * 1024 * 1024 + 1));
  });
  await assert.rejects(provider.read(url, window));
});
test('iCal connections deduplicate, hide URLs, enforce sharing, refresh without OAuth and purge credentials on disconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'our-place-ical-')),
    db = openDatabase(join(root, 'db.sqlite'));
  try {
    migrate(db);
    initialiseInstallation(db);
    const access = new AccessService(db, Date.now);
    const people = ['Alex', 'Sam'].map((name) => {
      const c: HumanRequestContext = {
        kind: 'browser',
        personId: randomUUID(),
        clientId: randomUUID(),
        credentialId: randomUUID(),
      };
      db.prepare(
        'INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)',
      ).run(c.personId, name, name, 'fixture');
      db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), c.personId);
      return c;
    });
    const a = people[0]!,
      b = people[1]!,
      repo = new CalendarsRepository(db, access, Date.now);
    let fail = false;
    const provider = new IcalProvider(async () => {
      if (fail) throw Error('private transport details');
      return new Response(feed);
    });
    const service = new IcalSubscriptions(db, repo, provider),
      sync = new CalendarSynchronizer(db, repo, service.credentials(), service.events());
    const result = await service.connect(a, 'Work', url);
    assert.deepEqual(await service.connect(a, 'Work', url), result);
    assert.equal(repo.ownerConnections(a).length, 1);
    assert.equal(repo.ownerConnections(b).length, 0);
    assert.ok(!JSON.stringify(repo.ownerConnections(a)).includes('private-fixture'));
    const calendar = repo.ownerCalendars(a, result.connectionId)[0]!;
    assert.equal(calendar.scopeId, null);
    const scope = access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
    immediate(db, () => repo.setSelection(a, calendar.calendarId, calendar.revision, scope, 'work'));
    assert.equal((await sync.refresh(calendar.calendarId, window)).status, 'applied');
    assert.equal(repo.agenda(a, true).calendars[0]!.events.length, 4);
    assert.equal(repo.agenda(b, true).calendars.length, 0);
    fail = true;
    assert.equal((await sync.refresh(calendar.calendarId, window)).status, 'failed');
    assert.equal(repo.agenda(a, true).calendars[0]!.events.length, 4);
    immediate(db, () => repo.disconnect(a, result.connectionId, 1));
    assert.equal(db.prepare('SELECT * FROM calendar_ical_credentials').all().length, 0);
    assert.equal(repo.agenda(a, true).calendars.length, 0);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
