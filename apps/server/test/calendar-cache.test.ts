import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, initialiseInstallation, immediate } from '../src/infrastructure/database.js';
import { AccessService, type HumanRequestContext } from '../src/features/access/access.js';
import { CalendarsRepository } from '../src/features/calendars/calendars.js';
import { CalendarSynchronizer } from '../src/features/calendars/synchronizer.js';
import { CalendarWorker } from '../src/features/calendars/worker.js';
import { CalendarProviderError } from '../src/features/calendars/provider.js';
import { normalizeGoogleEvent } from '../src/features/calendars/google-events.js';
import type { CalendarEventSnapshot, ProviderCalendar } from '../src/features/calendars/provider.js';
import { NotFound, Rejection, Unauthenticated } from '../src/application/errors.js';
import { migrationsRoot } from '../src/paths.js';
const window = { from: Date.parse('2026-03-01T00:00:00Z'), until: Date.parse('2026-04-01T00:00:00Z') };
const source: ProviderCalendar = {
  providerId: 'fixture-calendar@example.com',
  title: 'Fixture calendar',
  timeZone: 'America/Toronto',
  accessRole: 'owner',
  primary: true,
};
const event = (id = 'one', visibility = 'default') =>
  normalizeGoogleEvent(
    {
      id,
      status: 'confirmed',
      summary: `Event ${id}`,
      description: 'Fixture details',
      visibility,
      start: { date: '2026-03-08' },
      end: { date: '2026-03-09' },
    },
    source.timeZone,
  )!;
const snapshot = (events = [event()]): CalendarEventSnapshot => ({
  events,
  timeZone: source.timeZone,
  window,
});
function fixture(migrationPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'our-place-calendar-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationPath);
  initialiseInstallation(db);
  let tick = Date.parse('2026-03-01T12:00:00Z');
  const now = () => ++tick,
    access = new AccessService(db, now);
  const people = ['Alex', 'Sam'].map((name) => {
    const context: HumanRequestContext = {
      personId: randomUUID(),
      clientId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    };
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      context.personId,
      name,
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      context.clientId,
      context.personId,
    );
    const scopeId = randomUUID();
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(scopeId, context.personId);
    return { context, scopeId };
  });
  const [a, b] = people as [(typeof people)[number], (typeof people)[number]],
    shared = (
      db.prepare("SELECT scope_id FROM visibility_scopes WHERE kind='shared'").get() as { scope_id: string }
    ).scope_id;
  const repo = new CalendarsRepository(db, access, now),
    write = <T>(f: () => T) => immediate(db, f);
  const create = () => {
    const connectionId = write(() => repo.registerConnection(a.context, 'Work account', randomUUID()));
    const discovery = write(() => repo.prepareDiscovery(connectionId))!;
    write(() => repo.publishDiscovery(discovery, [source]));
    return { connectionId, calendarId: repo.ownerCalendars(a.context, connectionId)[0]!.calendarId };
  };
  return {
    db,
    a,
    b,
    shared,
    repo,
    write,
    create,
    now,
    advance: (milliseconds: number) => {
      tick += milliseconds;
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('scheduled calendar refresh survives restart, backs off errors and skips unselected/disconnected sources', async () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    let reads = 0,
      fail = false;
    const synchronizer = new CalendarSynchronizer(
      f.db,
      f.repo,
      { accessToken: async () => 'synthetic-token' },
      {
        listCalendars: async () => [source],
        readEvents: async (_token, _id, selectedWindow) => {
          reads++;
          assert.equal(f.db.inTransaction, false);
          assert.equal(selectedWindow.until - selectedWindow.from, 70 * 86400000);
          if (fail) throw new CalendarProviderError('rate_limited');
          return { ...snapshot(), window: selectedWindow };
        },
      },
    );
    const worker = new CalendarWorker(f.repo, synchronizer, f.now);
    assert.equal(await worker.tick(), false);
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.a.scopeId, 'work'));
    const first = worker.tick();
    assert.equal(worker.tick(), first);
    assert.equal(await first, true);
    assert.equal(reads, 1);
    await worker.stop();
    const restarted = new CalendarWorker(f.repo, synchronizer, f.now);
    assert.equal(await restarted.tick(), false);
    f.advance(600000);
    fail = true;
    assert.equal(await restarted.tick(), true);
    assert.equal(f.repo.agenda(f.a.context, true).calendars[0]!.events.length, 1);
    f.advance(600000);
    assert.equal(await restarted.tick(), false);
    f.advance(1200000);
    fail = false;
    assert.equal(await restarted.tick(), true);
    assert.equal(reads, 3);
    f.write(() => f.repo.disconnect(f.a.context, connectionId, 1));
    f.advance(86400000);
    assert.equal(await restarted.tick(), false);
    await restarted.stop();
  } finally {
    f.close();
  }
});

