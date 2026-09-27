import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  emptyRecipeFields,
  type CommandKind,
  type CommandOutcome,
  type Recipe,
  type Attachment,
} from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { installation } from '../src/infrastructure/database.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { RecipeImports } from '../src/features/recipes/imports.js';
import { RecipeImportWorker } from '../src/features/recipes/import-worker.js';
import { extractRecipeMetadata } from '../src/features/recipes/extractor.js';
import type { RecipeSourceResult } from '../src/features/recipes/source-reader.js';
import { PublicFetchError } from '../src/infrastructure/public-web.js';
import { NotFound, Unauthenticated } from '../src/application/errors.js';
import { sha256 } from '../src/features/media/file-media-store.js';
import { initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
  'base64',
);
function source(names = ['Source soup'], image = false): RecipeSourceResult {
  const html = `<script type="application/ld+json">${JSON.stringify(
    names.map((name) => ({
      '@type': 'Recipe',
      name,
      recipeIngredient: ['2 carrots'],
      recipeInstructions: ['Chop and cook.'],
      ...(image ? { image: 'https://example.com/soup.png' } : {}),
    })),
  )}</script>`;
  return {
    extraction: extractRecipeMetadata(html, 'https://example.com/soup'),
    page: {
      mediaType: 'text/html',
      encoding: 'UTF-8',
      byteLength: Buffer.byteLength(html),
      sha256: sha256(Buffer.from(html)),
    },
  };
}
function applied(result: CommandOutcome) {
  assert.equal(result.status, 'Applied', JSON.stringify(result));
  if (result.status !== 'Applied') throw new Error();
  return result;
}
function rejected(result: CommandOutcome, code: string) {
  assert.equal(result.status, 'Rejected', JSON.stringify(result));
  if (result.status === 'Rejected') assert.equal(result.code, code);
}
async function fixture() {
  const f = await integrationFixture();
  const app = await buildApp({
    dataRoot: f.dataRoot,
    db: f.db,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
    backupRoot: join(f.root, 'exports'),
  });
  const a = app.access.authenticate('a'.repeat(43)),
    b = app.access.authenticate('b'.repeat(43));
  const features = createRecordFeatures(f.db, app.access);
  let failCommit = false;
  const imports = new RecipeImports(f.db, features.recipes, app.history, features.records, f.now, () => {
    if (failCommit) throw new Error('injected commit failure');
  });
  const shared = app.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = app.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown) => ({
    operationId: randomUUID(),
    expectedServerEpoch: installation(f.db).recovery_epoch,
    contractVersion: 1 as const,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, context = a) =>
    app.writes.execute(context, kind, envelope(args));
  const get = (id: string) => features.recipes.project(features.recipes.get(a, id)) as Recipe;
  const queue = (scopeId = shared) => {
    const args = {
      recordId: randomUUID(),
      importId: randomUUID(),
      scopeId,
      url: 'https://example.com/soup',
      collectionIds: [],
    };
    const request = envelope(args),
      result = applied(app.writes.execute(a, 'ImportRecipe', request));
    return { ...args, request, result };
  };
  return {
    ...f,
    ...app,
    a,
    b,
    imports,
    shared,
    privateScope,
    envelope,
    run,
    get,
    queue,
    get failCommit() {
      return failCommit;
    },
    set failCommit(value: boolean) {
      failCommit = value;
    },
    worker: (result = source()) =>
      new RecipeImportWorker(imports, app.media, {
        reader: { read: async () => result },
        web: {
          get: async () => ({
            url: 'https://example.com/soup.png',
            mediaType: 'image/png',
            contentType: 'image/png',
            bytes: png,
          }),
        },
      }),
    async close() {
      await app.app.close();
      await f.close();
    },
  };
}

