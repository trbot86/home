import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyRecipeFields,
  type CommandKind,
  type CommandOutcome,
  type Envelope,
  type Recipe,
  type RecipeCookingRecord,
} from '@our-place/contracts';
import {
  initialiseInstallation,
  installation,
  migrate,
  openDatabase,
} from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService, type HumanRequestContext } from '../src/features/access/access.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { NotFound, Unauthenticated } from '../src/application/errors.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';

function applied(value: CommandOutcome) {
  assert.equal(value.status, 'Applied', JSON.stringify(value));
  if (value.status !== 'Applied') throw new Error();
  return value;
}
function rejected(value: CommandOutcome, code: string) {
  assert.equal(value.status, 'Rejected', JSON.stringify(value));
  if (value.status === 'Rejected') assert.equal(value.code, code);
}
function fixture(migrationsPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'our-place-recipes-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationsPath);
  initialiseInstallation(db);
  const people = ['Alex', 'Sam'].map((name) => {
    const context: HumanRequestContext = {
      clientId: randomUUID(),
      personId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    };
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      context.personId,
      name.toLowerCase(),
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      context.clientId,
      context.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), context.personId);
    return context;
  });
  const a = people[0]!,
    b = people[1]!;
  let clock = Date.parse('2026-09-27T16:00:00Z'),
    failCommit = false;
  const now = () => ++clock,
    access = new AccessService(db, now);
  function services() {
    const features = createRecordFeatures(db, access);
    const enabled = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='recipes'").get();
    const records = enabled ? features.records : new RecordRegistry(db, [inboxRecordAdapter(features.inbox)]);
    const history = new HistoryService(db, records, access);
    const writes = new WriteCoordinator(
      db,
      features.inbox,
      history,
      now,
      records,
      () => {
        if (failCommit) throw new Error('injected failure');
      },
      enabled ? [features.recipes.commands(), features.tasks.commands()] : [],
    );
    return { ...features, records, history, writes };
  }
  let active = services();
  const shared = access.scopes(a).find((scope) => scope.kind === 'shared')!.scopeId;
  const privateScope = access.scopes(a).find((scope) => scope.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, context = a) =>
    active.writes.execute(context, kind, envelope(args));
  const recipeArgs = (scopeId = shared) => ({
    recordId: randomUUID(),
    scopeId,
    ...emptyRecipeFields(),
    title: 'Vegetable soup',
    sourceUrl: 'https://recipes.example/soup',
    collectionIds: [] as string[],
    ingredients: [
      { ingredientId: randomUUID(), text: '½ cup milk' },
      { ingredientId: randomUUID(), text: 'salt, to taste' },
    ],
    steps: [{ stepId: randomUUID(), text: 'Simmer gently.' }],
  });
  const get = (id: string, context = a) => active.recipes.project(active.recipes.get(context, id)) as Recipe;
  const update = (id: string, changes: Record<string, unknown>, context = a) => {
    const old = get(id, context);
    const {
      title,
      description,
      sourceUrl,
      author,
      yieldText,
      prepTime,
      cookTime,
      totalTime,
      ingredients,
      steps,
    } = old;
    return run(
      'UpdateRecipe',
      {
        recordId: id,
        expectedRevision: old.revision,
        title,
        description,
        sourceUrl,
        author,
        yieldText,
        prepTime,
        cookTime,
        totalTime,
        ingredients,
        steps,
        ...changes,
      },
      context,
    );
  };
  return {
    db,
    root,
    a,
    b,
    shared,
    privateScope,
    access,
    now,
    envelope,
    run,
    recipeArgs,
    get,
    update,
    get active() {
      return active;
    },
    set failCommit(value: boolean) {
      failCommit = value;
    },
    upgrade() {
      migrate(db);
      active = services();
    },
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('default recipe collections converge without duplicates; membership belongs to the recipe and moves atomically', () => {
  const f = fixture();
  try {
    const ids = { scopeId: f.shared, wantToTryId: randomUUID(), favouritesId: randomUUID() },
      command = f.envelope(ids);
    const first = applied(f.active.writes.execute(f.a, 'EnsureRecipeCollections', command));
    assert.equal(first.result.records.length, 2);
    assert.equal(applied(f.active.writes.execute(f.a, 'EnsureRecipeCollections', command)).replayed, true);
    const second = applied(
      f.run(
        'EnsureRecipeCollections',
        { scopeId: f.shared, wantToTryId: randomUUID(), favouritesId: randomUUID() },
        f.b,
      ),
    );
    assert.equal(second.changeSetId, undefined);
    assert.deepEqual(second.result.records, first.result.records);
    const args = f.recipeArgs();
    args.collectionIds = [ids.wantToTryId];
    applied(f.run('CreateRecipe', args));
    const before = f.get(args.recordId);
    const moved = applied(
      f.run('SetRecipeCollections', {
        recordId: args.recordId,
        expectedRevision: before.revision,
        collectionIds: [ids.favouritesId],
      }),
    );
    assert.deepEqual(f.get(args.recordId).collectionIds, [ids.favouritesId]);
    assert.equal(f.active.recipes.get(f.a, ids.wantToTryId).revision, 1);
    applied(f.run('UndoChangeSet', { changeSetId: moved.changeSetId }));
    assert.deepEqual(f.get(args.recordId).collectionIds, [ids.wantToTryId]);
    applied(
      f.run('SetRecipeCollections', {
        recordId: args.recordId,
        expectedRevision: f.get(args.recordId).revision,
        collectionIds: [ids.wantToTryId, ids.favouritesId],
      }),
    );
    assert.equal(f.get(args.recordId).collectionIds.length, 2);
    rejected(
      f.run('DeleteRecipeCollection', { recordId: ids.wantToTryId, expectedRevision: 1 }),
      'builtin_collection',
    );
  } finally {
    f.close();
  }
});

test('source edits preserve household adjustments; partner edits guard undo and history retains text and stable child identities', () => {
  const f = fixture();
  try {
    const args = f.recipeArgs();
    applied(f.run('CreateRecipe', args));
    const adjustmentId = randomUUID();
    applied(
      f.run(
        'SetRecipeAdjustment',
        { recordId: args.recordId, expectedRevision: 1, adjustmentId, body: 'Use less salt next time.' },
        f.b,
      ),
    );
    const noted = f.get(args.recordId),
      oldIngredients = noted.ingredients;
    const changed = applied(
      f.update(args.recordId, {
        title: 'Soup, adjusted source',
        ingredients: [{ ingredientId: randomUUID(), text: '¾ cup milk' }],
      }),
    );
    assert.deepEqual(f.get(args.recordId).adjustments, noted.adjustments);
    assert.equal(f.get(args.recordId).adjustments[0]!.personId, f.b.personId);
    assert.equal(
      f.db.prepare('SELECT COUNT(*) FROM recipe_ingredients WHERE retired_at IS NOT NULL').pluck().get(),
      2,
    );
    const undo = applied(f.run('UndoChangeSet', { changeSetId: changed.changeSetId }));
    assert.deepEqual(f.get(args.recordId).ingredients, oldIngredients);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    const history = f.active.history.list<Recipe>(f.a, args.recordId, 'recipe');
    assert.equal(history.at(-1)!.version.title, args.title);
    assert.deepEqual(history.at(-1)!.version.ingredients, args.ingredients);
    assert.deepEqual(history.at(-1)!.version.adjustments, []);
    const myLatest = applied(f.update(args.recordId, { title: 'My next edit' }));
    applied(f.update(args.recordId, { description: 'Partner updated this.' }, f.b));
    rejected(f.run('UndoChangeSet', { changeSetId: myLatest.changeSetId }), 'revision_conflict');
    const current = f.get(args.recordId);
    const removed = applied(
      f.run(
        'RemoveRecipeAdjustment',
        { recordId: args.recordId, expectedRevision: current.revision, adjustmentId },
        f.b,
      ),
    );
    assert.deepEqual(f.get(args.recordId).adjustments, []);
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }, f.b));
    assert.deepEqual(f.get(args.recordId).adjustments, noted.adjustments);
  } finally {
    f.close();
  }
});

