import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyRecipeFields, type Command, type Envelope } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { migrate, installation } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService } from '../src/features/access/access.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator, requestDigest } from '../src/application/write-coordinator.js';
import { ViewPreferences } from '../src/features/views/views.js';

async function previousSchema() {
  const f = await integrationFixture();
  for (const name of (await readdir(migrationsRoot)).filter((name) => /^0(0\d|1[0-5])_/.test(name)))
    await copyFile(join(migrationsRoot, name), join(f.oldMigrations, name));
  migrate(f.db, f.oldMigrations);
  const access = new AccessService(f.db, f.now),
    context = f.legacy.contexts[0]!,
    features = createRecordFeatures(f.db, access),
    history = new HistoryService(f.db, features.records, access);
  const scopeId = access.scopes(context).find((s) => s.kind === 'shared')!.scopeId,
    recipeId = randomUUID();
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(f.db).recovery_epoch,
    arguments: args,
  });
  // The published 012 writer's single-pin SQL, retained only as a pre-upgrade fixture.
  const oldWrites = new WriteCoordinator(f.db, features.inbox, history, f.now, features.records, undefined, [
    features.recipes.commands(),
    {
      kinds: ['SetRecordPin'],
      execute: (_context, _kind, payload) => {
        const args = payload as Command<'SetRecordPin'>['arguments'],
          viewId = randomUUID();
        f.db.prepare('INSERT INTO saved_views VALUES (?,?,?,1)').run(viewId, args.scopeId, args.viewKind);
        f.db.prepare('INSERT INTO record_pins VALUES (?,?,?,0)').run(viewId, args.scopeId, args.recordId);
        return { records: [], changes: [] };
      },
    },
  ]);
  assert.equal(
    oldWrites.execute(
      context,
      'CreateRecipe',
      envelope({ recordId: recipeId, scopeId, ...emptyRecipeFields(), title: 'Soup', collectionIds: [] }),
    ).status,
    'Applied',
  );
  const command = envelope({
      recordId: recipeId,
      scopeId,
      viewKind: 'food_soon',
      expectedViewRevision: 0,
      pinned: true,
    }),
    outcome = oldWrites.execute(context, 'SetRecordPin', command);
  assert.equal(outcome.status, 'Applied');
  const views = new ViewPreferences(f.db, access),
    frozen = JSON.stringify(command),
    digest = requestDigest(context, 'SetRecordPin', command),
    pins = views.snapshot(context);
  const selects = (
    f.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map(
    ({ name }) =>
      `SELECT ${(f.db.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${name} ${name === 'record_kinds' ? "WHERE kind NOT IN ('suggestion_workflow','suggestion_message')" : ''}`,
  );
  const before = selects.map((sql) => JSON.stringify(f.db.prepare(sql).all()));
  return {
    ...f,
    context,
    access,
    features,
    history,
    scopeId,
    recipeId,
    envelope,
    command,
    outcome,
    views,
    frozen,
    digest,
    pins,
    selects,
    before,
  };
}

test('016 retains Food rows and receipts exactly and accepts frozen pre-upgrade pin commands', async () => {
  const f = await previousSchema();
  try {
    const pending = f.envelope({
        recordId: f.recipeId,
        scopeId: f.scopeId,
        viewKind: 'food_soon',
        expectedViewRevision: 1,
        pinned: false,
      }),
      pendingBytes = JSON.stringify(pending);
    migrate(f.db);
    for (const [i, sql] of f.selects.entries())
      assert.equal(JSON.stringify(f.db.prepare(sql).all()), f.before[i], sql);
    assert.deepEqual(f.views.snapshot(f.context), f.pins);
    const writes = new WriteCoordinator(
      f.db,
      f.features.inbox,
      f.history,
      f.now,
      f.features.records,
      undefined,
      [f.views.commands(), f.features.projects.commands()],
    );
    assert.equal(JSON.stringify(f.command), f.frozen);
    assert.equal(requestDigest(f.context, 'SetRecordPin', f.command), f.digest);
    assert.deepEqual(writes.execute(f.context, 'SetRecordPin', f.command), { ...f.outcome, replayed: true });
    assert.equal(writes.execute(f.context, 'SetRecordPin', pending).status, 'Applied');
    assert.equal(JSON.stringify(pending), pendingBytes);
    assert.deepEqual(f.views.snapshot(f.context)[0]!.pins, []);
    assert.equal(f.db.prepare('SELECT revision FROM records WHERE record_id=?').pluck().get(f.recipeId), 1);
    const projectId = randomUUID();
    assert.equal(
      writes.execute(
        f.context,
        'CreateProject',
        f.envelope({ recordId: projectId, scopeId: f.scopeId, title: 'Garden', description: '' }),
      ).status,
      'Applied',
    );
    assert.equal(
      writes.execute(
        f.context,
        'SetRecordPin',
        f.envelope({
          recordId: f.recipeId,
          scopeId: f.scopeId,
          viewKind: 'project_next',
          projectId,
          expectedViewRevision: 0,
          pinned: true,
        }),
      ).status,
      'Applied',
    );
    assert.equal(f.views.snapshot(f.context).length, 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

for (const [name, fault] of [
  ['SQL failure', 'SELECT missing_project_view_function();'],
  ['foreign key failure', "UPDATE record_pins SET record_id='missing-target';"],
]) {
  test(`016 rolls back both rebuilt tables and restores FK enforcement after ${name}`, async () => {
    const f = await previousSchema();
    try {
      const filename = '016_project_views.sql',
        checksums = f.db.prepare('SELECT * FROM schema_migrations').all();
      await writeFile(
        join(f.oldMigrations, filename),
        (await readFile(join(migrationsRoot, filename), 'utf8')) + '\n' + fault,
      );
      assert.throws(() => migrate(f.db, f.oldMigrations), /function|foreign key check/);
      assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), checksums);
      assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
      assert.deepEqual(
        (f.db.pragma('table_info(saved_views)') as { name: string }[]).map((c) => c.name),
        ['view_id', 'scope_id', 'kind', 'revision'],
      );
      assert.deepEqual(
        (f.db.pragma('table_info(record_pins)') as { name: string }[]).map((c) => c.name),
        ['view_id', 'scope_id', 'record_id', 'position'],
      );
      for (const [i, sql] of f.selects.entries())
        assert.equal(JSON.stringify(f.db.prepare(sql).all()), f.before[i], sql);
      assert.throws(
        () => f.db.prepare("UPDATE record_pins SET record_id='missing-target'").run(),
        /FOREIGN KEY/,
      );
      migrate(f.db);
      assert.deepEqual(f.views.snapshot(f.context), f.pins);
      assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    } finally {
      await f.close();
    }
  });
}