test('placeholder, job, causal history and receipt commit together; lost reply does not duplicate a job', async () => {
  const f = await fixture();
  try {
    const counts = () =>
      [
        'records',
        'change_sets',
        'operation_receipts',
        'worker_actors',
        'clients',
        'background_jobs',
        'worker_jobs',
        'recipe_imports',
      ].map((table) => f.db.prepare(`SELECT count(*) FROM ${table}`).pluck().get());
    const before = counts(),
      args = {
        recordId: randomUUID(),
        importId: randomUUID(),
        scopeId: f.shared,
        url: 'https://example.com/soup',
        collectionIds: [],
      },
      command = f.envelope(args);
    f.db.exec(
      "CREATE TRIGGER fail_job BEFORE INSERT ON recipe_imports BEGIN SELECT RAISE(ABORT,'injected queue failure'); END",
    );
    assert.throws(() => f.writes.execute(f.a, 'ImportRecipe', command), /injected queue failure/);
    assert.deepEqual(counts(), before);
    f.db.exec('DROP TRIGGER fail_job');
    const first = applied(f.writes.execute(f.a, 'ImportRecipe', command));
    const once = counts();
    assert.deepEqual(applied(f.writes.execute(f.a, 'ImportRecipe', command)).receipt, first.receipt);
    assert.deepEqual(counts(), once);
    assert.equal(f.get(args.recordId).revision, 1);
    assert.equal(
      f.db.prepare('SELECT cause_change_set_id FROM worker_jobs').pluck().get(),
      first.changeSetId,
    );
    assert.equal(
      f.db
        .prepare(
          'SELECT COUNT(*) FROM client_credentials c JOIN clients p USING(client_id) WHERE p.worker_id IS NOT NULL',
        )
        .pluck()
        .get(),
      0,
    );
    rejected(
      f.run('RequestRecipeImport', {
        recordId: args.recordId,
        expectedRevision: 1,
        importId: randomUUID(),
        url: args.url,
      }),
      'import_in_progress',
    );
    assert.equal(f.get(args.recordId).revision, 1);
    rejected(
      f.run('ImportRecipe', {
        ...args,
        recordId: randomUUID(),
        importId: randomUUID(),
        url: 'http://localhost/secret',
      }),
      'invalid_source_url',
    );
  } finally {
    await f.close();
  }
});

test('automatic import publishes local photo and worker history; application receipt survives a lost acknowledgement and restoration', async () => {
  const f = await fixture();
  try {
    const q = f.queue(),
      claimed = f.imports.claim()!;
    f.imports.saveSource(claimed.context, source(['Source soup'], true));
    const candidate = source(['Source soup'], true).extraction.candidates[0]!;
    await assert.rejects(
      f.media.importImage(claimed.context, '0'.repeat(64), 'https://example.com/soup.png', png),
      /candidate_unavailable/,
    );
    await f.media.importImage(claimed.context, candidate.candidateId, 'https://example.com/soup.png', png);
    assert.equal(f.imports.freezeApplication(claimed.context), true);
    const first = applied(f.imports.apply(claimed.context)),
      saved = f.get(q.recordId);
    assert.equal(saved.title, 'Source soup');
    assert.equal(saved.ingredients[0]!.text, '2 carrots');
    assert.deepEqual((await f.media.read(f.b, saved.attachments[0]!.mediaId)).bytes, png);
    const entry = f.history.list(f.a, q.recordId, 'recipe')[0]!;
    assert.equal('kind' in entry.actor && entry.actor.kind, 'worker');
    assert.equal(entry.causeChangeSetId, q.result.changeSetId);
    const before = f.db.prepare('SELECT count(*) FROM change_sets').pluck().get();
    assert.deepEqual(applied(f.imports.apply(claimed.context)).receipt, first.receipt);
    assert.equal(f.db.prepare('SELECT count(*) FROM change_sets').pluck().get(), before);
    assert.deepEqual(f.get(q.recordId), saved);
    const undo = f.run('UndoChangeSet', { changeSetId: q.result.changeSetId });
    assert.equal(undo.status, 'Rejected');
    f.db.prepare('UPDATE installation_state SET recovery_epoch=?').run(randomUUID());
    assert.deepEqual(applied(f.imports.apply(claimed.context)).receipt, first.receipt);
  } finally {
    await f.close();
  }
});