test('stopping calendar work aborts network work and waits for its guarded completion', async () => {
  const f = fixture();
  try {
    const { calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.shared, 'home'));
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const sync = new CalendarSynchronizer(
      f.db,
      f.repo,
      { accessToken: async () => 'fixture' },
      {
        listCalendars: async () => [source],
        readEvents: async (_token, _id, _window, signal) =>
          new Promise((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(new Error('test-only abort')), { once: true });
            started();
          }),
      },
    );
    const worker = new CalendarWorker(f.repo, sync, f.now),
      work = worker.tick();
    await entered;
    await worker.stop();
    assert.equal(await work, true);
    assert.equal(f.repo.snapshot(f.a.context)[0]!.events.length, 0);
  } finally {
    f.close();
  }
});

test('oversized agenda projection fails visibly without disclosing private events or modifying stored data', () => {
  const f = fixture();
  try {
    const { calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.shared, 'home'));
    const lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    const events = Array.from({ length: 440 }, (_, i) => ({
      ...event(`private-${i}`, 'private'),
      description: 'x'.repeat(20000),
    }));
    f.write(() => f.repo.publishRefresh(lease, snapshot(events)));
    const a = f.repo.agenda(f.a.context, true),
      b = f.repo.agenda(f.b.context, true);
    assert.equal(a.issue, 'calendar_limit');
    assert.deepEqual(a.calendars, []);
    assert.equal(b.issue, null);
    assert.deepEqual(b.calendars[0]!.events, []);
    assert.equal(f.repo.snapshot(f.a.context)[0]!.events.length, 440);
  } finally {
    f.close();
  }
});

test('calendar discovery is owner-only, selection is explicit and shared projections omit private events', () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    assert.deepEqual(f.repo.snapshot(f.a.context), []);
    assert.deepEqual(f.repo.ownerConnections(f.b.context), []);
    assert.throws(() => f.repo.ownerCalendars(f.b.context, connectionId), NotFound);
    assert.throws(
      () => f.write(() => f.repo.setSelection(f.b.context, calendarId, 1, f.shared, 'home')),
      NotFound,
    );
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.a.scopeId, 'work'));
    let lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.publishRefresh(lease, snapshot()));
    assert.equal(f.repo.snapshot(f.a.context)[0]!.events.length, 1);
    assert.deepEqual(f.repo.snapshot(f.b.context), []);
    assert.throws(
      () => f.write(() => f.repo.setSelection(f.a.context, calendarId, 2, f.shared, 'work')),
      (e) => e instanceof Rejection && e.code === 'work_calendar_must_be_private',
    );
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 2, f.shared, 'home'));
    assert.equal(f.repo.snapshot(f.b.context)[0]!.events.length, 0);
    assert.equal(
      f.write(() => f.repo.publishRefresh(lease, snapshot())),
      false,
    );
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() =>
      f.repo.publishRefresh(
        lease,
        snapshot([event('shared'), event('private', 'private'), event('confidential', 'confidential')]),
      ),
    );
    assert.equal(f.repo.snapshot(f.a.context)[0]!.events.length, 3);
    const partner = f.repo.snapshot(f.b.context);
    assert.deepEqual(
      partner[0]!.events.map((e) => e.title),
      ['Event shared'],
    );
    assert.equal(JSON.stringify(partner).includes(source.providerId), false);
    assert.equal(JSON.stringify(f.repo.ownerConnections(f.a.context)).includes('credentialRef'), false);
    assert.throws(
      () => f.db.prepare('UPDATE calendars SET scope_id=? WHERE calendar_id=?').run(f.b.scopeId, calendarId),
      /scope owner mismatch/,
    );
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE calendar_connections SET owner_person_id=? WHERE connection_id=?')
          .run(f.b.context.personId, connectionId),
      /immutable/,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('newer refreshes, changed selections and disconnect invalidate in-flight publication', () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.a.scopeId, 'work'));
    const old = f.write(() => f.repo.prepareRefresh(calendarId, window))!,
      newer = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    assert.equal(
      f.write(() => f.repo.publishRefresh(old, snapshot([event('old')]))),
      false,
    );
    assert.equal(
      f.write(() => f.repo.publishRefresh(newer, snapshot([event('new')]))),
      true,
    );
    assert.equal(
      f.write(() => f.repo.failRefresh(old, 'access_denied')),
      false,
    );
    assert.equal(f.repo.snapshot(f.a.context)[0]!.events[0]!.eventId, 'new');
    const pending = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 2, null, 'work'));
    assert.equal(
      f.write(() => f.repo.publishRefresh(pending, snapshot())),
      false,
    );
    assert.deepEqual(f.repo.snapshot(f.a.context), []);
    const discovery = f.write(() => f.repo.prepareDiscovery(connectionId))!;
    f.write(() => f.repo.disconnect(f.a.context, connectionId, 1));
    assert.equal(
      f.write(() => f.repo.publishDiscovery(discovery, [source])),
      false,
    );
    assert.equal(
      f.write(() => f.repo.publishRefresh(pending, snapshot())),
      false,
    );
    assert.equal(f.repo.ownerCalendars(f.a.context, connectionId).length, 0);
    assert.equal(f.repo.ownerConnections(f.a.context)[0]!.state, 'disconnected');
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_event_cache').get() as { n: number }).n, 0);
  } finally {
    f.close();
  }
});

