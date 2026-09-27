import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Attachment, CommandKind, CommandOutcome, ProjectSnapshot } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { installation } from '../src/infrastructure/database.js';
import { sha256 } from '../src/features/media/file-media-store.js';
import { ViewPreferences } from '../src/features/views/views.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
test('HTTP project cache and photos respect privacy; backup restores hierarchy, blocks, receipts, history and exact bytes', async () => {
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
  const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' },
    otherHeaders = { authorization: `Bearer ${'b'.repeat(43)}` };
  const context = service.access.authenticate('a'.repeat(43));
  const shared = service.access.scopes(context).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = service.access.scopes(context).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown) => ({
    operationId: randomUUID(),
    contractVersion: 1 as const,
    expectedServerEpoch: installation(f.db).recovery_epoch,
    arguments: args,
  });
  const post = async (kind: CommandKind, args: unknown) => {
    const command = envelope(args),
      response = await service.app.inject({
        method: 'POST',
        url: `/api/commands/${kind}`,
        headers,
        payload: command,
      });
    assert.equal(response.statusCode, 200, response.body);
    const outcome = response.json<CommandOutcome>();
    assert.equal(outcome.status, 'Applied', response.body);
    return { command, outcome };
  };
  try {
    const project = randomUUID(),
      page = randomUUID(),
      child = randomUUID(),
      privateProject = randomUUID(),
      privatePage = randomUUID();
    for (const [recordId, scopeId] of [
      [project, shared],
      [privateProject, privateScope],
    ] as const)
      await post('CreateProject', {
        recordId,
        scopeId,
        title: 'Renovation',
        description: 'Keep the references',
      });
    for (const [recordId, projectId, parentPageId] of [
      [page, project, null],
      [child, project, page],
      [privatePage, privateProject, null],
    ] as const)
      await post('CreateProjectPage', {
        recordId,
        projectId,
        parentPageId,
        title: 'Measurements',
        blocks: [{ blockId: randomUUID(), kind: 'text', text: 'Cupboard is 80 cm wide.' }],
      });
    const upload = async (scopeId: string): Promise<Attachment> => {
      const mediaId = randomUUID(),
        digest = sha256(png),
        byteLength = png.length,
        mimeType = 'image/png' as const;
      service.media.prepare(context, mediaId, {
        scopeId,
        expectedServerEpoch: installation(f.db).recovery_epoch,
        digest,
        byteLength,
        mimeType,
      });
      await service.media.transfer(context, mediaId, installation(f.db).recovery_epoch, png);
      return {
        attachmentId: randomUUID(),
        mediaId,
        digest,
        byteLength,
        mimeType,
        position: 0,
        caption: 'Measurements',
      };
    };
    const photo = await upload(shared),
      privatePhoto = await upload(privateScope);
    const saved = await post('SetRecordAttachments', {
      recordId: child,
      expectedRevision: 1,
      attachments: [photo],
    });
    await post('SetRecordAttachments', {
      recordId: privatePage,
      expectedRevision: 1,
      attachments: [privatePhoto],
    });
    const read = async (app: typeof service, requestHeaders: Record<string, string> = otherHeaders) => {
      const response = await app.app.inject({ url: '/api/cache/inbox', headers: requestHeaders });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<{ projects: ProjectSnapshot }>().projects;
    };
    const partnerCache = await read(service),
      ownerCache = await read(service, headers);
    assert.deepEqual(
      partnerCache.projects.map((p) => p.recordId),
      [project],
    );
    assert.deepEqual(partnerCache.pages.map((p) => p.recordId).sort(), [page, child].sort());
    assert.deepEqual(partnerCache.pages.find((p) => p.recordId === child)!.attachments, [photo]);
    assert.equal(
      (await service.app.inject({ url: `/api/records/${privatePage}/history`, headers: otherHeaders }))
        .statusCode,
      404,
    );
    assert.equal(
      (await service.app.inject({ url: `/api/media/${privatePhoto.mediaId}`, headers: otherHeaders }))
        .statusCode,
      404,
    );
    assert.deepEqual(
      (await service.app.inject({ url: `/api/media/${photo.mediaId}`, headers: otherHeaders })).rawPayload,
      png,
    );
    await post('SetRecordPin', {
      recordId: child,
      projectId: project,
      scopeId: shared,
      viewKind: 'project_next',
      expectedViewRevision: 0,
      pinned: true,
    });
    await post('SetRecordPin', {
      recordId: page,
      projectId: privateProject,
      scopeId: privateScope,
      viewKind: 'project_next',
      expectedViewRevision: 0,
      pinned: true,
    });
    const pinsBefore = new ViewPreferences(f.db, service.access).snapshot(context);
    const historyBefore = service.history.list(context, child, 'project_page'),
      backup = await service.backups.create();
    await post('DeleteProject', {
      recordId: project,
      expectedRevision: 1,
      pages: [
        { recordId: page, expectedRevision: 1 },
        { recordId: child, expectedRevision: 2 },
      ],
    });
    f.setTime(3 * 86400000);
    assert.equal(await service.media.collect(), 1);
    const restoredRoot = join(f.root, 'restored-projects');
    await restoreBackup(join(outputRoot, `${backup.archive.name}.complete.json`), restoredRoot, true);
    const restored = await buildApp({
      dataRoot: restoredRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: () => 1000,
    });
    try {
      assert.deepEqual(await read(restored), partnerCache);
      assert.deepEqual(await read(restored, headers), ownerCache);
      assert.deepEqual(restored.history.list(context, child, 'project_page'), historyBefore);
      assert.deepEqual(new ViewPreferences(restored.db, restored.access).snapshot(context), pinsBefore);
      assert.deepEqual((await restored.media.read(context, photo.mediaId)).bytes, png);
      assert.deepEqual(restored.writes.execute(context, 'SetRecordAttachments', saved.command), {
        ...saved.outcome,
        replayed: true,
      });
      assert.deepEqual(restored.db.pragma('foreign_key_check'), []);
    } finally {
      await restored.app.close();
    }
  } finally {
    await service.app.close();
    await f.close();
  }
});