test('partner adjustment during download causes review; chosen fields preserve notes, membership, directions and manual photos', async () => {
  const f = await fixture();
  try {
    const q = f.queue();
    let deliver!: (value: RecipeSourceResult) => void;
    const worker = new RecipeImportWorker(f.imports, f.media, {
      reader: {
        read: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      },
    });
    const pending = worker.tick();
    applied(
      f.run(
        'SetRecipeAdjustment',
        {
          recordId: q.recordId,
          expectedRevision: 1,
          adjustmentId: randomUUID(),
          body: 'Less salt next time',
        },
        f.b,
      ),
    );
    deliver(source());
    await pending;
    assert.equal(f.get(q.recordId).title, 'example.com');
    const detail = f.imports.detail(f.a, q.importId);
    assert.equal(detail.state, 'review');
    assert.equal(detail.errorCode, 'revision_conflict');
    assert.equal(f.get(q.recordId).adjustments[0]!.body, 'Less salt next time');
    const manual = await addManualPhoto(f, q.recordId);
    const original = f.get(q.recordId);
    applied(
      f.run('UpdateRecipe', {
        ...emptyRecipeFields(),
        title: 'My name',
        sourceUrl: original.sourceUrl,
        ingredients: [{ ingredientId: randomUUID(), text: 'My carrots' }],
        steps: [{ stepId: randomUUID(), text: 'My directions' }],
        recordId: q.recordId,
        expectedRevision: original.revision,
      }),
    );
    applied(
      f.run('ApplyRecipeImport', {
        recordId: q.recordId,
        expectedRevision: f.get(q.recordId).revision,
        importId: q.importId,
        candidateId: detail.candidates[0]!.candidateId,
        fields: ['title'],
      }),
    );
    const saved = f.get(q.recordId);
    assert.equal(saved.title, 'Source soup');
    assert.equal(saved.ingredients[0]!.text, 'My carrots');
    assert.equal(saved.steps[0]!.text, 'My directions');
    assert.equal(saved.adjustments[0]!.body, 'Less salt next time');
    assert.equal(saved.attachments[0]!.mediaId, manual.mediaId);
    assert.equal(f.history.list(f.a, q.recordId, 'recipe')[0]!.actor.personId, f.a.personId);
  } finally {
    await f.close();
  }
});