test('private recipes, collections, notes and histories stay private; SQL enforces same-scope typed relationships', () => {
  const f = fixture();
  try {
    const args = f.recipeArgs(f.privateScope);
    applied(f.run('CreateRecipe', args));
    assert.throws(() => f.active.recipes.get(f.b, args.recordId), NotFound);
    assert.throws(() => f.active.history.list(f.b, args.recordId, 'recipe'), NotFound);
    assert.deepEqual(f.active.recipes.snapshot(f.b).recipes, []);
    rejected(f.run('DeleteRecipe', { recordId: args.recordId, expectedRevision: 1 }, f.b), 'unavailable');
    const collectionId = randomUUID();
    applied(f.run('CreateRecipeCollection', { recordId: collectionId, scopeId: f.shared, name: 'Dinners' }));
    rejected(
      f.run('SetRecipeCollections', {
        recordId: args.recordId,
        expectedRevision: 1,
        collectionIds: [collectionId],
      }),
      'scope_mismatch',
    );
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO recipe_collection_memberships VALUES (?,?,?,?,NULL)')
          .run(args.recordId, collectionId, f.privateScope, 0),
      /FOREIGN KEY/,
    );
    const forged = {
      clientId: randomUUID(),
      integrationId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'integration',
    } as unknown as HumanRequestContext;
    assert.throws(() => f.active.recipes.get(forged, args.recordId), Unauthenticated);
    assert.throws(() => f.active.recipes.snapshot(forged), Unauthenticated);
  } finally {
    f.close();
  }
});

