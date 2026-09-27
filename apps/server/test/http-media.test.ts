import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Attachment, CommandKind } from '@our-place/contracts';
import { openDatabase, migrate } from '../src/infrastructure/database.js';
import { provisionHousehold } from '../src/features/access/access.js';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/features/media/file-media-store.js';

const origin = 'http://127.0.0.1:5173';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ0kAAAAASUVORK5CYII=',
  'base64',
);
async function fixture(authenticationMode: 'password' | 'trusted-network' = 'password') {
  const root = mkdtempSync(join(tmpdir(), 'our-place-http-'));
  const path = join(root, 'db/household.sqlite');
  const db = openDatabase(path);
  migrate(db);
  await provisionHousehold(db, [
    { username: 'alice', displayName: 'Alice', password: 'test-alice-password' },
    { username: 'bob', displayName: 'Bob', password: 'test-bob-password' },
  ]);
  db.close();
  let clock = 1000;
  const service = await buildApp({
    dataRoot: root,
    publicOrigin: origin,
    development: true,
    now: () => clock,
    authenticationMode,
  });
  const login = async (
    username: string,
    clientKind: 'browser' | 'android' = 'browser',
    clientId?: string,
  ) => {
    const result = await service.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: {
        username,
        password: `test-${username}-password`,
        clientKind,
        ...(clientId ? { clientId } : {}),
      },
    });
    assert.equal(result.statusCode, 200);
    return {
      session: result.json<Session & { credential?: string }>(),
      cookie: String(result.headers['set-cookie'] ?? '').split(';')[0]!,
    };
  };
  const alice = await login('alice');
  const bob = await login('bob');
  const command = (args: unknown) => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: alice.session.serverEpoch,
    arguments: args,
  });
  return {
    ...service,
    root,
    login,
    alice,
    bob,
    command,
    advance: (ms: number) => {
      clock += ms;
    },
    close: async () => {
      await service.app.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('deployed request and password limits remain bounded with a useful retry error', async () => {
  const f = await fixture();
  try {
    // The fixture already made two sign-in requests. The password route allows ten per minute.
    for (let n = 0; n < 8; n++)
      assert.equal(
        (
          await f.app.inject({
            method: 'POST',
            url: '/api/auth/login',
            headers: { origin },
            payload: { username: 'alice', password: 'incorrect-password', clientKind: 'browser' },
          })
        ).statusCode,
        401,
      );
    const limited = await f.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: 'alice', password: 'incorrect-password', clientKind: 'browser' },
    });
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, 'too_many_requests_try_again_shortly');
    assert.ok(limited.headers['retry-after']);
    for (let n = 0; n < 300; n++) assert.equal((await f.app.inject('/health')).statusCode, 200);
    assert.equal((await f.app.inject('/health')).statusCode, 429);
  } finally {
    await f.close();
  }
});

test('cookie authentication, CSRF, native credentials and revocation use real sessions', async () => {
  const f = await fixture();
  try {
    assert.deepEqual((await f.app.inject('/api/auth/options')).json(), { mode: 'password' });
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload: { username: 'alice', clientKind: 'browser' },
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.app.inject('/api/session')).statusCode, 401);
    const session = await f.app.inject({ url: '/api/session', headers: { cookie: f.alice.cookie } });
    assert.equal(session.json<Session>().person.displayName, 'Alice');
    const denied = await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: f.alice.cookie, origin: 'https://unrelated.invalid' },
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(
      (await f.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: f.alice.cookie } }))
        .statusCode,
      400,
    );
    const native = await f.login('alice', 'android');
    assert.ok(native.session.credential);
    assert.equal(
      (
        await f.app.inject({
          url: '/api/session',
          headers: { authorization: `Bearer ${native.session.credential}` },
        })
      ).statusCode,
      200,
    );
    await f.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: f.alice.cookie, origin },
    });
    assert.equal(
      (await f.app.inject({ url: '/api/session', headers: { cookie: f.alice.cookie } })).statusCode,
      401,
    );
    const again = await f.login('alice', 'browser', f.alice.session.clientId);
    assert.equal(again.session.clientId, f.alice.session.clientId);
  } finally {
    await f.close();
  }
});

