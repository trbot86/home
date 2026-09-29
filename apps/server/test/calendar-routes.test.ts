import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import {
  openDatabase,
  migrate,
  initialiseInstallation,
  installation,
} from '../src/infrastructure/database.js';
import { CalendarSecretBox } from '../src/features/calendars/secret-box.js';
import { calendarReadScopes } from '../src/features/calendars/authorization-provider.js';
import {
  loadCalendarConfiguration,
  type CalendarConfiguration,
} from '../src/features/calendars/configuration.js';
const origin = 'https://household.example';
async function fixture(configured = true) {
  const root = await mkdtemp(join(tmpdir(), 'our-place-calendar-http-')),
    db = openDatabase(join(root, 'db/household.sqlite'));
  migrate(db);
  initialiseInstallation(db);
  for (const name of ['Alex', 'Sam']) {
    const personId = randomUUID();
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      personId,
      name.toLowerCase(),
      name,
      'fixture',
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), personId);
  }
  let time = Date.now(),
    exchanges = 0,
    discoveries = 0;
  const now = () => time;
  const configuration: CalendarConfiguration = {
    secrets: new CalendarSecretBox('fixture', new Map([['fixture', randomBytes(32)]])),
    authorization: {
      clientId: 'fixture-client',
      authorizationUrl: (state, challenge) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
      exchange: async () => {
        exchanges++;
        return {
          clientId: 'fixture-client',
          subject: 'fixture-subject',
          accessToken: 'synthetic-access',
          refreshToken: 'synthetic-refresh',
          expiresAt: now() + 3600000,
          scopes: [...calendarReadScopes],
        };
      },
      refresh: async (previous) => ({ ...previous, expiresAt: now() + 3600000 }),
    },
    events: {
      listCalendars: async () => {
        discoveries++;
        return [
          {
            providerId: 'fixture-private-id@example.com',
            title: 'Fixture calendar',
            timeZone: 'UTC',
            accessRole: 'owner',
            primary: true,
          },
        ];
      },
      readEvents: async (_token, _id, window) => ({ window, timeZone: 'UTC', events: [] }),
    },
  };
  const service = await buildApp({
    db,
    dataRoot: root,
    development: true,
    publicOrigin: origin,
    authenticationMode: 'trusted-network',
    now,
    ...(configured ? { calendars: configuration } : {}),
  });
  async function login(username = 'alex', clientKind: 'browser' | 'android' = 'browser') {
    const result = await service.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username, clientKind },
    });
    assert.equal(result.statusCode, 200);
    const session = result.json();
    return {
      session,
      headers: {
        origin,
        'x-client-id': session.clientId as string,
        ...(clientKind === 'browser'
          ? { cookie: result.cookies.map((c) => `${c.name}=${c.value}`).join('; ') }
          : { authorization: `Bearer ${session.credential}` }),
      },
    };
  }
  const a = await login(),
    b = await login('sam');
  const post = (url: string, payload: object, who = a) =>
    service.app.inject({ method: 'POST', url, headers: who.headers, payload });
  async function begin() {
    const reply = await post('/api/calendars/authorization/begin', { label: 'Fixture account' });
    assert.equal(reply.statusCode, 200);
    const state = new URL(reply.json().authorizationUrl).searchParams.get('state')!;
    const browserCookie = reply.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    return { reply, state, browserCookie };
  }
  const callback = (state: string, cookie: string, code = 'synthetic-authorization-code') =>
    service.app.inject({
      method: 'GET',
      url: `/oauth/calendar/callback?state=${state}&code=${code}`,
      headers: { cookie },
    });
  async function returned() {
    const pending = await begin(),
      reply = await callback(pending.state, pending.browserCookie);
    assert.equal(reply.statusCode, 302);
    const id = new URL(reply.headers.location!, origin).searchParams.get('calendarConnect')!;
    return { ...pending, reply, id };
  }
  const command = (args: Record<string, unknown>) => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  return {
    ...service,
    root,
    now,
    configuration,
    login,
    a,
    b,
    post,
    begin,
    callback,
    returned,
    command,
    exchanges: () => exchanges,
    discoveries: () => discoveries,
    advance: (ms: number) => {
      time += ms;
    },
    close: async () => {
      await service.app.close();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('calendar settings reports unconfigured truthfully and native account setup requires the system browser', async () => {
  const f = await fixture(false);
  try {
    const view = await f.app.inject({ url: '/api/calendars/settings', headers: f.a.headers });
    assert.deepEqual(view.json(), { configured: false, icalAvailable: true, connections: [] });
    assert.equal(
      (await f.post('/api/calendars/authorization/begin', { label: 'Fixture' })).json().code,
      'calendar_not_configured',
    );
  } finally {
    await f.close();
  }
  const ready = await fixture();
  try {
    const native = await ready.login('alex', 'android');
    assert.equal(
      (await ready.post('/api/calendars/authorization/begin', { label: 'Fixture' }, native)).json().code,
      'calendar_use_browser',
    );
    assert.equal((await ready.app.inject({ url: '/api/calendars/settings' })).statusCode, 401);
    assert.equal(
      (
        await ready.app.inject({
          method: 'POST',
          url: '/api/calendars/authorization/begin',
          headers: { ...ready.a.headers, origin: 'https://elsewhere.example' },
          payload: { label: 'Fixture' },
        })
      ).statusCode,
      403,
    );
  } finally {
    await ready.close();
  }
});

test('Google callback requires the initiating browser and passes only an opaque handle to the app; final activation requires its original profile', async () => {
  const f = await fixture();
  try {
    const pending = await f.begin();
    const cookie = pending.reply.cookies.find((c) => c.name === 'our_place_calendar_browser')!;
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, 'Lax');
    assert.equal(cookie.path, '/oauth/calendar');
    assert.equal((await f.callback(pending.state, '')).statusCode, 400);
    assert.equal((await f.callback(pending.state, 'cookie' in f.b.headers ? f.b.headers.cookie : '')).statusCode, 400);
    const callback = await f.callback(pending.state, pending.browserCookie);
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers['cache-control'], 'no-store');
    assert.equal(callback.headers['referrer-policy'], 'no-referrer');
    assert.equal(String(callback.headers.location).includes(pending.state), false);
    assert.equal(String(callback.headers.location).includes('synthetic-authorization-code'), false);
    assert.equal(f.exchanges(), 0);
    const id = new URL(callback.headers.location!, origin).searchParams.get('calendarConnect')!;
    const raw = JSON.stringify(f.db.prepare('SELECT * FROM calendar_browser_handoffs').all());
    assert.equal(raw.includes('synthetic-authorization-code'), false);
    assert.equal(raw.includes(pending.state), false);
    assert.equal(raw.includes(cookie.value), false);
    assert.equal(
      (await f.post('/api/calendars/authorization/finish', { handoffId: id }, f.b)).json().code,
      'calendar_authorization_restart_required',
    );
    const finished = await f.post('/api/calendars/authorization/finish', { handoffId: id });
    assert.equal(finished.statusCode, 200);
    assert.equal(f.exchanges(), 1);
    assert.equal(f.discoveries(), 1);
    assert.equal(
      (await f.post('/api/calendars/authorization/finish', { handoffId: id })).json().connectionId,
      finished.json().connectionId,
    );
    assert.equal(f.exchanges(), 1);
    const view = (await f.app.inject({ url: '/api/calendars/settings', headers: f.a.headers })).json();
    assert.equal(view.connections[0].calendars[0].title, 'Fixture calendar');
    assert.equal(view.connections[0].calendars[0].scopeId, null);
    for (const secret of [
      'fixture-private-id@example.com',
      'fixture-subject',
      'synthetic-access',
      'synthetic-refresh',
    ])
      assert.equal(JSON.stringify(view).includes(secret), false);
    assert.deepEqual(
      (await f.app.inject({ url: '/api/calendars/settings', headers: f.b.headers })).json().connections,
      [],
    );
    assert.equal(
      (await f.post(`/api/calendars/connections/${finished.json().connectionId}/discover`, {}, f.b))
        .statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});

test('expired, cancelled, malformed and replayed callbacks cannot replace the captured authorization code', async () => {
  const f = await fixture();
  try {
    let pending = await f.begin();
    f.advance(600001);
    assert.equal((await f.callback(pending.state, pending.browserCookie)).statusCode, 400);
    pending = await f.begin();
    const denied = await f.app.inject({
      url: `/oauth/calendar/callback?state=${pending.state}&error=access_denied&error_description=synthetic-private-diagnostic`,
      headers: { cookie: pending.browserCookie },
    });
    assert.equal(denied.headers.location, '/?settings=calendars&calendarConnect=cancelled');
    assert.equal((await f.callback(pending.state, pending.browserCookie)).statusCode, 400);
    pending = await f.begin();
    assert.equal(
      (
        await f.app.inject({
          url: `/oauth/calendar/callback?state=${pending.state}&state=duplicate&code=fixture`,
          headers: { cookie: pending.browserCookie },
        })
      ).statusCode,
      400,
    );
    const returned = await f.callback(pending.state, pending.browserCookie, 'first-code');
    const replay = await f.callback(pending.state, pending.browserCookie, 'different-code');
    assert.equal(returned.headers.location, replay.headers.location);
    f.configuration.authorization.exchange = async (code) => {
      assert.equal(code, 'first-code');
      throw new Error('synthetic-sensitive-sdk-error');
    };
    const id = new URL(returned.headers.location!, origin).searchParams.get('calendarConnect');
    const failed = await f.post('/api/calendars/authorization/finish', { handoffId: id });
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.json().code, 'calendar_provider_unavailable');
    assert.equal(failed.body.includes('synthetic-sensitive'), false);
    assert.equal(
      (await f.post('/api/calendars/authorization/finish', { handoffId: id })).json().code,
      'calendar_authorization_restart_required',
    );
  } finally {
    await f.close();
  }
});

test('calendar selection and disconnection use receipts, protect ownership and leave household history untouched', async () => {
  const f = await fixture();
  try {
    const returned = await f.returned(),
      connected = await f.post('/api/calendars/authorization/finish', { handoffId: returned.id }),
      connectionId = connected.json().connectionId,
      settings = (await f.app.inject({ url: '/api/calendars/settings', headers: f.a.headers })).json(),
      calendar = settings.connections[0].calendars[0];
    const shared = f.a.session.scopes.find((s: { kind: string }) => s.kind === 'shared').scopeId;
    const privateScope = f.a.session.scopes.find((s: { kind: string }) => s.kind === 'private').scopeId;
    const bad = f.command({
      calendarId: calendar.calendarId,
      expectedRevision: calendar.revision,
      scopeId: shared,
      context: 'work',
    });
    assert.equal(
      (await f.post('/api/commands/SelectCalendar', bad)).json().code,
      'work_calendar_must_be_private',
    );
    const selection = f.command({ ...bad.arguments, scopeId: privateScope });
    assert.equal((await f.post('/api/commands/SelectCalendar', selection, f.b)).json().status, 'Rejected');
    assert.equal((await f.post('/api/commands/SelectCalendar', selection)).json().status, 'Applied');
    assert.equal((await f.post('/api/commands/SelectCalendar', selection)).json().replayed, true);
    const remove = f.command({ connectionId, expectedGeneration: 1 });
    assert.equal((await f.post('/api/commands/DisconnectCalendar', remove)).json().status, 'Applied');
    assert.equal((await f.post('/api/commands/DisconnectCalendar', remove)).json().replayed, true);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_credentials').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM calendar_event_cache').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT COUNT(*) n FROM change_sets').get() as { n: number }).n, 0);
  } finally {
    await f.close();
  }
});

test('host calendar configuration stays outside client state and rejects missing or malformed key material', async () => {
  const root = await mkdtemp(join(tmpdir(), 'our-place-calendar-config-')),
    path = join(root, 'fixture.json');
  try {
    assert.equal(await loadCalendarConfiguration(undefined, origin), undefined);
    await assert.rejects(
      loadCalendarConfiguration(path, origin),
      /^Error: Calendar configuration is missing or invalid$/,
    );
    await writeFile(
      path,
      JSON.stringify({
        clientId: 'fixture-client',
        clientSecret: 'synthetic-secret',
        activeKeyId: 'first',
        keys: { first: randomBytes(32).toString('base64url') },
      }),
    );
    const config = await loadCalendarConfiguration(path, origin);
    const url = new URL(
      config!.authorization.authorizationUrl(
        randomBytes(32).toString('base64url'),
        randomBytes(32).toString('base64url'),
      ),
    );
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/oauth/calendar/callback');
    await writeFile(path, '{"clientSecret":"synthetic-secret",broken');
    await assert.rejects(loadCalendarConfiguration(path, origin), (cause) => {
      assert.equal(String(cause).includes('synthetic'), false);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
