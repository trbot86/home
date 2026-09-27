import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  emptyRecipeFields,
  type Attachment,
  type CommandKind,
  type CommandOutcome,
  type RecipeSnapshot,
} from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { buildCaptureApp } from '../src/capture-app.js';
import { IntegrationAccessService } from '../src/features/access/integrations.js';
import { initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { installation } from '../src/infrastructure/database.js';
import { sha256 } from '../src/features/media/file-media-store.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);

test('HTTP recipe cache/history/media honour privacy, and the capture listener checks recipe integrity without exposing recipe routes', async () => {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  let capture: Awaited<ReturnType<typeof buildCaptureApp>> | undefined;
  const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' },
    otherHeaders = { authorization: `Bearer ${'b'.repeat(43)}` };
  const context = service.access.authenticate('a'.repeat(43));
  const shared = service.access.scopes(context).find((scope) => scope.kind === 'shared')!.scopeId;
  const privateScope = service.access.scopes(context).find((scope) => scope.kind === 'private')!.scopeId;
  const post = async (kind: CommandKind, args: unknown) => {
    const response = await service.app.inject({
      method: 'POST',
      url: `/api/commands/${kind}`,
      headers,
      payload: {
        operationId: randomUUID(),
        contractVersion: 1,
        expectedServerEpoch: installation(f.db).recovery_epoch,
        arguments: args,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json<CommandOutcome>();
    assert.equal(result.status, 'Applied', response.body);
    return result;
  };
  try {
    const recipeId = randomUUID(),
      privateId = randomUUID();
    await post('CreateRecipe', {
      recordId: recipeId,
      scopeId: shared,
      ...emptyRecipeFields(),
      title: 'Shared soup',
      collectionIds: [],
    });
    await post('CreateRecipe', {
      recordId: privateId,
      scopeId: privateScope,
      ...emptyRecipeFields(),
      title: 'Private cake idea',
      collectionIds: [],
    });
    const mediaId = randomUUID();
    service.media.prepare(context, mediaId, {
      scopeId: shared,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      digest: sha256(png),
      byteLength: png.length,
      mimeType: 'image/png',
    });
    await service.media.transfer(context, mediaId, installation(f.db).recovery_epoch, png);
    const photo: Attachment = {
      attachmentId: randomUUID(),
      mediaId,
      digest: sha256(png),
      byteLength: png.length,
      mimeType: 'image/png',
      position: 0,
      caption: 'Our first attempt',
    };
    await post('SetRecordAttachments', { recordId: recipeId, expectedRevision: 1, attachments: [photo] });
    const cache = await service.app.inject({ url: '/api/cache/inbox', headers: otherHeaders });
    assert.equal(cache.statusCode, 200);
    const recipes = cache.json<{ recipes: RecipeSnapshot }>().recipes.recipes;
    assert.deepEqual(
      recipes.map((recipe) => recipe.recordId),
      [recipeId],
    );
    assert.deepEqual(recipes[0]!.attachments, [photo]);
    const image = await service.app.inject({ url: `/api/media/${mediaId}`, headers: otherHeaders });
    assert.equal(image.statusCode, 200);
    assert.deepEqual(image.rawPayload, png);
    assert.equal(
      (await service.app.inject({ url: `/api/records/${privateId}/history`, headers: otherHeaders }))
        .statusCode,
      404,
    );
    assert.equal(
      (await service.app.inject({ url: `/api/records/${recipeId}/history`, headers: otherHeaders })).json()
        .entries.length,
      2,
    );
    const issued = new IntegrationAccessService(f.db, f.now).provision(context, 'Alexa fixture', 900000);
    capture = await buildCaptureApp({ db: f.db, dataRoot: f.dataRoot, now: f.now });
    const integrationHeaders = { authorization: `Bearer ${issued.secret}` };
    const captured = await capture.app.inject({
      method: 'POST',
      url: '/capture/inbox',
      headers: integrationHeaders,
      payload: {
        operationId: randomUUID(),
        expectedServerEpoch: installation(f.db).recovery_epoch,
        destination: 'inbox',
        text: 'Recipe idea from a speaker',
        capturedAt: f.now(),
      },
    });
    assert.equal(captured.statusCode, 200, captured.body);
    assert.equal(captured.json().status, 'Applied');
    assert.equal(
      (await capture.app.inject({ url: '/api/cache/inbox', headers: integrationHeaders })).statusCode,
      404,
    );
    assert.equal(
      (await service.app.inject({ url: '/api/cache/inbox', headers: integrationHeaders })).statusCode,
      401,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await capture?.app.close();
    await service.app.close();
    await f.close();
  }
});

test('a verified backup restores recipe source, notes, memberships, history and exact photo bytes after live collection', async () => {
  const f = await integrationFixture(),
    outputRoot = join(f.root, 'exports');
  await initialiseBackupDestination(outputRoot, installation(f.db).installation_id, true);
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    backupRoot: outputRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const context = service.access.authenticate('a'.repeat(43)),
    scopeId = service.access.scopes(context).find((scope) => scope.kind === 'shared')!.scopeId;
  const run = (kind: CommandKind, args: unknown) => {
    const result = service.writes.execute(context, kind, {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      arguments: args,
    });
    assert.equal(result.status, 'Applied', JSON.stringify(result));
    return result;
  };
  try {
    const recipeId = randomUUID(),
      collectionId = randomUUID(),
      mediaId = randomUUID();
    run('CreateRecipeCollection', { recordId: collectionId, scopeId, name: 'Weeknight favourites' });
    run('CreateRecipe', {
      recordId: recipeId,
      scopeId,
      ...emptyRecipeFields(),
      title: 'Soup',
      sourceUrl: 'https://recipes.example/soup',
      collectionIds: [collectionId],
      ingredients: [{ ingredientId: randomUUID(), text: '½ cup milk' }],
    });
    run('SetRecipeAdjustment', {
      recordId: recipeId,
      expectedRevision: 1,
      adjustmentId: randomUUID(),
      body: 'Use extra pepper.',
    });
    service.media.prepare(context, mediaId, {
      scopeId,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      digest: sha256(png),
      byteLength: png.length,
      mimeType: 'image/png',
    });
    await service.media.transfer(context, mediaId, installation(f.db).recovery_epoch, png);
    run('SetRecordAttachments', {
      recordId: recipeId,
      expectedRevision: 2,
      attachments: [
        {
          attachmentId: randomUUID(),
          mediaId,
          digest: sha256(png),
          byteLength: png.length,
          mimeType: 'image/png',
          position: 0,
        },
      ],
    });
    const historyBefore = service.history.list(context, recipeId, 'recipe');
    const backup = await service.backups.create();
    assert.equal(
      backup.manifest.files.some((file) => file.digest === sha256(png)),
      true,
    );
    run('DeleteRecipe', { recordId: recipeId, expectedRevision: 3 });
    f.setTime(3 * 86400000);
    assert.equal(await service.media.collect(), 1);
    const restoredRoot = join(f.root, 'restored-recipes');
    await restoreBackup(join(outputRoot, `${backup.archive.name}.complete.json`), restoredRoot, true);
    const restored = await buildApp({
      dataRoot: restoredRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: () => 1000,
    });
    try {
      assert.deepEqual(restored.history.list(context, recipeId, 'recipe'), historyBefore);
      assert.deepEqual((await restored.media.read(context, mediaId)).bytes, png);
      assert.deepEqual(restored.db.pragma('foreign_key_check'), []);
    } finally {
      await restored.app.close();
    }
  } finally {
    await service.app.close();
    await f.close();
  }
});