test('transient refresh errors keep the previous snapshot; lost access and expired authorization suppress it', () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.shared, 'home'));
    let lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.publishRefresh(lease, snapshot()));
    const before = f.repo.snapshot(f.b.context)[0]!;
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.failRefresh(lease, 'provider_unavailable'));
    let after = f.repo.snapshot(f.b.context)[0]!;
    assert.deepEqual(after.events, before.events);
    assert.equal(after.refreshedAt, before.refreshedAt);
    assert.equal(after.errorCode, 'provider_unavailable');
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.failRefresh(lease, 'access_denied'));
    after = f.repo.snapshot(f.b.context)[0]!;
    assert.deepEqual(after.events, []);
    assert.equal(after.refreshedAt, null);
    assert.equal(after.errorCode, 'access_denied');
    assert.equal(
      f.write(() => f.repo.publishRefresh(lease, snapshot())),
      false,
    );
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.publishRefresh(lease, snapshot()));
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.failRefresh(lease, 'authentication_required'));
    assert.deepEqual(f.repo.snapshot(f.b.context), []);
    assert.deepEqual(f.repo.snapshot(f.a.context), []);
    assert.equal(f.repo.ownerConnections(f.a.context)[0]!.state, 'needs_auth');
    assert.equal(
      f.write(() => f.repo.prepareDiscovery(connectionId)),
      null,
    );
  } finally {
    f.close();
  }
});

test('only the latest discovery applies; role loss clears selection and source removal clears its cache', () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.shared, 'home'));
    const refresh = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.publishRefresh(refresh, snapshot()));
    const stale = f.write(() => f.repo.prepareDiscovery(connectionId))!,
      current = f.write(() => f.repo.prepareDiscovery(connectionId))!;
    assert.equal(
      f.write(() => f.repo.publishDiscovery(stale, [])),
      false,
    );
    f.write(() => f.repo.publishDiscovery(current, [{ ...source, accessRole: 'reader' }]));
    assert.deepEqual(f.repo.snapshot(f.b.context)[0]!.events, []);
    assert.equal(
      f.write(() => f.repo.publishRefresh(refresh, snapshot())),
      false,
    );
    const restricted = f.write(() => f.repo.prepareDiscovery(connectionId))!;
    f.write(() => f.repo.publishDiscovery(restricted, [{ ...source, accessRole: 'freeBusyReader' }]));
    assert.deepEqual(f.repo.snapshot(f.b.context), []);
    const selected = f.repo.ownerCalendars(f.a.context, connectionId)[0]!;
    assert.equal(selected.scopeId, null);
    assert.throws(
      () => f.write(() => f.repo.setSelection(f.a.context, calendarId, selected.revision, f.shared, 'home')),
      (e) => e instanceof Rejection && e.code === 'calendar_details_unavailable',
    );
    const removal = f.write(() => f.repo.prepareDiscovery(connectionId))!;
    f.write(() => f.repo.publishDiscovery(removal, []));
    assert.equal(f.repo.ownerCalendars(f.a.context, connectionId).length, 0);
  } finally {
    f.close();
  }
});

