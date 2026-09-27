import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyRecipeFields, type Envelope, type Recipe } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { immediate, installation, migrate, openDatabase } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService, type RequestContext } from '../src/features/access/access.js';
import { IntegrationAccessService, requireIntegration } from '../src/features/access/integrations.js';
import { ensureRecipeWorker, requireWorkerJob, type WorkerContext } from '../src/features/access/workers.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator, requestDigest } from '../src/application/write-coordinator.js';
import { Rejection, Unauthenticated } from '../src/application/errors.js';

async function fixture() {
  const f = await integrationFixture();
  migrate(f.db);
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const human = service.access.authenticate('a'.repeat(43)),
    scopeId = service.access.scopes(human).find((scope) => scope.kind === 'shared')!.scopeId;
  const { recipes, records } = createRecordFeatures(f.db, service.access);
  const recipeId = randomUUID();
  const command: Envelope = {
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(f.db).recovery_epoch,
    arguments: {
      recordId: recipeId,
      scopeId,
      ...emptyRecipeFields(),
      title: 'Before import',
      collectionIds: [],
    },
  };
  const outcome = service.writes.execute(human, 'CreateRecipe', command);
  assert.equal(outcome.status, 'Applied');
  if (outcome.status !== 'Applied' || !outcome.changeSetId) throw new Error();
  const worker = immediate(f.db, () => {
    const principal = ensureRecipeWorker(f.db, human),
      jobId = randomUUID(),
      leaseToken = randomUUID();
    f.db
      .prepare(
        "INSERT INTO background_jobs(job_id,kind,dedupe_key,payload_json,state,run_after,lease_token,lease_until) VALUES (?,'recipe_import',?,'{}','ready',0,?,?)",
      )
      .run(jobId, jobId, leaseToken, f.now() + 60000);
    f.db
      .prepare('INSERT INTO worker_jobs VALUES (?,?,?,?,?,?,?,?)')
      .run(
        jobId,
        principal.clientId,
        principal.workerId,
        recipeId,
        scopeId,
        1,
        installation(f.db).recovery_epoch,
        outcome.changeSetId,
      );
    return { kind: 'worker' as const, ...principal, jobId, leaseToken };
  });
  return {
    ...f,
    ...service,
    human,
    worker,
    recipeId,
    scopeId,
    command,
    outcome,
    recipes,
    records,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('worker authority requires a matching live job, lease, recipe, scope and recovery epoch', async () => {
  const f = await fixture();
  try {
    assert.equal(requireWorkerJob(f.db, f.worker, f.now()).target_record_id, f.recipeId);
    for (const replacement of [
      { clientId: f.human.clientId },
      { workerId: randomUUID() },
      { jobId: randomUUID() },
      { leaseToken: randomUUID() },
      { kind: 'integration' },
    ])
      assert.throws(
        () => requireWorkerJob(f.db, { ...f.worker, ...replacement } as WorkerContext, f.now()),
        Unauthenticated,
      );
    for (const state of ['paused', 'abandoned', 'complete', 'queued']) {
      f.db.prepare('UPDATE background_jobs SET state=? WHERE job_id=?').run(state, f.worker.jobId);
      assert.throws(() => requireWorkerJob(f.db, f.worker, f.now()), Unauthenticated);
    }
    f.db.prepare("UPDATE background_jobs SET state='ready' WHERE job_id=?").run(f.worker.jobId);
    f.db.prepare('UPDATE worker_actors SET active=0 WHERE worker_id=?').run(f.worker.workerId);
    assert.throws(() => requireWorkerJob(f.db, f.worker, f.now()), Unauthenticated);
    f.db.prepare('UPDATE worker_actors SET active=1 WHERE worker_id=?').run(f.worker.workerId);
    assert.throws(() => requireWorkerJob(f.db, f.worker, f.now() + 60000), Unauthenticated);
    f.db.prepare('UPDATE installation_state SET recovery_epoch=?').run(randomUUID());
    assert.throws(
      () => requireWorkerJob(f.db, f.worker, f.now()),
      (error: unknown) => error instanceof Rejection && error.code === 'recovery_required',
    );
    assert.throws(
      () => f.db.prepare('UPDATE worker_jobs SET expected_revision=2 WHERE job_id=?').run(f.worker.jobId),
      /immutable/,
    );
  } finally {
    await f.close();
  }
});

test('workers cannot obtain HTTP credentials or enter human/capture commands and media paths', async () => {
  const f = await fixture();
  try {
    const context = f.worker as unknown as RequestContext;
    assert.throws(() => f.writes.execute(context, 'CreateInboxEntry', f.command), Unauthenticated);
    assert.throws(
      () => f.writes.resolve(context, randomUUID(), installation(f.db).recovery_epoch),
      Unauthenticated,
    );
    assert.throws(() => requireIntegration(f.db, context, f.now()), Unauthenticated);
    assert.throws(() => f.history.record(context, 'CreateInboxEntry', [], f.now()), Unauthenticated);
    assert.throws(() => f.recipes.get(f.worker as never, f.recipeId), Unauthenticated);
    assert.throws(
      () =>
        f.media.prepare(f.worker as never, randomUUID(), {
          scopeId: f.scopeId,
          expectedServerEpoch: installation(f.db).recovery_epoch,
          digest: '0'.repeat(64),
          byteLength: 1,
          mimeType: 'image/png',
        }),
      Unauthenticated,
    );
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO client_credentials VALUES (?,?,?,?,?,NULL)')
          .run(randomUUID(), f.worker.clientId, 'fixture-verifier', 0, 9999999),
      /workers cannot/,
    );
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE client_credentials SET client_id=? WHERE credential_id=?')
          .run(f.worker.clientId, f.human.credentialId),
      /workers cannot/,
    );
    const headers = { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' };
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/commands/CreateRecipe',
      headers,
      payload: { ...f.command, operationId: randomUUID(), actor: f.worker },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(
      f.db
        .prepare(
          "SELECT COUNT(*) FROM client_credentials cc JOIN clients c USING(client_id) WHERE c.kind='worker'",
        )
        .pluck()
        .get(),
      0,
    );
  } finally {
    await f.close();
  }
});

test('worker history admits only source fields on its granted recipe and retains separate attribution and causality', async () => {
  const f = await fixture();
  try {
    const before = f.recipes.get(f.human, f.recipeId);
    const after = {
      ...before,
      revision: 2,
      updatedAt: f.now(),
      content: { ...before.content, title: 'Imported source title' },
    };
    for (const bad of [
      { ...after, recordId: randomUUID() },
      { ...after, content: { ...after.content, scopeId: randomUUID() } },
      { ...after, content: { ...after.content, archived: true } },
      { ...after, content: { ...after.content, deletedAt: f.now() } },
      {
        ...after,
        content: {
          ...after.content,
          adjustments: [
            {
              adjustmentId: randomUUID(),
              body: 'Injected note',
              personId: f.human.personId,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      },
    ])
      assert.throws(
        () => immediate(f.db, () => f.history.recordWorker(f.worker, [{ before, after: bad }], f.now())),
        /worker_job_only/,
      );
    const id = immediate(f.db, () => {
      f.db.prepare('UPDATE recipes SET title=? WHERE recipe_id=?').run(after.content.title, f.recipeId);
      f.db.prepare('UPDATE records SET revision=2,updated_at=? WHERE record_id=?').run(f.now(), f.recipeId);
      return f.history.recordWorker(f.worker, [{ before, after }], f.now());
    });
    const history = f.history.list<Recipe>(f.human, f.recipeId, 'recipe');
    assert.equal(history[0]!.changeSetId, id);
    assert.deepEqual(history[0]!.actor, {
      kind: 'worker',
      workerId: f.worker.workerId,
      displayName: 'Recipe importer',
    });
    assert.equal(history[0]!.causeChangeSetId, f.outcome.changeSetId);
    assert.equal(history[0]!.canUndo, false);
    assert.equal(history[1]!.canUndo, false);
    assert.equal(history[1]!.version.title, 'Before import');
    const reversed = f.writes.execute(f.human, 'UndoChangeSet', {
      ...f.command,
      operationId: randomUUID(),
      arguments: { changeSetId: id },
    });
    assert.equal(reversed.status, 'Rejected');
    if (reversed.status === 'Rejected') assert.equal(reversed.code, 'unavailable');
    assert.throws(
      () =>
        f.db
          .prepare(
            'INSERT INTO operation_receipts(client_id,operation_id,request_digest,actor_worker_id,outcome_json,recorded_at) VALUES (?,?,?,?,?,?)',
          )
          .run(f.human.clientId, randomUUID(), 'fixture', f.worker.workerId, '{}', f.now()),
      /FOREIGN KEY/,
    );
  } finally {
    await f.close();
  }
});

test('010 preserves human/integration digests, rows, receipts and history while adding no worker until a request', async () => {
  const f = await integrationFixture(),
    previous = join(f.root, 'before-workers');
  await mkdir(previous);
  for (const file of await readdir(migrationsRoot))
    if (file.endsWith('.sql') && file < '010_')
      await copyFile(join(migrationsRoot, file), join(previous, file));
  try {
    migrate(f.db, previous);
    const access = new AccessService(f.db, f.now),
      human = access.authenticate('a'.repeat(43));
    const integrations = new IntegrationAccessService(f.db, f.now),
      issued = integrations.provision(human, 'Fixture speaker', 999999);
    const integration = integrations.authenticate(issued.secret);
    const services = () => {
      const records = createRecordFeatures(f.db, access),
        history = new HistoryService(f.db, records.records, access);
      return { history, writes: new WriteCoordinator(f.db, records.inbox, history, f.now, records.records) };
    };
    const old = services(),
      id = randomUUID();
    const command: Envelope = {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      arguments: {
        inboxId: id,
        scopeId: 'fixture-shared',
        text: 'Speaker note',
        source: { kind: 'voice' },
        capturedAt: 1000,
        attachments: [],
      },
    };
    const outcome = old.writes.execute(integration, 'CreateInboxEntry', command),
      digest = requestDigest(integration, 'CreateInboxEntry', command);
    assert.equal(outcome.status, 'Applied');
    const history = old.history.list(human, id),
      snapshot = f.snapshot();
    const actorRows = f.db.prepare('SELECT rowid,* FROM integration_actors').all();
    const integrationRows = f.db
      .prepare('SELECT rowid,client_id,integration_id FROM clients WHERE integration_id IS NOT NULL')
      .all();
    migrate(f.db);
    assert.deepEqual(f.snapshot(), snapshot);
    assert.deepEqual(f.db.prepare('SELECT rowid,* FROM integration_actors').all(), actorRows);
    assert.deepEqual(
      f.db
        .prepare('SELECT rowid,client_id,integration_id FROM clients WHERE integration_id IS NOT NULL')
        .all(),
      integrationRows,
    );
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM worker_actors').pluck().get(), 0);
    assert.equal(requestDigest(integration, 'CreateInboxEntry', command), digest);
    assert.deepEqual(services().history.list(human, id), history);
    assert.deepEqual(services().writes.execute(integration, 'CreateInboxEntry', command), {
      ...outcome,
      replayed: true,
    });
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('010 keeps an empty changeset table high-water mark', async () => {
  const f = await integrationFixture(),
    previous = join(f.root, 'previous-empty-workers'),
    db = openDatabase(':memory:');
  try {
    await mkdir(previous);
    for (const file of await readdir(migrationsRoot))
      if (file.endsWith('.sql') && file < '010_')
        await copyFile(join(migrationsRoot, file), join(previous, file));
    migrate(db, previous);
    db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('change_sets',450)").run();
    migrate(db);
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='change_sets'").pluck().get(), 450);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
    await f.close();
  }
});

for (const failure of ['sql', 'foreign-key'] as const)
  test(`010 rolls back the entire referenced-table rebuild after ${failure} failure`, async () => {
    const f = await integrationFixture(),
      previous = join(f.root, 'previous-workers'),
      broken = join(f.root, 'broken-workers');
    await mkdir(previous);
    await mkdir(broken);
    try {
      for (const file of await readdir(migrationsRoot))
        if (file.endsWith('.sql') && file < '010_') {
          await copyFile(join(migrationsRoot, file), join(previous, file));
          await copyFile(join(migrationsRoot, file), join(broken, file));
        }
      migrate(f.db, previous);
      const before = f.snapshot();
      const sql = await readFile(join(migrationsRoot, '010_worker_principals.sql'), 'utf8');
      await writeFile(
        join(broken, '010_worker_principals.sql'),
        sql +
          (failure === 'sql'
            ? '\nSELECT * FROM intentionally_missing_table;'
            : "\nINSERT INTO clients(client_id,kind,worker_id) VALUES ('invalid-worker-client','worker','missing-worker');"),
      );
      assert.throws(() => migrate(f.db, broken), failure === 'sql' ? /no such table/ : /foreign key check/);
      assert.deepEqual(f.snapshot(), before);
      assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='worker_actors'").get(), undefined);
      assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(f.db.pragma('foreign_key_check'), []);
      migrate(f.db);
      assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      await f.close();
    }
  });