test('trusted-network selection needs no password but keeps client identities and scope filtering', async () => {
  const f = await fixture('trusted-network');
  try {
    const options = (await f.app.inject('/api/auth/options')).json();
    assert.equal(options.mode, 'trusted-network');
    assert.deepEqual(
      options.profiles.map((p: { username: string }) => p.username),
      ['alice', 'bob'],
    );
    assert.deepEqual(Object.keys(options.profiles[0]).sort(), ['displayName', 'personId', 'username']);
    const choose = (username: string, clientKind = 'browser', clientId?: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { username, clientKind, ...(clientId ? { clientId } : {}) },
      });
    const selected = await choose('alice', 'browser', f.alice.session.clientId);
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().clientId, f.alice.session.clientId);
    assert.equal((await choose('bob', 'browser', f.alice.session.clientId)).statusCode, 401);
    assert.equal((await choose('alice', 'android', f.alice.session.clientId)).statusCode, 401);
    assert.equal((await choose('missing')).statusCode, 401);
    const android = await choose('bob', 'android');
    assert.equal(android.statusCode, 200);
    assert.ok(android.json().credential);
    const inboxId = randomUUID();
    const created = await f.app.inject({
      method: 'POST',
      url: '/api/commands/CreateInboxEntry',
      headers: { origin, cookie: f.alice.cookie },
      payload: f.command({
        inboxId,
        scopeId: f.alice.session.scopes.find((s) => s.kind === 'private')!.scopeId,
        text: 'A hidden gift',
        capturedAt: 1000,
        source: { kind: 'typed' },
        attachments: [],
      }),
    });
    assert.equal(created.json().status, 'Applied');
    assert.equal(
      (
        await f.app.inject({
          url: `/api/inbox/${inboxId}`,
          headers: { authorization: `Bearer ${android.json().credential}` },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin: 'https://unrelated.invalid' },
          payload: { username: 'alice', clientKind: 'browser' },
        })
      ).statusCode,
      403,
    );
    f.db.prepare('UPDATE people SET active=0 WHERE username=?').run('bob');
    assert.equal((await choose('bob')).statusCode, 401);
  } finally {
    await f.close();
  }
});
test('HTTP invalid arguments produce durable receipts; malformed envelopes do not', async () => {
  const f = await fixture();
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/commands/CreateInboxEntry',
      headers: { origin, cookie: f.alice.cookie },
      payload: f.command({ text: 45 }),
    };
    const first = await f.app.inject(request);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'Rejected');
    const retry = await f.app.inject(request);
    assert.equal(retry.json().replayed, true);
    assert.equal((await f.app.inject({ ...request, payload: { arguments: {} } })).statusCode, 400);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM operation_receipts').get() as { n: number }).n, 1);
  } finally {
    await f.close();
  }
});
test('private photo capture publishes verified bytes, replays once, and protects live attachments from GC', async () => {
  const f = await fixture();
  try {
    const scopeId = f.alice.session.scopes.find((s) => s.kind === 'private')!.scopeId;
    const mediaId = randomUUID();
    const headers = { origin, cookie: f.alice.cookie };
    const manifest = {
      scopeId,
      expectedServerEpoch: f.alice.session.serverEpoch,
      digest: sha256(png),
      byteLength: png.length,
      mimeType: 'image/png',
    };
    assert.equal(
      (
        await f.app.inject({
          method: 'POST',
          url: `/api/media/${mediaId}/prepare`,
          headers,
          payload: manifest,
        })
      ).statusCode,
      200,
    );
    const upload = {
      method: 'PUT' as const,
      url: `/api/media/${mediaId}/bytes`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-server-epoch': f.alice.session.serverEpoch,
      },
      payload: png,
    };
    assert.equal((await f.app.inject(upload)).json().state, 'ready');
    assert.equal((await f.app.inject(upload)).json().state, 'ready');
    const inboxId = randomUUID();
    const capture = {
      method: 'POST' as const,
      url: '/api/commands/CreateInboxEntry',
      headers,
      payload: f.command({
        inboxId,
        scopeId,
        text: '',
        capturedAt: 500,
        source: { kind: 'photo' },
        attachments: [
          {
            attachmentId: randomUUID(),
            mediaId,
            digest: manifest.digest,
            byteLength: png.length,
            mimeType: 'image/png',
            position: 0,
          },
        ],
      }),
    };
    assert.equal((await f.app.inject(capture)).json().status, 'Applied');
    assert.equal((await f.app.inject(capture)).json().replayed, true);
    const own = await f.app.inject({ url: `/api/media/${mediaId}`, headers });
    assert.deepEqual(own.rawPayload, png);
    assert.equal(own.headers['cache-control'], 'no-store');
    assert.equal(
      (await f.app.inject({ url: `/api/media/${mediaId}`, headers: { cookie: f.bob.cookie } })).statusCode,
      404,
    );
    assert.equal(
      (await f.app.inject({ url: `/api/inbox/${inboxId}/history`, headers: { cookie: f.bob.cookie } }))
        .statusCode,
      404,
    );
    f.advance(3 * 86400000);
    assert.equal(await f.media.collect(), 0);
    assert.equal((await f.app.inject({ url: `/api/media/${mediaId}`, headers })).statusCode, 200);
    await f.app.inject({
      method: 'POST',
      url: '/api/commands/DeleteInboxEntry',
      headers,
      payload: f.command({ inboxId, expectedRevision: 1 }),
    });
    f.advance(2 * 86400000);
    const release = await f.retention.hold();
    assert.equal(await f.media.collect(), 0);
    release();
    assert.equal(await f.media.collect(), 1);
    assert.equal((await f.app.inject({ url: `/api/media/${mediaId}`, headers })).statusCode, 404);
    const restore = await f.app.inject({
      method: 'POST',
      url: '/api/commands/RestoreInboxEntry',
      headers,
      payload: f.command({ inboxId, expectedRevision: 2 }),
    });
    assert.equal(restore.json().code, 'media_unavailable');
  } finally {
    await f.close();
  }
});
test('failed content digest never publishes or accepts a declared photo', async () => {
  const f = await fixture();
  try {
    const mediaId = randomUUID();
    const scopeId = f.alice.session.scopes[0]!.scopeId;
    const headers = { origin, cookie: f.alice.cookie };
    await f.app.inject({
      method: 'POST',
      url: `/api/media/${mediaId}/prepare`,
      headers,
      payload: {
        scopeId,
        expectedServerEpoch: f.alice.session.serverEpoch,
        digest: 'a'.repeat(64),
        byteLength: png.length,
        mimeType: 'image/png',
      },
    });
    const result = await f.app.inject({
      method: 'PUT',
      url: `/api/media/${mediaId}/bytes`,
      headers: {
        ...headers,
        'content-type': 'application/octet-stream',
        'x-server-epoch': f.alice.session.serverEpoch,
      },
      payload: png,
    });
    assert.equal(result.statusCode, 400);
    const row = f.db.prepare('SELECT state,storage_key FROM media_objects WHERE media_id=?').get(mediaId) as {
      state: string;
      storage_key: string;
    };
    assert.equal(row.state, 'staging');
    assert.equal(existsSync(f.media.files.path(row.storage_key)), false);
  } finally {
    await f.close();
  }
});

