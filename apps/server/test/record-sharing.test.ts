import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { migrationsRoot } from '../src/paths.js';
import { migrate } from '../src/infrastructure/database.js';
import { randomUUID } from 'node:crypto';
import { emptyRecipeFields } from '@our-place/contracts';
import { sha256 } from '../src/features/media/file-media-store.js';
import type { CommandKind, CommandOutcome, SharingPreview } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { installation } from '../src/infrastructure/database.js';

async function fixture() {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' };
  const partner = { authorization: `Bearer ${'b'.repeat(43)}` };
  const context = service.access.authenticate('a'.repeat(43));
  const scopeId = service.access.scopes(context).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown) => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(f.db).recovery_epoch,
    arguments: args,
  });
  const post = async (kind: CommandKind, args: unknown, command = envelope(args)) => {
    const response = await service.app.inject({
      method: 'POST',
      url: `/api/commands/${kind}`,
      headers,
      payload: command,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<CommandOutcome>();
  };
  const applied = async (kind: CommandKind, args: unknown) => {
    const result = await post(kind, args);
    assert.equal(result.status, 'Applied', JSON.stringify(result));
    return result;
  };
  const preview = async (id: string) => {
    const response = await service.app.inject({ url: `/api/records/${id}/sharing`, headers });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<SharingPreview>();
  };
  const note = async (text: string) => {
    const inboxId = randomUUID();
    await applied('CreateInboxEntry', {
      inboxId,
      scopeId,
      text,
      capturedAt: 100,
      source: { kind: 'typed' },
      attachments: [],
    });
    return inboxId;
  };
  return {
    ...f,
    ...service,
    headers,
    partner,
    context,
    scopeId,
    envelope,
    post,
    applied,
    preview,
    note,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('explicit sharing preserves history, unrelated privacy, identity and replay; stale preview cannot share', async () => {
  const f = await fixture();
  try {
    const identity = installation(f.db);
    const id = await f.note('Before sharing'),
      unrelated = await f.note('Keep private');
    assert.equal(
      (await f.app.inject({ url: `/api/records/${id}/sharing`, headers: f.partner })).statusCode,
      404,
    );
    const old = await f.preview(id);
    await f.applied('SetInboxEntryText', { inboxId: id, expectedRevision: 1, text: 'Latest content' });
    const stale = await f.post('ShareRecords', { recordId: id, token: old.token });
    assert.equal(stale.status, 'Rejected');
    assert.equal(f.inbox.get(f.context, id).scopeId, f.scopeId);
    const preview = await f.preview(id);
    assert.deepEqual(
      preview.records.map((r) => r.recordId),
      [id],
    );
    const args = { recordId: id, token: preview.token },
      command = f.envelope(args);
    const shared = await f.post('ShareRecords', args, command);
    assert.equal(shared.status, 'Applied', JSON.stringify(shared));
    const replay = await f.post('ShareRecords', args, command);
    assert.equal(replay.status, 'Applied');
    assert.equal(replay.replayed, true);
    const history = await f.app.inject({ url: `/api/inbox/${id}/history`, headers: f.partner });
    assert.equal(history.statusCode, 200);
    assert.deepEqual(
      history.json().entries.map((e: any) => e.version.text),
      ['Latest content', 'Latest content', 'Before sharing'],
    );
    assert.equal(
      (await f.app.inject({ url: `/api/inbox/${unrelated}`, headers: f.partner })).statusCode,
      404,
    );
    if (shared.status === 'Applied')
      assert.equal((await f.post('UndoChangeSet', { changeSetId: shared.changeSetId })).status, 'Rejected');
    assert.deepEqual(installation(f.db), identity);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('sharing a page explicitly includes its project, siblings, historical links and photos', async () => {
  const f = await fixture();
  try {
    const project = randomUUID(),
      page = randomUUID(),
      sibling = randomUUID(),
      linked = await f.note('Linked private note');
    await f.applied('CreateProject', {
      recordId: project,
      scopeId: f.scopeId,
      title: 'Private project',
      description: '',
    });
    for (const id of [page, sibling])
      await f.applied('CreateProjectPage', {
        recordId: id,
        projectId: project,
        parentPageId: null,
        title: 'Page',
        blocks: [],
      });
    await f.applied('UpdateProjectPage', {
      recordId: page,
      expectedRevision: 1,
      title: 'Page',
      blocks: [{ blockId: randomUUID(), kind: 'record_link', recordId: linked, caption: '' }],
    });
    await f.applied('UpdateProjectPage', { recordId: page, expectedRevision: 2, title: 'Page', blocks: [] });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
      'base64',
    );
    const mediaId = randomUUID(),
      descriptor = { digest: sha256(png), byteLength: png.length, mimeType: 'image/png' as const };
    f.media.prepare(f.context, mediaId, {
      scopeId: f.scopeId,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      ...descriptor,
    });
    await f.media.transfer(f.context, mediaId, installation(f.db).recovery_epoch, png);
    await f.applied('SetRecordAttachments', {
      recordId: page,
      expectedRevision: 3,
      attachments: [{ attachmentId: randomUUID(), mediaId, ...descriptor, caption: '', position: 0 }],
    });
    await f.applied('SetRecordAttachments', { recordId: page, expectedRevision: 4, attachments: [] });
    assert.equal((await f.app.inject({ url: `/api/media/${mediaId}`, headers: f.partner })).statusCode, 404);
    await f.applied('SetRecordPin', {
      recordId: linked,
      scopeId: f.scopeId,
      expectedViewRevision: 0,
      pinned: true,
      viewKind: 'project_next',
      projectId: project,
    });
    const preview = await f.preview(page);
    assert.deepEqual(
      new Set(preview.records.map((r) => r.recordId)),
      new Set([project, page, sibling, linked]),
    );
    await f.applied('ShareRecords', { recordId: page, token: preview.token });
    const snapshot = (await f.app.inject({ url: '/api/cache/inbox', headers: f.partner })).json();
    assert.ok(JSON.stringify(snapshot.projects).includes(project));
    assert.ok(JSON.stringify(snapshot.projects).includes(sibling));
    const photo = await f.app.inject({ url: `/api/media/${mediaId}`, headers: f.partner });
    assert.equal(photo.statusCode, 200);
    assert.deepEqual(photo.rawPayload, png);
    assert.equal(
      (await f.app.inject({ url: `/api/records/${page}/history`, headers: f.partner })).statusCode,
      200,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('sharing maintains shopping purchases and maintenance task completion relationships', async () => {
  const f = await fixture();
  try {
    const list = randomUUID(),
      item = randomUUID(),
      purchase = randomUUID();
    await f.applied('CreateShoppingList', {
      recordId: list,
      scopeId: f.scopeId,
      name: 'Private list',
      purpose: 'household',
    });
    await f.applied('AddShoppingEntry', {
      recordId: item,
      listId: list,
      label: 'Soap',
      quantity: '1',
      notes: '',
    });
    await f.applied('PurchaseShoppingEntry', {
      recordId: item,
      expectedRevision: 1,
      purchaseId: purchase,
      purchaseItemId: randomUUID(),
      boughtAt: 100,
    });
    const p = await f.preview(item);
    assert.deepEqual(new Set(p.records.map((r) => r.recordId)), new Set([list, item, purchase]));
    await f.applied('ShareRecords', { recordId: item, token: p.token });
    const asset = randomUUID(),
      task = randomUUID(),
      occurrence = randomUUID(),
      completion = randomUUID();
    await f.applied('CreateHomeAsset', {
      recordId: asset,
      scopeId: f.scopeId,
      name: 'Filter',
      model: '',
      serial: '',
      location: '',
      acquiredDate: null,
      notes: '',
    });
    await f.applied('CreateTask', {
      recordId: task,
      occurrenceId: occurrence,
      scopeId: f.scopeId,
      title: 'Clean filter',
      instructions: '',
      context: 'home',
      defaultAssigneeId: null,
      defaultPriority: 1,
      recurrence: null,
      assigneeId: null,
      priority: 1,
      deadlineDate: null,
      targetDate: null,
      reviewDate: null,
      maintenance: { assetId: asset, reference: '' },
    });
    await f.applied('CompleteTaskOccurrence', {
      recordId: occurrence,
      expectedRevision: 1,
      expectedTaskRevision: 1,
      completionId: completion,
      nextOccurrenceId: null,
      completedAt: 100,
      performedByPersonId: f.context.personId,
      note: 'Done',
    });
    const t = await f.preview(asset);
    assert.ok([asset, task, occurrence, completion].every((id) => t.records.some((r) => r.recordId === id)));
    assert.ok(t.records.some((r) => r.kind === 'maintenance_record'));
    await f.applied('ShareRecords', { recordId: asset, token: t.token });
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('recipe collections and queued import provenance move together without widening old worker authority', async () => {
  const f = await fixture();
  try {
    const recipe = randomUUID(),
      collection = randomUUID();
    await f.applied('CreateRecipeCollection', {
      recordId: collection,
      scopeId: f.scopeId,
      name: 'Personal favourites',
    });
    await f.applied('CreateRecipe', {
      recordId: recipe,
      scopeId: f.scopeId,
      ...emptyRecipeFields(),
      title: 'Soup',
      collectionIds: [collection],
    });
    await f.applied('RequestRecipeImport', {
      recordId: recipe,
      expectedRevision: 1,
      importId: randomUUID(),
      url: 'https://example.com/soup',
    });
    const p = await f.preview(recipe);
    assert.deepEqual(new Set(p.records.map((r) => r.recordId)), new Set([recipe, collection]));
    const grants = f.db.prepare('SELECT * FROM worker_jobs WHERE target_record_id=?').all(recipe) as any[];
    await f.applied('ShareRecords', { recordId: recipe, token: p.token });
    const after = f.db.prepare('SELECT * FROM worker_jobs WHERE target_record_id=?').all(recipe) as any[];
    assert.equal(after.length, grants.length);
    assert.equal(after[0].expected_revision, grants[0].expected_revision);
    assert.equal(f.recipeImports.claim(), null);
    assert.equal(
      (f.db.prepare('SELECT active FROM recipe_imports WHERE recipe_id=?').get(recipe) as any).active,
      0,
    );
    assert.throws(
      () => f.db.prepare('UPDATE worker_jobs SET expected_revision=expected_revision+1').run(),
      /immutable/,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('private suggestion discussion is explicitly included and shared atomically', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(),
      message = randomUUID();
    await f.applied('CreateInboxEntry', {
      inboxId: id,
      scopeId: f.scopeId,
      category: 'app_suggestion',
      text: 'Private suggestion',
      capturedAt: 100,
      source: { kind: 'typed' },
      attachments: [],
    });
    await f.applied('PostSuggestionMessage', {
      recordId: message,
      suggestionId: id,
      scopeId: f.scopeId,
      text: 'Private reply',
      replyToQuestionId: null,
      requestWork: false,
      attachments: [],
    });
    const preview = await f.preview(id);
    assert.ok(preview.records.some((r) => r.recordId === message));
    assert.ok(preview.records.some((r) => r.kind === 'suggestion_workflow'));
    await f.applied('ShareRecords', { recordId: id, token: preview.token });
    const response = await f.app.inject({ url: `/api/suggestions/${id}/messages`, headers: f.partner });
    assert.equal(response.statusCode, 200);
    assert.ok(response.body.includes('Private reply'));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('sharing migration preserves all existing rows and installation identity', async () => {
  const f = await integrationFixture();
  try {
    const old = join(f.root, 'before-sharing');
    await mkdir(old);
    for (const name of await readdir(migrationsRoot))
      if (/^\d+_.*\.sql$/.test(name) && name < '028_')
        await copyFile(join(migrationsRoot, name), join(old, name));
    migrate(f.db, old);
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    const snapshot = () => tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    migrate(f.db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('failure after scope writes rolls back records, media, history and receipts together', async () => {
  const f = await fixture();
  try {
    const id = await f.note('Atomic sharing');
    const preview = await f.preview(id);
    const tables = [
      'records',
      'inbox_entries',
      'media_objects',
      'attachments',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const snapshot = () => tables.map((table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    f.db.exec(
      "CREATE TRIGGER fail_sharing_history BEFORE INSERT ON change_sets WHEN NEW.operation_kind='ShareRecords' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;",
    );
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/commands/ShareRecords',
      headers: f.headers,
      payload: f.envelope({ recordId: id, token: preview.token }),
    });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