async function addManualPhoto(f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<Attachment> {
  const photo: Attachment = {
    attachmentId: randomUUID(),
    mediaId: randomUUID(),
    digest: sha256(png),
    byteLength: png.length,
    mimeType: 'image/png',
    position: 0,
  };
  f.media.prepare(f.a, photo.mediaId, {
    scopeId: f.get(id).scopeId,
    expectedServerEpoch: installation(f.db).recovery_epoch,
    digest: photo.digest,
    byteLength: photo.byteLength,
    mimeType: 'image/png',
  });
  await f.media.transfer(f.a, photo.mediaId, installation(f.db).recovery_epoch, png);
  applied(
    f.run('SetRecordAttachments', {
      recordId: id,
      expectedRevision: f.get(id).revision,
      attachments: [photo],
    }),
  );
  return photo;
}

test('ambiguous sources require an explicit choice, and private pending images cannot be read or attached to another recipe', async () => {
  const f = await fixture();
  try {
    const q = f.queue(f.privateScope);
    await f.worker(source(['Soup one', 'Soup two'], true)).tick();
    const detail = f.imports.detail(f.a, q.importId);
    assert.equal(detail.state, 'review');
    assert.equal(detail.candidates.length, 2);
    assert.equal(f.get(q.recordId).revision, 1);
    assert.throws(() => f.imports.detail(f.b, q.importId), NotFound);
    const image = detail.candidates[1]!.image!;
    assert.deepEqual((await f.media.read(f.a, image.mediaId)).bytes, png);
    await assert.rejects(f.media.read(f.b, image.mediaId), NotFound);
    const otherId = randomUUID();
    applied(
      f.run('CreateRecipe', {
        ...emptyRecipeFields(),
        title: 'Other recipe',
        recordId: otherId,
        scopeId: f.privateScope,
        collectionIds: [],
      }),
    );
    rejected(
      f.run('SetRecordAttachments', { recordId: otherId, expectedRevision: 1, attachments: [image] }),
      'media_unavailable',
    );
    const response = await f.app.inject({
      method: 'GET',
      url: `/api/recipe-imports/${q.importId}`,
      headers: { authorization: `Bearer ${'b'.repeat(43)}` },
    });
    assert.equal(response.statusCode, 404);
    applied(
      f.run('ApplyRecipeImport', {
        recordId: q.recordId,
        expectedRevision: 1,
        importId: q.importId,
        candidateId: detail.candidates[1]!.candidateId,
        fields: ['title', 'photo'],
      }),
    );
    assert.equal(f.get(q.recordId).title, 'Soup two');
    assert.equal(f.get(q.recordId).attachments[0]!.mediaId, image.mediaId);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('commit failure rolls back content, attachment placement, history, receipt and completion; restart applies exact frozen IDs without refetch', async () => {
  const f = await fixture();
  try {
    const q = f.queue(),
      claim = f.imports.claim()!,
      result = source(['Stable soup'], true);
    f.imports.saveSource(claim.context, result);
    await f.media.importImage(
      claim.context,
      result.extraction.candidates[0]!.candidateId,
      'https://example.com/soup.png',
      png,
    );
    f.imports.freezeApplication(claim.context);
    const frozen = f.db
      .prepare('SELECT application_json FROM recipe_imports WHERE recipe_import_id=?')
      .pluck()
      .get(q.importId) as string;
    const content = f.get(q.recordId),
      changes = f.db.prepare('SELECT count(*) FROM change_sets').pluck().get();
    f.failCommit = true;
    assert.throws(() => f.imports.apply(claim.context), /injected commit failure/);
    assert.deepEqual(f.get(q.recordId), content);
    assert.equal(f.db.prepare('SELECT count(*) FROM change_sets').pluck().get(), changes);
    assert.equal(
      f.db.prepare('SELECT count(*) FROM operation_receipts WHERE actor_worker_id IS NOT NULL').pluck().get(),
      0,
    );
    assert.equal(f.imports.detail(f.a, q.importId).state, 'ready');
    f.failCommit = false;
    f.setTime(301001);
    let calls = 0;
    const worker = new RecipeImportWorker(f.imports, f.media, {
      reader: {
        read: async () => {
          calls++;
          throw new Error('No refetch');
        },
      },
      web: {
        get: async () => {
          calls++;
          throw new Error('No refetch');
        },
      },
    });
    await worker.tick();
    assert.equal(calls, 0);
    const expected = JSON.parse(frozen).patch;
    assert.deepEqual(f.get(q.recordId).ingredients, expected.ingredients);
    assert.deepEqual(f.get(q.recordId).attachments, expected.attachments);
    assert.equal(f.imports.detail(f.a, q.importId).state, 'complete');
    assert.throws(() => f.imports.source(claim.context), Unauthenticated);
  } finally {
    await f.close();
  }
});

test('fetch failure keeps the URL card; deletion and cancellation cannot resurrect it; shutdown releases work for restart', async () => {
  const f = await fixture();
  try {
    const failed = f.queue();
    await new RecipeImportWorker(f.imports, f.media, {
      reader: {
        read: async () => {
          throw new PublicFetchError('source_unavailable');
        },
      },
    }).tick();
    assert.equal(f.imports.detail(f.a, failed.importId).state, 'failed');
    assert.equal(f.get(failed.recordId).sourceUrl, failed.url);
    const deleted = f.queue();
    applied(f.run('DeleteRecipe', { recordId: deleted.recordId, expectedRevision: 1 }));
    await f.worker().tick();
    assert.equal(f.imports.detail(f.a, deleted.importId).state, 'abandoned');
    const cancel = f.queue();
    let deliver!: (value: RecipeSourceResult) => void;
    const worker = new RecipeImportWorker(f.imports, f.media, {
        reader: {
          read: () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
        },
      }),
      pending = worker.tick();
    applied(f.run('CancelRecipeImport', { importId: cancel.importId }));
    deliver(source());
    await pending;
    assert.equal(f.get(cancel.recordId).revision, 1);
    assert.equal(f.imports.detail(f.a, cancel.importId).state, 'abandoned');
    const paused = f.queue();
    const stopping = new RecipeImportWorker(f.imports, f.media, {
      reader: {
        read: (_url, signal) =>
          new Promise((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
          ),
      },
    });
    const stopped = stopping.tick();
    await stopping.stop();
    await stopped;
    assert.equal(f.imports.detail(f.a, paused.importId).state, 'queued');
    await f.worker().tick();
    assert.equal(f.imports.detail(f.a, paused.importId).state, 'complete');
  } finally {
    await f.close();
  }
});

test('backup/restore preserves pending source, completed worker receipt and media; pending jobs remain paused under the new epoch', async () => {
  const f = await fixture();
  let restored: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const complete = f.queue();
    await f.worker(source(['Done soup'], true)).tick();
    const pending = f.queue(),
      claim = f.imports.claim()!,
      pendingSource = source(['Later soup'], true);
    f.imports.saveSource(claim.context, pendingSource);
    await f.media.importImage(
      claim.context,
      pendingSource.extraction.candidates[0]!.candidateId,
      'https://example.com/later.png',
      png,
    );
    const outputRoot = join(f.root, 'exports');
    await initialiseBackupDestination(outputRoot, installation(f.db).installation_id, true);
    const backup = await f.backups.create();
    const destination = join(f.root, 'restored');
    await restoreBackup(join(outputRoot, `${backup.archive.name}.complete.json`), destination, true);
    restored = await buildApp({
      dataRoot: destination,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
    const features = createRecordFeatures(restored.db, restored.access),
      imports = restored.recipeImports;
    assert.equal(imports.detail(f.a, pending.importId).state, 'paused');
    assert.equal(imports.claim(), null);
    assert.equal(imports.detail(f.a, complete.importId).state, 'complete');
    const photo = (features.recipes.project(features.recipes.get(f.a, complete.recordId)) as Recipe)
      .attachments[0]!;
    assert.deepEqual((await restored.media.read(f.a, photo.mediaId)).bytes, png);
    assert.equal(
      restored.db
        .prepare('SELECT count(*) FROM operation_receipts WHERE actor_worker_id IS NOT NULL')
        .pluck()
        .get(),
      1,
    );
    assert.throws(() => imports.source(claim.context));
    const detail = imports.detail(f.a, pending.importId);
    assert.deepEqual((await restored.media.read(f.a, detail.candidates[0]!.image!.mediaId)).bytes, png);
    const result = restored.writes.execute(f.a, 'ApplyRecipeImport', {
      ...f.envelope({
        recordId: pending.recordId,
        expectedRevision: 1,
        importId: pending.importId,
        candidateId: detail.candidates[0]!.candidateId,
        fields: ['title', 'photo'],
      }),
      expectedServerEpoch: installation(restored.db).recovery_epoch,
    });
    applied(result);
    assert.equal(
      (features.recipes.project(features.recipes.get(f.a, pending.recordId)) as Recipe).title,
      'Later soup',
    );
  } finally {
    if (restored) await restored.app.close();
    await f.close();
  }
});

test('saved source is immutable and resumes without fetching a changed page; a stale lease cannot save or publish', async () => {
  const f = await fixture();
  try {
    const q = f.queue(),
      claim = f.imports.claim()!;
    f.imports.saveSource(claim.context, source());
    assert.throws(
      () => f.imports.saveSource(claim.context, source(['Changed soup'])),
      /import_source_frozen/,
    );
    f.setTime(301001);
    const replacement = f.imports.claim()!;
    assert.throws(() => f.imports.saveSource(claim.context, source()), Unauthenticated);
    await assert.rejects(
      f.media.importImage(
        claim.context,
        source().extraction.candidates[0]!.candidateId,
        'https://example.com/soup.png',
        png,
      ),
      Unauthenticated,
    );
    f.imports.release(replacement.context);
    await new RecipeImportWorker(f.imports, f.media, {
      reader: {
        read: async () => {
          throw new Error('must not fetch again');
        },
      },
    }).tick();
    assert.equal(f.get(q.recordId).title, 'Source soup');
    assert.equal(f.imports.detail(f.a, q.importId).state, 'complete');
  } finally {
    await f.close();
  }
});

test('cancelling during image publication leaves no usable attachment; later collection retains URI provenance', async () => {
  const f = await fixture();
  try {
    const q = f.queue(),
      claim = f.imports.claim()!,
      result = source(['Soup'], true);
    f.imports.saveSource(claim.context, result);
    const original = f.media.files.publish.bind(f.media.files);
    let published!: () => void, finish!: () => void;
    const atPublication = new Promise<void>((resolve) => {
      published = resolve;
    });
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.media.files.publish = async (key, bytes) => {
      await original(key, bytes);
      published();
      await release;
    };
    const upload = f.media.importImage(
      claim.context,
      result.extraction.candidates[0]!.candidateId,
      'https://example.com/soup.png',
      png,
    );
    const denied = assert.rejects(upload, Unauthenticated);
    await atPublication;
    applied(f.run('CancelRecipeImport', { importId: q.importId }));
    finish();
    await denied;
    const mediaId = f.db
      .prepare('SELECT media_id FROM recipe_import_media WHERE job_id=?')
      .pluck()
      .get(claim.context.jobId) as string;
    assert.equal(
      f.db.prepare('SELECT state FROM media_objects WHERE media_id=?').pluck().get(mediaId),
      'staging',
    );
    assert.deepEqual(f.get(q.recordId).attachments, []);
    await assert.rejects(f.media.read(f.a, mediaId), NotFound);
    f.setTime(2 * 86400000 + 1001);
    await f.media.collect();
    assert.equal(
      f.db.prepare('SELECT state FROM media_objects WHERE media_id=?').pluck().get(mediaId),
      'collected',
    );
    assert.equal(
      f.db.prepare('SELECT source_uri FROM recipe_import_media WHERE media_id=?').pluck().get(mediaId),
      'https://example.com/soup.png',
    );
  } finally {
    await f.close();
  }
});

test('a metadata-only refresh preserves household ingredients, directions, memberships and photos', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(),
      collectionId = randomUUID();
    applied(
      f.run('CreateRecipeCollection', { recordId: collectionId, scopeId: f.shared, name: 'Weeknight' }),
    );
    applied(
      f.run('CreateRecipe', {
        ...emptyRecipeFields(),
        recordId: id,
        scopeId: f.shared,
        title: 'My soup',
        collectionIds: [collectionId],
        ingredients: [{ ingredientId: randomUUID(), text: 'Some carrots' }],
        steps: [{ stepId: randomUUID(), text: 'Cook slowly' }],
      }),
    );
    await addManualPhoto(f, id);
    const before = f.get(id),
      importId = randomUUID();
    applied(
      f.run('RequestRecipeImport', {
        recordId: id,
        expectedRevision: before.revision,
        importId,
        url: 'https://example.com/soup',
      }),
    );
    const html = '<title>Soup page</title>',
      result: RecipeSourceResult = {
        extraction: extractRecipeMetadata(html, 'https://example.com/soup'),
        page: {
          mediaType: 'text/html',
          encoding: 'UTF-8',
          byteLength: Buffer.byteLength(html),
          sha256: sha256(Buffer.from(html)),
        },
      };
    await f.worker(result).tick();
    const after = f.get(id);
    assert.equal(after.title, 'Soup page');
    assert.deepEqual(after.ingredients, before.ingredients);
    assert.deepEqual(after.steps, before.steps);
    assert.deepEqual(after.collectionIds, before.collectionIds);
    assert.deepEqual(after.attachments, before.attachments);
    assert.equal(f.imports.snapshot(f.a).find((r) => r.recipeId === id)!.importId, importId);
  } finally {
    await f.close();
  }
});
