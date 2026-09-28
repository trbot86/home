import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { integrationFixture } from './integration-fixture.js';
import { installation, migrate, requireCurrentSchema } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { upgradeDatabase } from '../src/features/operations/upgrade.js';
import { BackupCoordinator, initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { verifyArchive } from '../src/features/operations/backup-format.js';
import { MediaRetentionGate } from '../src/features/media/retention-gate.js';
import { sha256 } from '../src/features/media/file-media-store.js';
import { buildApp } from '../src/app.js';
import { buildCaptureApp } from '../src/capture-app.js';
import { requestDigest } from '../src/application/write-coordinator.js';
import { IntegrationAccessService } from '../src/features/access/integrations.js';
import { NotFound, Unauthenticated } from '../src/application/errors.js';
import { emptyRecipeFields, type CommandKind, type Envelope } from '@our-place/contracts';

test('verified 006 upgrade preserves golden requests, identity, media, human history and queued writes; current backup restores', async () => {
  const f = await integrationFixture();
  try {
    const before = f.snapshot(),
      state = installation(f.db);
    assert.throws(() => requireCurrentSchema(f.db), /upgrade required/);
    await assert.rejects(buildCaptureApp({ dataRoot: f.dataRoot, db: f.db }), /upgrade required/);
    await assert.rejects(
      upgradeDatabase(f.db, {
        create: async () => {
          throw new Error('backup failed');
        },
      }),
      /backup failed/,
    );
    assert.deepEqual(f.snapshot(), before);
    const outputRoot = join(f.root, 'exports');
    await initialiseBackupDestination(outputRoot, state.installation_id, true);
    const backups = new BackupCoordinator(f.db, f.files, new MediaRetentionGate(), {
      dataRoot: f.dataRoot,
      outputRoot,
      development: true,
      now: f.now,
    });
    await backups.initialise();
    const upgraded = await upgradeDatabase(f.db, backups);
    assert.deepEqual(upgraded?.migrations, [
      '007_integration_principals.sql',
      '008_home_maintenance.sql',
      '009_recipes.sql',
      '010_worker_principals.sql',
      '011_recipe_imports.sql',
      '012_view_pins.sql',
      '013_recipe_tasks.sql',
      '014_shopping_groups.sql',
      '015_projects.sql',
      '016_project_views.sql',
      '017_calendar_cache.sql',
      '018_calendar_authorization.sql',
      '019_calendar_browser_handoff.sql',
      '020_agenda_layouts.sql',
      '021_inbox_filing.sql',
      '022_suggestion_discussions.sql',
      '023_suggestion_read_positions.sql',
      '024_suggestion_releases.sql',
      '025_suggestion_completion.sql',
      '026_suggestion_release_batches.sql',
      '027_suggestion_steering.sql',
      '028_navigation_preferences.sql',
    ]);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(installation(f.db), state);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(f.db.prepare('SELECT * FROM integration_actors').all().length, 0);
    assert.equal(
      (f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='change_sets'").get() as { seq: number }).seq,
      5000,
    );
    for (const table of ['clients', 'change_sets', 'operation_receipts']) {
      const column = table === 'clients' ? 'integration_id' : 'actor_integration_id';
      assert.equal(f.db.prepare(`SELECT 1 FROM ${table} WHERE ${column} IS NOT NULL`).get(), undefined);
    }
    assert.equal(sha256(await f.files.read(f.legacy.media.storageKey)), f.legacy.media.digest);
    const app = await buildApp({
      dataRoot: f.dataRoot,
      db: f.db,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
    try {
      const alice = app.access.authenticate('a'.repeat(43)),
        bob = app.access.authenticate('b'.repeat(43));
      assert.deepEqual(alice, f.legacy.contexts[0]);
      assert.deepEqual(bob, f.legacy.contexts[1]);
      assert.throws(() => app.access.authenticate('r'.repeat(43)), Unauthenticated);
      assert.equal(app.access.profiles().length, 2);
      const login = app.access.selectProfile('fixture-alice', 'browser', alice.clientId);
      assert.equal(login.session.clientId, alice.clientId);
      assert.equal(login.session.person.personId, alice.personId);
      assert.throws(() => app.inbox.get(alice, 'fixture-private'), NotFound);
      assert.equal(app.inbox.get(bob, 'fixture-private').text, 'Private fixture');
      assert.equal(sha256((await app.media.read(alice, 'fixture-media')).bytes), f.legacy.media.digest);
      const history = app.history.list(alice, 'fixture-inbox');
      assert.equal(history.length, 4);
      assert.deepEqual(history[0]?.actor, { personId: alice.personId, displayName: 'Alice' });
      assert.equal(history[0]?.canUndo, true);
      assert.equal(app.history.list(bob, 'fixture-inbox')[0]?.canUndo, false);
      for (const item of f.legacy.commands) {
        assert.equal(requestDigest(item.context, item.kind, item.command), item.digest);
        assert.deepEqual(app.writes.execute(item.context, item.kind, item.command), {
          ...item.outcome,
          replayed: true,
        });
      }
      const pending = f.legacy.pending;
      assert.equal(requestDigest(pending.context, pending.kind, pending.command), pending.digest);
      const saved = app.writes.execute(pending.context, pending.kind, pending.command);
      assert.equal(saved.status, 'Applied', JSON.stringify(saved));
      if (saved.status !== 'Applied') throw new Error('Expected applied');
      assert.equal(saved.receipt.requestDigest, pending.digest);
      assert.equal(
        (
          f.db
            .prepare('SELECT commit_sequence FROM change_sets WHERE change_set_id=?')
            .get(saved.changeSetId) as { commit_sequence: number }
        ).commit_sequence,
        5001,
      );
      const envelope = (changeSetId: string) => ({
        operationId: randomUUID(),
        contractVersion: 1 as const,
        expectedServerEpoch: state.recovery_epoch,
        arguments: { changeSetId },
      });
      assert.equal(
        app.writes.execute(alice, 'UndoChangeSet', envelope(saved.changeSetId!)).status,
        'Rejected',
      );
      const undone = app.writes.execute(bob, 'UndoChangeSet', envelope(saved.changeSetId!));
      assert.equal(undone.status, 'Applied');
      if (undone.status !== 'Applied') throw new Error();
      assert.equal(app.writes.execute(bob, 'RedoChangeSet', envelope(undone.changeSetId!)).status, 'Applied');

      const integrations = new IntegrationAccessService(f.db, f.now);
      const issued = integrations.provision(alice, 'Alexa', 9000000);
      const capture = await buildCaptureApp({ dataRoot: f.dataRoot, db: f.db, now: f.now });
      const payload = {
        operationId: 'fixture-alexa-operation',
        expectedServerEpoch: state.recovery_epoch,
        destination: 'inbox',
        text: 'Keep the model number',
        capturedAt: 345,
      };
      const headers = { authorization: `Bearer ${issued.secret}` };
      let receipt: Record<string, unknown>;
      try {
        receipt = (
          await capture.app.inject({ method: 'POST', url: '/capture/inbox', headers, payload })
        ).json();
      } finally {
        await capture.app.close();
      }
      assert.equal(receipt.status, 'Applied');
      const scopeId = app.access.scopes(alice).find((s) => s.kind === 'shared')!.scopeId;
      const recipeId = randomUUID(),
        listId = randomUUID(),
        groupId = randomUUID(),
        ingredientId = randomUUID(),
        entryId = randomUUID();
      const command = (kind: CommandKind, args: unknown) => {
        const envelope: Envelope = {
          operationId: randomUUID(),
          contractVersion: 1,
          expectedServerEpoch: state.recovery_epoch,
          arguments: args,
        };
        const outcome = app.writes.execute(alice, kind, envelope);
        assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
        return { envelope, outcome };
      };
      command('CreateRecipe', {
        recordId: recipeId,
        scopeId,
        ...emptyRecipeFields(),
        title: 'Backup soup',
        collectionIds: [],
        ingredients: [{ ingredientId, text: '3 carrots' }],
      });
      command('CreateShoppingList', {
        recordId: listId,
        scopeId,
        name: 'Backup groceries',
        purpose: 'groceries',
      });
      const recipeShopping = command('AddRecipeIngredients', {
        recordId: groupId,
        listId,
        expectedListRevision: 1,
        recipeId,
        expectedRecipeRevision: 1,
        name: 'Soup groceries',
        ingredients: [
          { ingredientId, entryId, sourceId: randomUUID(), label: 'Carrots', quantity: '3', notes: '' },
        ],
      });
      const groupTables = ['shopping_groups', 'shopping_entry_groups', 'recipe_shopping_sources'];
      const groupRows = groupTables.map((table) =>
        JSON.stringify(f.db.prepare(`SELECT * FROM ${table}`).all()),
      );
      f.setTime(2000);
      const completed = await backups.create();
      await verifyArchive(join(outputRoot, completed.archive.name), completed);
      const restoredRoot = join(f.root, 'restored');
      const restored = await restoreBackup(
        join(outputRoot, `${completed.archive.name}.complete.json`),
        restoredRoot,
        true,
      );
      assert.notEqual(restored.serverEpoch, state.recovery_epoch);
      const r = await buildApp({
        dataRoot: restoredRoot,
        development: true,
        publicOrigin: 'http://localhost',
        now: f.now,
      });
      const rc = await buildCaptureApp({ dataRoot: restoredRoot, db: r.db, now: f.now });
      try {
        assert.equal(installation(r.db).installation_id, state.installation_id);
        assert.equal(sha256((await r.media.read(alice, 'fixture-media')).bytes), f.legacy.media.digest);
        assert.equal(r.inbox.get(alice, 'fixture-pending').text, 'Frozen offline note');
        groupTables.forEach((table, index) =>
          assert.equal(JSON.stringify(r.db.prepare(`SELECT * FROM ${table}`).all()), groupRows[index], table),
        );
        assert.deepEqual(r.writes.execute(alice, 'AddRecipeIngredients', recipeShopping.envelope), {
          ...recipeShopping.outcome,
          replayed: true,
        });
        if (recipeShopping.outcome.status !== 'Applied') throw new Error();
        const undoGroup = r.writes.execute(alice, 'UndoChangeSet', {
          operationId: randomUUID(),
          contractVersion: 1,
          expectedServerEpoch: restored.serverEpoch,
          arguments: { changeSetId: recipeShopping.outcome.changeSetId },
        });
        assert.equal(undoGroup.status, 'Applied', JSON.stringify(undoGroup));
        assert.ok(
          (
            r.db.prepare('SELECT deleted_at FROM records WHERE record_id=?').get(groupId) as {
              deleted_at: number | null;
            }
          ).deleted_at,
        );
        assert.ok(
          (
            r.db.prepare('SELECT deleted_at FROM records WHERE record_id=?').get(entryId) as {
              deleted_at: number | null;
            }
          ).deleted_at,
        );
        assert.deepEqual(
          (await rc.app.inject({ method: 'POST', url: '/capture/inbox', headers, payload })).json(),
          { ...receipt, replayed: true },
        );
        assert.equal(
          (
            await rc.app.inject({
              method: 'POST',
              url: '/capture/inbox',
              headers,
              payload: { ...payload, operationId: 'absent-after-restore' },
            })
          ).json().status,
          'RecoveryRequired',
        );
      } finally {
        await rc.app.close();
        await r.app.close();
      }
    } finally {
      await app.app.close();
    }
  } finally {
    await f.close();
  }
});

for (const fault of [
  'SELECT missing_migration_function();',
  "DELETE FROM people WHERE person_id='fixture-bob';",
]) {
  test(`007 rebuild rolls back and restores FK enforcement after ${fault.startsWith('SELECT') ? 'SQL failure' : 'FK check failure'}`, async () => {
    const f = await integrationFixture();
    try {
      const before = f.snapshot(),
        checksums = f.db.prepare('SELECT * FROM schema_migrations').all();
      const filename = '007_integration_principals.sql';
      await copyFile(join(migrationsRoot, filename), join(f.oldMigrations, filename));
      await writeFile(
        join(f.oldMigrations, filename),
        (await readFile(join(f.oldMigrations, filename), 'utf8')) + '\n' + fault,
      );
      assert.throws(() => migrate(f.db, f.oldMigrations), /function|foreign key check/);
      assert.deepEqual(f.snapshot(), before);
      assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), checksums);
      assert.equal(
        f.db.prepare("SELECT name FROM sqlite_master WHERE name='integration_actors'").get(),
        undefined,
      );
      assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
      assert.throws(
        () =>
          f.db
            .prepare(
              "INSERT INTO clients(client_id,person_id,kind) VALUES ('bad-client','no-person','browser')",
            )
            .run(),
        /FOREIGN KEY/,
      );
      assert.equal(
        (f.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='change_sets'").get() as { seq: number })
          .seq,
        5000,
      );
      migrate(f.db);
      assert.deepEqual(f.snapshot(), before);
    } finally {
      await f.close();
    }
  });
}

test('007 preserves an empty changeset table high-water mark and enforces actor ownership', async () => {
  const f = await integrationFixture();
  try {
    f.db.exec('DELETE FROM record_changes; DELETE FROM change_sets;');
    migrate(f.db);
    f.db
      .prepare(
        "INSERT INTO change_sets(change_set_id,client_id,actor_person_id,operation_kind,recorded_at) VALUES ('next-change','fixture-browser','fixture-alice','CreateInboxEntry',1000)",
      )
      .run();
    assert.equal(
      (
        f.db.prepare("SELECT commit_sequence FROM change_sets WHERE change_set_id='next-change'").get() as {
          commit_sequence: number;
        }
      ).commit_sequence,
      5001,
    );
    f.db.exec("INSERT INTO integration_actors VALUES ('fixture-integration','Alexa',1)");
    assert.throws(
      () =>
        f.db.exec(
          "INSERT INTO clients(client_id,person_id,kind,integration_id) VALUES ('both-owners','fixture-alice','integration','fixture-integration')",
        ),
      /CHECK/,
    );
    assert.throws(
      () => f.db.exec("INSERT INTO clients(client_id,kind) VALUES ('no-owner','integration')"),
      /CHECK/,
    );
    assert.throws(
      () => f.db.exec("UPDATE clients SET person_id='fixture-bob' WHERE client_id='fixture-browser'"),
      /immutable/,
    );
    assert.throws(
      () =>
        f.db.exec(
          "INSERT INTO change_sets(change_set_id,client_id,actor_person_id,operation_kind,recorded_at) VALUES ('wrong-owner','fixture-browser','fixture-bob','CreateInboxEntry',1000)",
        ),
      /FOREIGN KEY/,
    );
    assert.throws(
      () =>
        f.db.exec(
          "INSERT INTO operation_receipts(client_id,operation_id,request_digest,actor_integration_id,outcome_json,recorded_at) VALUES ('fixture-browser','bad-receipt','digest','fixture-integration','{}',1000)",
        ),
      /FOREIGN KEY/,
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