test('record photo edits reorder stable placements, replay receipts and retain bytes until the last live reference disappears', async () => {
  const f = await fixture();
  try {
    const scopeId = f.alice.session.scopes.find(s => s.kind === 'shared')!.scopeId;
    const headers = { origin, cookie: f.alice.cookie };
    const run = async (kind: CommandKind, args: unknown, cookie = f.alice.cookie) => {
      const result = await f.app.inject({ method: 'POST', url: `/api/commands/${kind}`, headers: { origin, cookie }, payload: f.command(args) });
      assert.equal(result.statusCode, 200, result.body); return result.json();
    };
    const photos: Attachment[] = [];
    for (let position = 0; position < 2; position++) {
      const mediaId = randomUUID();
      const descriptor: Attachment = { attachmentId: randomUUID(), mediaId, digest: sha256(png), byteLength: png.length, mimeType: 'image/png', position };
      await f.app.inject({ method: 'POST', url: `/api/media/${mediaId}/prepare`, headers,
        payload: { scopeId, expectedServerEpoch: f.alice.session.serverEpoch, digest: descriptor.digest, byteLength: png.length, mimeType: 'image/png' } });
      assert.equal((await f.app.inject({ method: 'PUT', url: `/api/media/${mediaId}/bytes`, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-server-epoch': f.alice.session.serverEpoch }, payload: png })).statusCode, 200);
      photos.push(descriptor);
    }
    const inboxId = randomUUID(), taskId = randomUUID();
    assert.equal((await run('CreateInboxEntry', { inboxId, scopeId, text: 'Receipt originals', capturedAt: 500, source: { kind: 'photo' }, attachments: photos })).status, 'Applied');
    assert.equal((await run('CreateTask', { recordId: taskId, occurrenceId: randomUUID(), scopeId, title: 'Install filter', instructions: '', context: 'home',
      defaultAssigneeId: null, defaultPriority: 0, recurrence: null, assigneeId: null, priority: 0, deadlineDate: null, targetDate: null, reviewDate: null })).status, 'Applied');
    const linked = photos.map(a => ({ ...a, attachmentId: randomUUID() }));
    // A partner can reuse already attached shared bytes, while owning distinct placements.
    assert.equal((await run('SetRecordAttachments', { recordId: taskId, expectedRevision: 1, attachments: linked }, f.bob.cookie)).status, 'Applied');
    const swapped = [ { ...linked[1]!, position: 0, caption: 'Model number' }, { ...linked[0]!, position: 1, caption: 'Receipt' } ];
    const envelope = f.command({ recordId: taskId, expectedRevision: 2, attachments: swapped });
    const request = { method: 'POST' as const, url: '/api/commands/SetRecordAttachments', headers, payload: envelope };
    const result = (await f.app.inject(request)).json(); assert.equal(result.status, 'Applied');
    const undo = await run('UndoChangeSet', { changeSetId: result.changeSetId }); assert.equal(undo.status, 'Applied');
    assert.equal((await run('RedoChangeSet', { changeSetId: undo.changeSetId })).status, 'Applied');
    const task = () => f.db.prepare('SELECT revision FROM records WHERE record_id=?').get(taskId) as { revision: number };
    const history = (await f.app.inject({ url: `/api/records/${taskId}/history`, headers })).json().entries;
    assert.deepEqual(history[0].version.attachments, swapped);
    assert.deepEqual(history.at(-1).version.attachments, []);
    assert.equal((await run('DeleteInboxEntry', { inboxId, expectedRevision: 1 })).status, 'Applied');
    f.advance(3 * 86400000); assert.equal(await f.media.collect(), 0);
    const removed = await run('SetRecordAttachments', { recordId: taskId, expectedRevision: task().revision, attachments: [] });
    assert.equal(removed.status, 'Applied');
    const count = f.db.prepare('SELECT count(*) AS n FROM attachments WHERE record_id=?').get(taskId) as { n: number };
    assert.equal(count.n, 2, 'removed placement identities remain');
    f.advance(2 * 86400000); assert.equal(await f.media.collect(), 2);
    const unavailableUndo = await run('UndoChangeSet', { changeSetId: removed.changeSetId });
    assert.equal(unavailableUndo.code, 'media_unavailable');
    assert.equal((await f.app.inject(request)).json().replayed, true, 'lost reply cannot restore removed photos');
    const versions = (await f.app.inject({ url: `/api/records/${taskId}/history`, headers })).json().entries;
    assert.deepEqual(versions[0].version.attachments, []);
    assert.deepEqual(versions[1].version.attachments, swapped, 'text and descriptors survive media collection');
  } finally { await f.close(); }
});

test('attachment edits guard privacy, parent revisions, empty captures and atomic validation', async () => {
  const f = await fixture();
  try {
    const shared = f.alice.session.scopes.find(s => s.kind === 'shared')!.scopeId;
    const privateScope = f.alice.session.scopes.find(s => s.kind === 'private')!.scopeId;
    const headers = { origin, cookie: f.alice.cookie };
    const run = async (kind: CommandKind, args: unknown, cookie = f.alice.cookie) => (await f.app.inject({ method: 'POST', url: `/api/commands/${kind}`, headers: { origin, cookie }, payload: f.command(args) })).json();
    const photo: Attachment = { attachmentId: randomUUID(), mediaId: randomUUID(), digest: sha256(png), byteLength: png.length, mimeType: 'image/png', position: 0 };
    await f.app.inject({ method: 'POST', url: `/api/media/${photo.mediaId}/prepare`, headers, payload: { scopeId: privateScope, expectedServerEpoch: f.alice.session.serverEpoch, digest: photo.digest, byteLength: png.length, mimeType: photo.mimeType } });
    await f.app.inject({ method: 'PUT', url: `/api/media/${photo.mediaId}/bytes`, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-server-epoch': f.alice.session.serverEpoch }, payload: png });
    const privateId = randomUUID(), sharedId = randomUUID();
    assert.equal((await run('CreateInboxEntry', { inboxId: privateId, scopeId: privateScope, text: '', capturedAt: 500, source: { kind: 'photo' }, attachments: [photo] })).status, 'Applied');
    assert.equal((await run('CreateInboxEntry', { inboxId: sharedId, scopeId: shared, text: 'Keep this note', capturedAt: 500, source: { kind: 'typed' }, attachments: [] })).status, 'Applied');
    assert.equal((await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [] })).code, 'empty_entry');
    assert.equal((await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [] }, f.bob.cookie)).code, 'unavailable');
    assert.equal((await run('SetRecordAttachments', { recordId: sharedId, expectedRevision: 1, attachments: [{ ...photo, attachmentId: randomUUID() }] })).code, 'media_unavailable');
    assert.throws(() => f.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,NULL)').run(randomUUID(), sharedId, photo.mediaId, null, 0), /attachment_scope_mismatch/);
    const duplicate = await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [photo, { ...photo, attachmentId: randomUUID() }] });
    assert.equal(duplicate.code, 'duplicate_attachment');
    const changed = await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [{ ...photo, caption: 'Private receipt' }] });
    assert.equal(changed.status, 'Applied');
    assert.equal((await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [photo] })).code, 'revision_conflict');
    const failed = await run('SetRecordAttachments', { recordId: privateId, expectedRevision: 2, attachments: [{ ...photo, caption: 'Must roll back' }, { ...photo, attachmentId: randomUUID(), mediaId: randomUUID(), position: 1 }] });
    assert.equal(failed.status, 'Deferred');
    const entry = (await f.app.inject({ url: `/api/inbox/${privateId}`, headers })).json();
    assert.equal(entry.revision, 2); assert.equal(entry.attachments[0].caption, 'Private receipt');
  } finally { await f.close(); }
});