test('manual cooking has independent time, performer and notes; it does not favourite, change a recipe or complete a task', () => {
  const f = fixture();
  try {
    const args = f.recipeArgs();
    applied(f.run('CreateRecipe', args));
    const cooking = {
      recordId: randomUUID(),
      scopeId: f.shared,
      recipeId: args.recordId,
      cookedAt: f.now() - 86400000,
      cookedByPersonId: f.b.personId,
      notes: 'Very good with toast.',
    };
    const made = applied(f.run('CreateRecipeCookingRecord', cooking));
    const stored = f.active.recipes.project(
      f.active.recipes.get(f.a, cooking.recordId),
    ) as RecipeCookingRecord;
    assert.equal(stored.cookedAt, cooking.cookedAt);
    assert.equal(stored.cookedByPersonId, f.b.personId);
    assert.equal(stored.completionId, null);
    assert.equal(f.get(args.recordId).revision, 1);
    assert.deepEqual(f.get(args.recordId).collectionIds, []);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM task_completions').pluck().get(), 0);
    rejected(
      f.run('DeleteRecipe', { recordId: args.recordId, expectedRevision: 1 }),
      'recipe_has_cooking_records',
    );
    applied(f.run('SetRecipeArchived', { recordId: args.recordId, expectedRevision: 1, archived: true }));
    assert.equal(f.get(args.recordId).archived, true);
    applied(f.run('UndoChangeSet', { changeSetId: made.changeSetId }));
    assert.notEqual(f.active.recipes.get(f.a, cooking.recordId).content.deletedAt, null);
    rejected(
      f.run('CreateRecipeCookingRecord', { ...cooking, recordId: randomUUID(), cookedAt: f.now() + 3600000 }),
      'cooking_in_future',
    );
  } finally {
    f.close();
  }
});

