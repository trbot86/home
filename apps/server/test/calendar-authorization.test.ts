import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDatabase,
  migrate,
  initialiseInstallation,
  installation,
  immediate,
} from '../src/infrastructure/database.js';
import { AccessService } from '../src/features/access/access.js';
import { CalendarsRepository } from '../src/features/calendars/calendars.js';
import { CalendarAuthorizationService } from '../src/features/calendars/authorization.js';
import { CalendarSecretBox } from '../src/features/calendars/secret-box.js';
import {
  calendarReadScopes,
  type CalendarGrant,
  type CalendarAuthorizationProvider,
} from '../src/features/calendars/authorization-provider.js';
import { CalendarProviderError } from '../src/features/calendars/provider.js';
import { Rejection, Unauthenticated } from '../src/application/errors.js';
import { migrationsRoot } from '../src/paths.js';
import { BackupCoordinator, initialiseBackupDestination } from '../src/features/operations/backups.js';
import { FileMediaStore } from '../src/features/media/file-media-store.js';
import { MediaRetentionGate } from '../src/features/media/retention-gate.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { integrationFixture } from './integration-fixture.js';

const isCode = (code: string) => (error: unknown) =>
  (error instanceof Rejection || error instanceof CalendarProviderError) && error.code === code;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'our-place-calendar-auth-')),
    dataRoot = join(root, 'data'),
    db = openDatabase(join(dataRoot, 'db/household.sqlite'));
  migrate(db);
  initialiseInstallation(db);
  let time = Date.now();
  const now = () => time,
    access = new AccessService(db, now);
  const people = ['Alex', 'Sam'].map((name) => {
    const personId = randomUUID();
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      personId,
      name.toLowerCase(),
      name,
      'fixture',
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), personId);
    const session = access.selectProfile(name, 'browser');
    return access.authenticate(session.secret);
  });
  const [a, b] = people as [(typeof people)[number], (typeof people)[number]],
    repo = new CalendarsRepository(db, access, now),
    keys = new Map([['first', randomBytes(32)]]),
    box = new CalendarSecretBox('first', keys);
  let exchanges = 0,
    refreshes = 0,
    subject = 'google-subject-one';
  const grant = (overrides: Partial<CalendarGrant> = {}): CalendarGrant => ({
    clientId: 'fixture-client',
    subject,
    accessToken: 'synthetic-access-token',
    refreshToken: 'synthetic-refresh-token',
    expiresAt: now() + 3600000,
    scopes: [...calendarReadScopes],
    ...overrides,
  });
  const provider: CalendarAuthorizationProvider = {
    clientId: 'fixture-client',
    authorizationUrl: (state, challenge) =>
      `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
    exchange: async (_code, verifier) => {
      assert.equal(db.inTransaction, false);
      assert.equal(verifier.length, 43);
      exchanges++;
      return grant();
    },
    refresh: async (previous) => {
      assert.equal(db.inTransaction, false);
      refreshes++;
      return grant({
        subject: previous.subject,
        accessToken: 'synthetic-refreshed-token',
        refreshToken: 'synthetic-rotated-refresh',
      });
    },
  };
  const service = new CalendarAuthorizationService(db, repo, box, provider, now);
  const start = (reconnect?: { connectionId: string; generation: number }) => {
    const pending = service.begin(a, 'Fixture Google account', reconnect),
      url = new URL(pending.authorizationUrl);
    return {
      ...pending,
      state: url.searchParams.get('state')!,
      challenge: url.searchParams.get('code_challenge')!,
    };
  };
  const connect = async () => {
    const pending = start();
    return await service.finish(a, pending.state, 'synthetic-code');
  };
  const credential = (connectionId: string) =>
    (
      db
        .prepare('SELECT credential_ref FROM calendar_connections WHERE connection_id=?')
        .get(connectionId) as { credential_ref: string }
    ).credential_ref;
  return {
    root,
    dataRoot,
    db,
    now,
    advance: (ms: number) => {
      time += ms;
    },
    a,
    b,
    access,
    repo,
    keys,
    box,
    grant,
    provider,
    service,
    start,
    connect,
    credential,
    exchanges: () => exchanges,
    refreshes: () => refreshes,
    subject: (value: string) => {
      subject = value;
    },
    write: <T>(f: () => T) => immediate(db, f),
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('calendar secret envelopes authenticate their purpose, support key rotation and never reveal corrupt input', () => {
  const first = randomBytes(32),
    second = randomBytes(32),
    box = new CalendarSecretBox('first', new Map([['first', first]]));
  const value = { refreshToken: 'synthetic-secret' },
    sealed = box.seal(value, 'credential-one');
  assert.equal(sealed.includes(value.refreshToken), false);
  assert.notEqual(sealed, box.seal(value, 'credential-one'));
  assert.deepEqual(box.open(sealed, 'credential-one'), value);
  assert.throws(() => box.open(sealed, 'credential-two'), /^Error: Calendar secret unavailable$/);
  const damaged = JSON.parse(sealed);
  damaged.tag = Buffer.alloc(16).toString('base64url');
  assert.throws(() => box.open(JSON.stringify(damaged), 'credential-one'), /Calendar secret unavailable/);
  const rotated = new CalendarSecretBox(
    'second',
    new Map([
      ['first', first],
      ['second', second],
    ]),
  );
  assert.deepEqual(rotated.open(sealed, 'credential-one'), value);
  assert.equal(JSON.parse(rotated.seal(value, 'credential-one')).keyId, 'second');
  assert.throws(
    () => new CalendarSecretBox('second', new Map([['second', second]])).open(sealed, 'credential-one'),
    /Calendar secret unavailable/,
  );
  assert.throws(() => new CalendarSecretBox('missing', new Map()), /Missing current calendar key/);
});

test('authorization binds PKCE to the initiating live client; successful retry does not exchange or create twice', async () => {
  const f = fixture();
  try {
    const pending = f.start(),
      row = f.db.prepare('SELECT * FROM calendar_authorizations').get() as {
        state_digest: string;
        sealed_json: string;
      };
    assert.notEqual(row.state_digest, pending.state);
    assert.equal(JSON.stringify(row).includes(pending.state), false);
    const state = installation(f.db),
      secret = f.box.open(
        row.sealed_json,
        JSON.stringify([
          'calendar-secrets-v1',
          state.installation_id,
          state.recovery_epoch,
          'attempt',
          row.state_digest,
        ]),
      ) as { verifier: string };
    assert.equal(pending.challenge, createHash('sha256').update(secret.verifier).digest('base64url'));
    await assert.rejects(
      f.service.finish(f.b, pending.state, 'synthetic-code'),
      isCode('calendar_authorization_expired'),
    );
    const result = await f.service.finish(f.a, pending.state, 'synthetic-code');
    assert.deepEqual(await f.service.finish(f.a, pending.state, 'synthetic-code'), result);
    assert.equal(f.exchanges(), 1);
    assert.equal(
      await f.service.accessToken(f.credential(result.connectionId), new AbortController().signal),
      'synthetic-access-token',
    );
    const credentials = f.db.prepare('SELECT * FROM calendar_credentials').all();
    assert.equal(credentials.length, 1);
    for (const secretText of ['synthetic-access-token', 'synthetic-refresh-token', secret.verifier])
      assert.equal(
        JSON.stringify([
          ...credentials,
          ...f.db.prepare('SELECT * FROM calendar_authorizations').all(),
        ]).includes(secretText),
        false,
      );
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM change_sets').get() as { n: number }).n, 0);
    assert.equal(JSON.stringify(f.repo.ownerConnections(f.a)).includes('subject'), false);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('expired, replaced, logged-out and restored consent attempts cannot exchange codes', async () => {
  const f = fixture();
  try {
    let pending = f.start();
    f.advance(600001);
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('calendar_authorization_expired'),
    );
    pending = f.start();
    f.start();
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('calendar_authorization_expired'),
    );
    pending = f.start();
    f.db.prepare('UPDATE installation_state SET recovery_epoch=?').run(randomUUID());
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('calendar_authorization_expired'),
    );
    pending = f.start();
    f.access.logout(f.a);
    await assert.rejects(f.service.finish(f.a, pending.state, 'synthetic-code'), Unauthenticated);
    assert.throws(() => f.start(), Unauthenticated);
    assert.equal(f.exchanges(), 0);
  } finally {
    f.close();
  }
});

test('same-account reconnect preserves selections, invalidates snapshots and rejects a different account or duplicate connection', async () => {
  const f = fixture();
  try {
    const { connectionId } = await f.connect(),
      oldRef = f.credential(connectionId);
    const discovery = f.write(() => f.repo.prepareDiscovery(connectionId))!;
    f.write(() =>
      f.repo.publishDiscovery(discovery, [
        {
          providerId: 'fixture@example.com',
          title: 'Selected',
          timeZone: 'UTC',
          accessRole: 'owner',
          primary: true,
        },
      ]),
    );
    const calendar = f.repo.ownerCalendars(f.a, connectionId)[0]!,
      shared = f.access.scopes(f.a).find((s) => s.kind === 'shared')!.scopeId;
    f.write(() => f.repo.setSelection(f.a, calendar.calendarId, calendar.revision, shared, 'home'));
    const refresh = f.write(() =>
      f.repo.prepareRefresh(calendar.calendarId, { from: f.now(), until: f.now() + 86400000 }),
    )!;
    await assert.rejects(f.connect(), isCode('calendar_account_already_connected'));
    let pending = f.start({ connectionId, generation: 1 });
    f.subject('different-google-subject');
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('calendar_account_mismatch'),
    );
    assert.equal(f.credential(connectionId), oldRef);
    pending = f.start({ connectionId, generation: 1 });
    f.subject('google-subject-one');
    assert.deepEqual(await f.service.finish(f.a, pending.state, 'synthetic-code'), { connectionId });
    assert.notEqual(f.credential(connectionId), oldRef);
    assert.equal(f.repo.ownerCalendars(f.a, connectionId)[0]!.scopeId, shared);
    assert.equal(
      f.write(() => f.repo.publishRefresh(refresh, { events: [], timeZone: 'UTC', window: refresh.window })),
      false,
    );
    await assert.rejects(
      f.service.accessToken(oldRef, new AbortController().signal),
      isCode('authentication_required'),
    );
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n, 1);
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE calendar_connections SET google_subject=? WHERE connection_id=?')
          .run('replacement', connectionId),
      /immutable/,
    );
  } finally {
    f.close();
  }
});

test('a disconnected or logged-out in-flight consent cannot persist its returned credentials', async () => {
  const f = fixture();
  try {
    const { connectionId } = await f.connect(),
      pending = f.start({ connectionId, generation: 1 }),
      network = deferred<CalendarGrant>();
    f.provider.exchange = () => network.promise;
    const finishing = f.service.finish(f.a, pending.state, 'synthetic-code');
    f.write(() => f.repo.disconnect(f.a, connectionId, 1));
    network.resolve(f.grant());
    await assert.rejects(finishing, isCode('calendar_connection_changed'));
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n, 0);
    const next = f.start(),
      other = deferred<CalendarGrant>();
    f.provider.exchange = () => other.promise;
    const loggedOut = f.service.finish(f.a, next.state, 'synthetic-code');
    f.access.logout(f.a);
    other.resolve(f.grant());
    await assert.rejects(loggedOut, Unauthenticated);
  } finally {
    f.close();
  }
});

test('partial grants and commit failures leave no credential or connection and cannot replay an exchanged code', async () => {
  const f = fixture();
  try {
    f.provider.exchange = async () => f.grant({ scopes: ['openid'] });
    let pending = f.start();
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('authentication_required'),
    );
    f.provider.exchange = async () => f.grant();
    pending = f.start();
    f.db.exec(
      "CREATE TRIGGER fail_credential BEFORE INSERT ON calendar_credentials BEGIN SELECT RAISE(ABORT,'synthetic-secret-in-error'); END",
    );
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('provider_unavailable'),
    );
    assert.equal(f.repo.ownerConnections(f.a).length, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n, 0);
    await assert.rejects(
      f.service.finish(f.a, pending.state, 'synthetic-code'),
      isCode('calendar_authorization_restart_required'),
    );
  } finally {
    f.close();
  }
});

test('expired tokens refresh once for concurrent readers, persist rotation and survive a service restart', async () => {
  const f = fixture();
  try {
    const { connectionId } = await f.connect(),
      ref = f.credential(connectionId);
    f.advance(3600001);
    const signal = new AbortController().signal;
    assert.deepEqual(
      await Promise.all([f.service.accessToken(ref, signal), f.service.accessToken(ref, signal)]),
      ['synthetic-refreshed-token', 'synthetic-refreshed-token'],
    );
    assert.equal(f.refreshes(), 1);
    const replacement = new CalendarAuthorizationService(f.db, f.repo, f.box, f.provider, f.now);
    assert.equal(await replacement.accessToken(ref, signal), 'synthetic-refreshed-token');
    f.advance(3600001);
    f.provider.refresh = async (previous) => {
      assert.equal(previous.refreshToken, 'synthetic-rotated-refresh');
      return f.grant({ accessToken: 'third-access' });
    };
    assert.equal(await replacement.accessToken(ref, signal), 'third-access');
  } finally {
    f.close();
  }
});

test('disconnect, a changed recovery epoch or a missing key prevents token reuse and refresh resurrection', async () => {
  const f = fixture();
  try {
    const { connectionId } = await f.connect(),
      ref = f.credential(connectionId);
    f.advance(3600001);
    let network = deferred<CalendarGrant>();
    f.provider.refresh = () => network.promise;
    let refreshing = f.service.accessToken(ref, new AbortController().signal);
    f.db.prepare('UPDATE installation_state SET recovery_epoch=?').run(randomUUID());
    network.resolve(f.grant());
    await assert.rejects(refreshing, isCode('authentication_required'));
    const pending = f.start({ connectionId, generation: 1 });
    await f.service.finish(f.a, pending.state, 'synthetic-code');
    const currentRef = f.credential(connectionId),
      missing = new CalendarAuthorizationService(
        f.db,
        f.repo,
        new CalendarSecretBox('second', new Map([['second', randomBytes(32)]])),
        f.provider,
        f.now,
      );
    await assert.rejects(
      missing.accessToken(currentRef, new AbortController().signal),
      isCode('authentication_required'),
    );
    f.advance(3600001);
    network = deferred<CalendarGrant>();
    f.provider.refresh = () => network.promise;
    refreshing = f.service.accessToken(currentRef, new AbortController().signal);
    f.write(() => f.repo.disconnect(f.a, connectionId, 2));
    network.resolve(f.grant());
    await assert.rejects(refreshing, isCode('authentication_required'));
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n, 0);
  } finally {
    f.close();
  }
});

test('calendar credential migration preserves populated household tables and calendar selection/cache state', async () => {
  const f = await integrationFixture(),
    { db } = f,
    old = join(f.root, 'through-calendar-cache');
  mkdirSync(old);
  try {
    for (const name of readdirSync(migrationsRoot).filter((n) => n < '018_'))
      copyFileSync(join(migrationsRoot, name), join(old, name));
    migrate(db, old);
    const context = f.legacy.contexts[0]!,
      access = new AccessService(db, f.now),
      repo = new CalendarsRepository(db, access, f.now);
    const connectionId = immediate(db, () =>
      repo.registerConnection(context, 'Retained connection', randomUUID()),
    );
    const discovery = immediate(db, () => repo.prepareDiscovery(connectionId))!;
    immediate(db, () =>
      repo.publishDiscovery(discovery, [
        {
          providerId: 'fixture@example.com',
          title: 'Retained calendar',
          timeZone: 'UTC',
          accessRole: 'owner',
          primary: true,
        },
      ]),
    );
    const calendar = repo.ownerCalendars(context, connectionId)[0]!,
      scope = access.scopes(context).find((s) => s.kind === 'shared')!;
    immediate(db, () =>
      repo.setSelection(context, calendar.calendarId, calendar.revision, scope.scopeId, 'home'),
    );
    const lease = immediate(db, () =>
      repo.prepareRefresh(calendar.calendarId, { from: 1000, until: 86401000 }),
    )!;
    immediate(db, () =>
      repo.publishRefresh(lease, {
        window: lease.window,
        timeZone: 'UTC',
        events: [
          {
            eventId: 'fixture-event',
            instanceKey: '',
            recurringEventId: null,
            providerVersion: 'fixture-version',
            title: 'Retained event',
            description: '',
            location: '',
            sourceUrl: null,
            status: 'confirmed',
            participation: null,
            visibility: 'default',
            busy: true,
            timing: { kind: 'timed', startAt: 2000, endAt: 3000, timeZone: 'UTC', endUnspecified: false },
          },
        ],
      }),
    );
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    const before = tables.map((t) => {
      const columns = (db.pragma(`table_info("${t}")`) as { name: string }[])
        .map((c) => `"${c.name}"`)
        .join(',');
      const sql = `SELECT ${columns} FROM "${t}" ${t === 'record_kinds' ? "WHERE kind NOT IN ('suggestion_workflow','suggestion_message')" : ''} ORDER BY rowid`;
      return { name: t, sql, rows: db.prepare(sql).all() };
    });
    migrate(db);
    for (const t of before) {
      if (t.name === 'schema_migrations') continue;
      assert.deepEqual(db.prepare(t.sql).all(), t.rows, t.name);
    }
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    await f.close();
  }
});

test('backup includes encrypted credentials but restore discards grants, suppresses calendars and preserves profiles/identity', async () => {
  const f = fixture();
  try {
    const { connectionId } = await f.connect();
    f.start();
    const files = new FileMediaStore(join(f.dataRoot, 'media'), true);
    await files.initialise();
    const outputRoot = join(f.root, 'backups');
    await initialiseBackupDestination(outputRoot, installation(f.db).installation_id, true);
    const backups = new BackupCoordinator(f.db, files, new MediaRetentionGate(), {
      dataRoot: f.dataRoot,
      outputRoot,
      development: true,
      now: f.now,
    });
    await backups.initialise();
    const backup = await backups.create();
    const archive = gunzipSync(readFileSync(join(outputRoot, backup.archive.name))),
      sealed = (f.db.prepare('SELECT sealed_json FROM calendar_credentials').get() as { sealed_json: string })
        .sealed_json;
    assert.equal(archive.includes(Buffer.from(sealed)), true);
    for (const secret of ['synthetic-access-token', 'synthetic-refresh-token'])
      assert.equal(archive.includes(Buffer.from(secret)), false);
    assert.equal(archive.includes(f.keys.get('first')!), false);
    const destination = join(f.root, 'restored');
    await restoreBackup(join(outputRoot, `${backup.archive.name}.complete.json`), destination, true);
    const restored = openDatabase(join(destination, 'db/household.sqlite'));
    try {
      assert.equal(
        (restored.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n,
        0,
      );
      assert.equal(
        (restored.prepare('SELECT COUNT(*) n FROM calendar_authorizations').get() as { n: number }).n,
        0,
      );
      assert.equal(
        (
          restored
            .prepare('SELECT state FROM calendar_connections WHERE connection_id=?')
            .get(connectionId) as { state: string }
        ).state,
        'needs_auth',
      );
      assert.equal(installation(restored).installation_id, installation(f.db).installation_id);
      assert.notEqual(installation(restored).recovery_epoch, installation(f.db).recovery_epoch);
      assert.deepEqual(
        restored.prepare('SELECT * FROM people ORDER BY person_id').all(),
        f.db.prepare('SELECT * FROM people ORDER BY person_id').all(),
      );
    } finally {
      restored.close();
    }
    assert.equal(f.repo.ownerConnections(f.a)[0]!.state, 'active');
  } finally {
    f.close();
  }
});
