import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CommandKind, CommandOutcome, Envelope } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { migrate } from '../src/infrastructure/database.js';
import { buildApp } from '../src/app.js';
import { buildCaptureApp } from '../src/capture-app.js';
import { IntegrationAccessService } from '../src/features/access/integrations.js';
import type { HumanRequestContext, IntegrationRequestContext } from '../src/features/access/access.js';
import { Unauthenticated, Rejection } from '../src/application/errors.js';
import { ShoppingRepository } from '../src/features/shopping/shopping.js';
import { TasksRepository } from '../src/features/tasks/tasks.js';
import { HomeRepository } from '../src/features/home/home.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { contentOf } from '../src/features/inbox/inbox.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { createAlexaHandler } from '../../../packages/alexa/src/skill.js';

async function fixture() {
  const f = await integrationFixture();
  migrate(f.db);
  const service = await buildApp({
    dataRoot: f.dataRoot,
    db: f.db,
    development: true,
    publicOrigin: 'http://localhost',
    authenticationMode: 'trusted-network',
    now: f.now,
  });
  const alice = service.access.authenticate('a'.repeat(43)),
    bob = service.access.authenticate('b'.repeat(43));
  const integrations = new IntegrationAccessService(f.db, f.now);
  const issued = integrations.provision(alice, 'Alexa', 9000000);
  const context = integrations.authenticate(issued.secret);
  const capture = await buildCaptureApp({ dataRoot: f.dataRoot, db: f.db, now: f.now });
  const headers = { authorization: `Bearer ${issued.secret}` };
  const payload = {
    operationId: randomUUID(),
    expectedServerEpoch: 'fixture-epoch',
    destination: 'inbox',
    text: 'Remember the model number',
    capturedAt: 800,
  };
  const post = (body: object = payload, secret = issued.secret, url = '/capture/inbox') =>
    capture.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${secret}` },
      payload: body,
    });
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: 'fixture-epoch',
    arguments: args,
  });
  const resolve = (operationId: string = payload.operationId, secret = issued.secret) =>
    post({ operationId, expectedServerEpoch: 'fixture-epoch' }, secret, '/capture/resolve');
  const close = async () => {
    await capture.app.close();
    await service.app.close();
    await f.close();
  };
  return {
    ...f,
    ...service,
    alice,
    bob,
    integrations,
    issued,
    context,
    capture,
    headers,
    payload,
    post,
    resolve,
    envelope,
    close,
  };
}
function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}

test('capture survives lost replies, partner edits/deletion and preserves separate attribution and human undo ownership', async () => {
  const f = await fixture();
  try {
    const original = applied((await f.post()).json()); // Discarding this reply must not require a new operation.
    const id = original.result.records[0]!.recordId;
    const note = f.inbox.get(f.alice, id);
    assert.equal(note.text, f.payload.text);
    assert.equal(note.capturedAt, 800);
    assert.equal(note.scopeId, 'fixture-shared');
    assert.deepEqual(note.source, { kind: 'voice' });
    const history = f.history.list(f.alice, id);
    assert.deepEqual(history[0]?.actor, {
      kind: 'integration',
      integrationId: f.issued.integrationId,
      displayName: 'Alexa',
    });
    assert.equal(history[0]?.canUndo, false);
    assert.equal(f.access.profiles().length, 2);
    assert.deepEqual((await f.post()).json(), { ...original, replayed: true });
    assert.deepEqual((await f.resolve()).json(), { ...original, replayed: true });
    assert.equal((await f.post({ ...f.payload, text: 'Different payload' })).statusCode, 409);
    assert.equal(
      f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: original.changeSetId })).status,
      'Rejected',
    );
    const edit = applied(
      f.writes.execute(
        f.bob,
        'SetInboxEntryText',
        f.envelope({ inboxId: id, expectedRevision: 1, text: 'Corrected by Bob' }),
      ),
    );
    assert.deepEqual((await f.post()).json(), { ...original, replayed: true });
    assert.equal(f.inbox.get(f.alice, id).text, 'Corrected by Bob');
    assert.equal(f.history.list(f.bob, id)[0]?.canUndo, true);
    assert.equal(f.history.list(f.alice, id)[0]?.canUndo, false);
    assert.deepEqual(f.history.list(f.bob, id)[0]?.actor, { personId: f.bob.personId, displayName: 'Bob' });
    applied(f.writes.execute(f.bob, 'UndoChangeSet', f.envelope({ changeSetId: edit.changeSetId })));
    applied(f.writes.execute(f.alice, 'DeleteInboxEntry', f.envelope({ inboxId: id, expectedRevision: 3 })));
    assert.deepEqual((await f.post()).json(), { ...original, replayed: true });
    assert.notEqual(f.inbox.get(f.alice, id).deletedAt, null);
    assert.equal(
      f.db.prepare('SELECT * FROM change_sets WHERE actor_integration_id=?').all(f.issued.integrationId)
        .length,
      1,
    );
    assert.equal(
      f.db.prepare('SELECT * FROM operation_receipts WHERE client_id=?').all(f.issued.clientId).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('separate listener rejects human credentials, private routes and caller-selected authority; main protected routes reject integration credentials', async () => {
  const f = await fixture();
  try {
    for (const secret of ['a'.repeat(43), 'b'.repeat(43)]) {
      assert.equal((await f.post(f.payload, secret)).statusCode, 401);
      assert.equal((await f.resolve(f.payload.operationId, secret)).statusCode, 401);
    }
    assert.equal(
      (
        await f.capture.app.inject({
          method: 'POST',
          url: '/capture/inbox',
          headers: { cookie: `our_place_session=${f.issued.secret}` },
          payload: f.payload,
        })
      ).statusCode,
      401,
    );
    for (const [method, url] of [
      ['GET', '/api/auth/options'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/session'],
      ['GET', '/api/cache/inbox'],
      ['GET', '/api/inbox/fixture-private'],
      ['GET', '/api/inbox/fixture-inbox/history'],
      ['GET', '/api/media/fixture-media'],
      ['GET', '/api/backups'],
      ['POST', '/api/commands/CreateInboxEntry'],
      ['GET', '/install/'],
      ['GET', '/health'],
    ] as const) {
      const result = await f.capture.app.inject({ method, url, headers: f.headers });
      assert.equal(result.statusCode, 404, url);
      assert.deepEqual(result.json(), { code: 'unavailable' });
    }
    for (const url of [
      '/api/session',
      '/api/cache/inbox',
      '/api/inbox/fixture-inbox',
      '/api/inbox/fixture-inbox/history',
      '/api/media/fixture-media',
      '/api/backups',
      '/api/storage',
    ]) {
      assert.equal((await f.app.inject({ method: 'GET', url, headers: f.headers })).statusCode, 401, url);
      assert.equal(
        (
          await f.app.inject({
            method: 'GET',
            url,
            headers: { cookie: `our_place_session=${f.issued.secret}` },
          })
        ).statusCode,
        401,
        url,
      );
    }
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/commands/CreateInboxEntry',
          headers: f.headers,
          payload: f.envelope({}),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'fixture-alice', clientKind: 'browser', clientId: f.issued.clientId },
        })
      ).statusCode,
      401,
    );
    for (const extra of [
      { scopeId: 'private-fixture-alice' },
      { personId: f.alice.personId },
      { clientId: f.alice.clientId },
      { command: 'DeleteInboxEntry' },
      { attachments: [] },
      { category: 'app_suggestion' },
      { destination: 'shopping' },
    ])
      assert.equal((await f.post({ ...f.payload, ...extra })).statusCode, 400);
    assert.equal(
      f.db.prepare('SELECT * FROM operation_receipts WHERE client_id=?').all(f.issued.clientId).length,
      0,
    );
    assert.equal(
      (
        await f.capture.app.inject({
          method: 'POST',
          url: '/capture/inbox',
          headers: { ...f.headers, origin: 'http://localhost' },
          payload: f.payload,
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.post({ ...f.payload, text: 'x'.repeat(17000) })).statusCode, 413);
  } finally {
    await f.close();
  }
});

test('valid envelopes receive durable argument rejections; own receipt namespaces, epoch guards and bounded requests remain enforced', async () => {
  const f = await fixture();
  try {
    for (const text of ['   ', null, 23, 'x'.repeat(1001)]) {
      const payload = { ...f.payload, operationId: randomUUID(), text };
      const response = await f.post(payload),
        outcome = response.json();
      assert.equal(response.statusCode, 200);
      assert.equal(outcome.status, 'Rejected');
      assert.deepEqual((await f.post(payload)).json(), { ...outcome, replayed: true });
    }
    assert.equal((await f.post({ ...f.payload, capturedAt: -1 })).json().status, 'Rejected');
    const other = f.integrations.provision(f.alice, 'Another capture', 9000000);
    assert.deepEqual((await f.resolve(f.payload.operationId, other.secret)).json(), { status: 'Unresolved' });
    assert.deepEqual((await f.resolve('legacy-create-media')).json(), { status: 'Unresolved' });
    const payload = { ...f.payload, operationId: randomUUID() };
    const receipt = applied((await f.post(payload)).json());
    f.db.exec(
      "UPDATE installation_state SET recovery_epoch='different-epoch',restored_from_at=999,recovery_mode='reconciling'",
    );
    assert.deepEqual((await f.post(payload)).json(), { ...receipt, replayed: true });
    assert.deepEqual((await f.resolve(payload.operationId)).json(), { ...receipt, replayed: true });
    assert.equal((await f.post({ ...payload, operationId: randomUUID() })).json().status, 'RecoveryRequired');
    assert.equal((await f.resolve('absent-operation')).json().status, 'RecoveryRequired');
    // One fixed small listener budget; no network request or production limiter is changed.
    for (let i = 0; i < 60; i++) await f.resolve('absent-operation');
    assert.equal((await f.resolve('absent-operation')).statusCode, 429);
  } finally {
    await f.close();
  }
});

test('rotation retains the operation namespace; revocation, expiry, disabled clients and inactive actors block both write and resolution', async () => {
  const f = await fixture();
  try {
    const outcome = applied((await f.post()).json());
    const rotated = f.integrations.rotate(f.alice, f.issued.clientId, 9000000);
    assert.equal(rotated.clientId, f.issued.clientId);
    assert.equal((await f.post()).statusCode, 401);
    assert.equal((await f.resolve()).statusCode, 401);
    assert.throws(() => f.writes.resolve(f.context, f.payload.operationId, 'fixture-epoch'), Unauthenticated);
    assert.throws(() => f.writes.execute(f.context, 'CreateInboxEntry', f.envelope({})), Unauthenticated);
    assert.deepEqual((await f.post(f.payload, rotated.secret)).json(), { ...outcome, replayed: true });
    for (const [disable, enable] of [
      [
        "UPDATE clients SET enabled=0 WHERE kind='integration'",
        "UPDATE clients SET enabled=1 WHERE kind='integration'",
      ],
      ['UPDATE integration_actors SET active=0', 'UPDATE integration_actors SET active=1'],
    ]) {
      f.db.exec(disable!);
      assert.equal((await f.post(f.payload, rotated.secret)).statusCode, 401);
      assert.equal((await f.resolve(f.payload.operationId, rotated.secret)).statusCode, 401);
      f.db.exec(enable!);
    }
    f.setTime(9000000);
    assert.equal((await f.post(f.payload, rotated.secret)).statusCode, 401);
    assert.equal((await f.resolve(f.payload.operationId, rotated.secret)).statusCode, 401);
    f.setTime(1000);
    f.integrations.revoke(f.alice, f.issued.clientId);
    assert.equal((await f.post(f.payload, rotated.secret)).statusCode, 401);
    assert.equal((await f.resolve(f.payload.operationId, rotated.secret)).statusCode, 401);
    const before = f.db.prepare('SELECT * FROM integration_actors').all();
    assert.throws(() => f.integrations.provision(f.alice, 'Invalid expiry', 500), /invalid_expiry/);
    assert.deepEqual(f.db.prepare('SELECT * FROM integration_actors').all(), before);
    assert.throws(() => f.integrations.provision(f.bob, 'Not administrator', 9000000));
  } finally {
    await f.close();
  }
});

test('integration contexts cannot bypass human-only repositories or the command boundary; commit failure accepts nothing', async () => {
  const f = await fixture();
  try {
    const shopping = new ShoppingRepository(f.db, f.access),
      home = new HomeRepository(f.db, f.access),
      tasks = new TasksRepository(f.db, f.access, 'UTC', home);
    const records = new RecordRegistry(f.db, [
      inboxRecordAdapter(f.inbox),
      ...shopping.adapters(),
      ...tasks.adapters(),
      ...home.adapters(),
    ]);
    const forged = f.context as unknown as HumanRequestContext;
    const current = f.inbox.get(f.alice, 'fixture-inbox'),
      tracked = records.get(f.alice, 'fixture-inbox');
    for (const call of [
      () => f.access.session(forged),
      () => f.access.scopes(forged),
      () => f.access.isAdministrator(forged),
      () => f.inbox.get(forged, current.inboxId),
      () => f.inbox.list(forged, f.now()),
      () => f.inbox.snapshot(forged, f.now()),
      () => f.inbox.setContent(forged, current, contentOf(current), f.now()),
      () => f.history.list(forged, current.inboxId),
      () => f.history.reverse(forged, 'any-change', false, f.now()),
      () => records.get(forged, current.inboxId),
      () => records.setContent(forged, tracked, tracked.content, f.now()),
      () => shopping.snapshot(forged),
      () => tasks.snapshot(forged),
      () => home.snapshot(forged),
      () => home.get(forged, 'absent-asset'),
      () => home.commands().execute(forged, 'CreateHomeAsset', {}, f.now()),
      () => shopping.execute(forged, 'CreateShoppingList', {}, f.now()),
      () => tasks.execute(forged, 'CreateTask', {}, f.now()),
      () => f.writes.abandonRestored(forged, 'CreateInboxEntry', f.envelope({})),
    ])
      assert.throws(call, Unauthenticated);
    await assert.rejects(f.media.read(forged, 'fixture-media'), Unauthenticated);
    const before = f.snapshot();
    for (const kind of [
      'SetInboxEntryText',
      'DeleteInboxEntry',
      'UndoChangeSet',
      'CreateShoppingList',
      'CreateTask',
      'CreateHomeAsset',
      'CreateMaintenanceRecord',
    ] as CommandKind[])
      assert.throws(() => f.writes.execute(f.context, kind, f.envelope({})), Rejection);
    const args = {
      inboxId: randomUUID(),
      scopeId: 'fixture-shared',
      text: 'allowed',
      capturedAt: 800,
      source: { kind: 'voice' as const },
      attachments: [],
    };
    for (const forbidden of [
      { scopeId: 'private-fixture-alice' },
      { source: { kind: 'typed' } },
      { source: { kind: 'voice', uri: 'https://example.invalid' } },
      { category: 'app_suggestion' },
      { attachments: current.attachments },
    ]) {
      const outcome = f.writes.execute(f.context, 'CreateInboxEntry', f.envelope({ ...args, ...forbidden }));
      assert.equal(outcome.status, 'Rejected');
    }
    const failing = new WriteCoordinator(f.db, f.inbox, f.history, f.now, records, () => {
      throw new Error('injected failure');
    });
    const command = f.envelope(args);
    assert.throws(() => failing.execute(f.context, 'CreateInboxEntry', command), /injected failure/);
    assert.deepEqual(f.writes.resolve(f.context, command.operationId, 'fixture-epoch'), {
      status: 'Unresolved',
    });
    // Only durable rejection receipts changed; existing household rows stay byte-for-byte identical.
    assert.deepEqual(f.snapshot().slice(0, -1), before.slice(0, -1));
    applied(f.writes.execute(f.context, 'CreateInboxEntry', command));
  } finally {
    await f.close();
  }
});

test('capture includes Home integrity checks without granting access to assets or service records', async () => {
  const f = await fixture();
  try {
    const assetId = randomUUID(),
      serviceId = randomUUID();
    applied(
      f.writes.execute(
        f.alice,
        'CreateHomeAsset',
        f.envelope({
          recordId: assetId,
          scopeId: 'fixture-shared',
          name: 'Fixture heat pump',
          model: '',
          serial: '',
          location: '',
          acquiredDate: null,
          notes: '',
        }),
      ),
    );
    applied(
      f.writes.execute(
        f.alice,
        'CreateMaintenanceRecord',
        f.envelope({
          recordId: serviceId,
          scopeId: 'fixture-shared',
          assetId,
          occurredAt: 800,
          notes: 'Fixture service',
          costAmount: '12.3400',
          currency: 'CAD',
        }),
      ),
    );
    applied((await f.post()).json());
    for (const url of [`/api/records/${assetId}/history`, `/api/records/${serviceId}/history`])
      assert.equal((await f.capture.app.inject({ method: 'GET', url, headers: f.headers })).statusCode, 404);
    const homeBefore = f.db.prepare('SELECT * FROM home_assets').all();
    // Deliberate corruption is confined to this disposable fixture. Every writer must detect it.
    f.db.prepare('DELETE FROM maintenance_records WHERE maintenance_record_id=?').run(serviceId);
    const operationId = randomUUID();
    assert.equal((await f.post({ ...f.payload, operationId })).statusCode, 503);
    assert.deepEqual((await f.resolve(operationId)).json(), { status: 'Unresolved' });
    assert.deepEqual(f.db.prepare('SELECT * FROM home_assets').all(), homeBefore);
    assert.equal(
      f.db.prepare('SELECT * FROM operation_receipts WHERE client_id=?').all(f.issued.clientId).length,
      1,
    );
  } finally {
    await f.close();
  }
});

test('Alexa returns readback after the household commits, with no confirmation or duplicate note on delivery retry', async () => {
  const f = await fixture();
  try {
    const handler = createAlexaHandler({
      skillId: 'fixture-skill',
      users: new Map([
        ['fixture-account', { bindingId: 'fixture-binding', expectedServerEpoch: 'fixture-epoch' }],
      ]),
      now: f.now,
      capture: async (_binding, payload) => (await f.post(payload)).json() as CommandOutcome,
    });
    const event = {
      version: '1.0',
      context: {
        System: { application: { applicationId: 'fixture-skill' }, user: { userId: 'fixture-account' } },
      },
      request: {
        type: 'IntentRequest',
        requestId: 'fixture-alexa-delivery',
        timestamp: new Date(f.now()).toISOString(),
        locale: 'en-CA',
        intent: { name: 'RememberIntent', slots: { Text: { name: 'Text', value: 'Keep the filter model' } } },
      },
    };
    const response = await handler(event);
    assert.equal(response.response.shouldEndSession, true);
    assert.match(response.response.outputSpeech?.text ?? '', /saved/i);
    assert.equal(
      f.inbox.list(f.alice, f.now()).entries.some((entry) => entry.text === 'Keep the filter model'),
      true,
    );
    assert.equal(
      f.db.prepare('SELECT * FROM change_sets WHERE actor_integration_id=?').all(f.issued.integrationId)
        .length,
      1,
    );
    await handler(event);
    assert.equal(
      f.db.prepare('SELECT * FROM change_sets WHERE actor_integration_id=?').all(f.issued.integrationId)
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

// These are compile-time assertions; the runtime bypass tests above intentionally erase the subtype.
function humanBoundaryTypes(
  service: Awaited<ReturnType<typeof buildApp>>,
  context: IntegrationRequestContext,
) {
  // @ts-expect-error integration principals cannot request a human session
  service.access.session(context);
  // @ts-expect-error integration principals cannot browse history
  service.history.list(context, 'fixture-inbox');
  // @ts-expect-error integration principals cannot browse notes
  service.inbox.get(context, 'fixture-inbox');
  // @ts-expect-error integration principals cannot read media
  void service.media.read(context, 'fixture-media');
}
void humanBoundaryTypes;