test('retired ingredient and adjustment identities cannot be stolen; rejected changes are atomic', () => {
  const f = fixture();
  try {
    const first = f.recipeArgs(),
      second = f.recipeArgs();
    applied(f.run('CreateRecipe', first));
    applied(f.run('CreateRecipe', second));
    applied(f.update(first.recordId, { ingredients: [] }));
    rejected(
      f.update(second.recordId, { title: 'Should roll back', ingredients: first.ingredients }),
      'id_unavailable',
    );
    assert.equal(f.get(second.recordId).title, second.title);
    assert.equal(f.get(second.recordId).revision, 1);
    const adjustmentId = randomUUID();
    applied(
      f.run('SetRecipeAdjustment', {
        recordId: first.recordId,
        expectedRevision: f.get(first.recordId).revision,
        adjustmentId,
        body: 'A note',
      }),
    );
    rejected(
      f.run('SetRecipeAdjustment', {
        recordId: second.recordId,
        expectedRevision: 1,
        adjustmentId,
        body: 'A stolen identity',
      }),
      'id_unavailable',
    );
    rejected(
      f.update(second.recordId, { ingredients: [second.ingredients[0], second.ingredients[0]] }),
      'duplicate_recipe_child',
    );
    assert.deepEqual(f.get(second.recordId).adjustments, []);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});

test('collection deletion and restoration respect active membership and preserve removed recipes for undo', () => {
  const f = fixture();
  try {
    const collectionId = randomUUID();
    applied(
      f.run('CreateRecipeCollection', { recordId: collectionId, scopeId: f.shared, name: 'Weeknight' }),
    );
    const args = f.recipeArgs();
    args.collectionIds = [collectionId];
    applied(f.run('CreateRecipe', args));
    rejected(
      f.run('DeleteRecipeCollection', { recordId: collectionId, expectedRevision: 1 }),
      'collection_not_empty',
    );
    const removed = applied(f.run('DeleteRecipe', { recordId: args.recordId, expectedRevision: 1 }));
    const collectionRemoved = applied(
      f.run('DeleteRecipeCollection', { recordId: collectionId, expectedRevision: 1 }),
    );
    rejected(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }), 'collection_unavailable');
    applied(f.run('UndoChangeSet', { changeSetId: collectionRemoved.changeSetId }));
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    assert.deepEqual(f.get(args.recordId).collectionIds, [collectionId]);
    assert.deepEqual(f.get(args.recordId).ingredients, args.ingredients);
  } finally {
    f.close();
  }
});

test('commit failure rolls back recipe, children, history and receipt; lost replies replay without replacing partner edits', () => {
  const f = fixture();
  try {
    const args = f.recipeArgs(),
      command = f.envelope(args);
    f.failCommit = true;
    assert.throws(() => f.active.writes.execute(f.a, 'CreateRecipe', command), /injected failure/);
    for (const table of [
      'records',
      'recipes',
      'recipe_ingredients',
      'recipe_steps',
      'record_changes',
      'change_sets',
      'operation_receipts',
    ])
      assert.equal(f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
    f.failCommit = false;
    const result = applied(f.active.writes.execute(f.a, 'CreateRecipe', command));
    applied(f.update(args.recordId, { title: 'Partner changed title' }, f.b));
    applied(f.run('DeleteRecipe', { recordId: args.recordId, expectedRevision: 2 }, f.b));
    const replay = applied(f.active.writes.execute(f.a, 'CreateRecipe', command));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, result.receipt);
    assert.equal(f.get(args.recordId).title, 'Partner changed title');
    assert.notEqual(f.get(args.recordId).deletedAt, null);
  } finally {
    f.close();
  }
});

test('recipe migration preserves old frozen commands, receipts, identity and history byte-for-byte', () => {
  const old = mkdtempSync(join(tmpdir(), 'our-place-recipe-previous-'));
  for (const file of readdirSync(migrationsRoot).filter((name) => /^00[1-8]_/.test(name)))
    copyFileSync(join(migrationsRoot, file), join(old, file));
  const f = fixture(old);
  try {
    const command = f.envelope({
      inboxId: randomUUID(),
      scopeId: f.shared,
      text: 'Existing household note',
      capturedAt: f.now(),
      source: { kind: 'typed' },
      attachments: [],
    });
    const bytes = JSON.stringify(command),
      first = applied(f.active.writes.execute(f.a, 'CreateInboxEntry', command));
    const tables = [
      'installation_state',
      'people',
      'clients',
      'records',
      'inbox_entries',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const selects = tables.map(
      (table) =>
        `SELECT ${(f.db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${table}`,
    );
    const before = selects.map((sql) => JSON.stringify(f.db.prepare(sql).all()));
    f.upgrade();
    tables.forEach((table, index) =>
      assert.equal(JSON.stringify(f.db.prepare(selects[index]!).all()), before[index], table),
    );
    assert.equal(JSON.stringify(command), bytes);
    assert.deepEqual(
      applied(f.active.writes.execute(f.a, 'CreateInboxEntry', command)).receipt,
      first.receipt,
    );
    applied(f.run('UndoChangeSet', { changeSetId: first.changeSetId }));
    applied(f.run('CreateRecipe', f.recipeArgs()));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    f.close();
    rmSync(old, { recursive: true, force: true });
  }
});