test('cache replacement is atomic, rejects invalid events and cannot run outside a transaction or as an integration', () => {
  const f = fixture();
  try {
    const { calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.a.scopeId, 'work'));
    let lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.write(() => f.repo.publishRefresh(lease, snapshot()));
    const before = f.repo.snapshot(f.a.context)[0]!;
    lease = f.write(() => f.repo.prepareRefresh(calendarId, window))!;
    f.db.exec(
      "CREATE TRIGGER calendar_test_failure BEFORE INSERT ON calendar_event_cache WHEN NEW.provider_event_id='fail' BEGIN SELECT RAISE(ABORT,'injected cache failure'); END",
    );
    assert.throws(
      () => f.write(() => f.repo.publishRefresh(lease, snapshot([event('first'), event('fail')]))),
      /injected cache failure/,
    );
    assert.deepEqual(f.repo.snapshot(f.a.context)[0]!.events, before.events);
    assert.equal(f.repo.snapshot(f.a.context)[0]!.refreshedAt, before.refreshedAt);
    const invalid = event();
    invalid.timing = { kind: 'all_day', startDate: '2026-02-30', endDate: '2026-03-02' };
    assert.throws(() => f.write(() => f.repo.publishRefresh(lease, snapshot([invalid]))));
    assert.throws(() => f.repo.publishRefresh(lease, snapshot()), /require a transaction/);
    assert.throws(
      () => f.repo.snapshot({ kind: 'integration' } as unknown as HumanRequestContext),
      Unauthenticated,
    );
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM change_sets').get() as { n: number }).n, 0);
  } finally {
    f.close();
  }
});

test('calendar migration preserves all pre-calendar rows and installation identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'our-place-before-calendar-'));
  for (const file of readdirSync(migrationsRoot).filter((name) => name < '017'))
    copyFileSync(join(migrationsRoot, file), join(root, file));
  const f = fixture(root);
  try {
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','sqlite_sequence') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const contents = () =>
      Object.fromEntries(
        tables.map((name) => [name, f.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
      );
    const before = contents();
    migrate(f.db);
    assert.deepEqual(contents(), before);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.create().connectionId.length, 36);
  } finally {
    f.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the asynchronous synchronizer cannot republish a calendar disconnected during retrieval', async () => {
  const f = fixture();
  try {
    const { connectionId, calendarId } = f.create();
    f.write(() => f.repo.setSelection(f.a.context, calendarId, 1, f.shared, 'home'));
    let release!: (value: CalendarEventSnapshot) => void, started!: () => void;
    const waiting = new Promise<CalendarEventSnapshot>((resolve) => {
        release = resolve;
      }),
      began = new Promise<void>((resolve) => {
        started = resolve;
      });
    const synchronizer = new CalendarSynchronizer(
      f.db,
      f.repo,
      {
        accessToken: async () => {
          assert.equal(f.db.inTransaction, false);
          return 'do-not-persist-this-access-token';
        },
      },
      {
        listCalendars: async () => [source],
        readEvents: async (token, id, requestedWindow) => {
          assert.equal(f.db.inTransaction, false);
          assert.equal(token, 'do-not-persist-this-access-token');
          assert.equal(id, source.providerId);
          assert.deepEqual(requestedWindow, window);
          started();
          return waiting;
        },
      },
    );
    const pending = synchronizer.refresh(calendarId, window);
    await began;
    f.write(() => f.repo.disconnect(f.a.context, connectionId, 1));
    release(snapshot());
    assert.deepEqual(await pending, { status: 'superseded' });
    assert.deepEqual(f.repo.snapshot(f.b.context), []);
    assert.equal(
      JSON.stringify(f.db.prepare('SELECT * FROM calendar_connections').all()).includes(
        'do-not-persist-this-access-token',
      ),
      false,
    );
  } finally {
    f.close();
  }
});

test('the synchronizer publishes complete discovery and maps credential failures to reconnection without raw errors', async () => {
  const f = fixture();
  try {
    const connectionId = f.write(() =>
      f.repo.registerConnection(f.a.context, 'Fixture account', randomUUID()),
    );
    let denied = false;
    const synchronizer = new CalendarSynchronizer(
      f.db,
      f.repo,
      {
        accessToken: async () => {
          assert.equal(f.db.inTransaction, false);
          if (denied) throw new CalendarProviderError('authentication_required');
          return 'synthetic-token';
        },
      },
      { listCalendars: async () => [source], readEvents: async () => snapshot() },
    );
    assert.deepEqual(await synchronizer.discover(connectionId), { status: 'applied' });
    const calendar = f.repo.ownerCalendars(f.a.context, connectionId)[0]!;
    f.write(() =>
      f.repo.setSelection(f.a.context, calendar.calendarId, calendar.revision, f.a.scopeId, 'work'),
    );
    assert.deepEqual(await synchronizer.refresh(calendar.calendarId, window), { status: 'applied' });
    denied = true;
    assert.deepEqual(await synchronizer.discover(connectionId), {
      status: 'failed',
      code: 'authentication_required',
    });
    const connection = f.repo.ownerConnections(f.a.context)[0]!;
    assert.equal(connection.state, 'needs_auth');
    assert.equal(connection.errorCode, 'authentication_required');
    assert.deepEqual(f.repo.snapshot(f.a.context), []);
    assert.deepEqual(await synchronizer.refresh(calendar.calendarId, window), { status: 'skipped' });
  } finally {
    f.close();
  }
});
