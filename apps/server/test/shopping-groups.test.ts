import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyRecipeFields,
  type CommandKind,
  type CommandOutcome,
  type Envelope,
  type ShoppingEntry,
  type ShoppingGroup,
  type Recipe,
} from '@our-place/contracts';
import {
  openDatabase,
  migrate,
  initialiseInstallation,
  installation,
} from '../src/infrastructure/database.js';
import { AccessService, type HumanRequestContext } from '../src/features/access/access.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { NotFound } from '../src/application/errors.js';

function applied(o: CommandOutcome) {
  assert.equal(o.status, 'Applied', JSON.stringify(o));
  if (o.status !== 'Applied') throw new Error();
  return o;
}
function rejected(o: CommandOutcome, code: string) {
  assert.equal(o.status, 'Rejected', JSON.stringify(o));
  if (o.status === 'Rejected') assert.equal(o.code, code);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'our-place-groups-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db);
  initialiseInstallation(db);
  const people = ['Alex', 'Sam'].map((name) => {
    const c: HumanRequestContext = {
      personId: randomUUID(),
      clientId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    };
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      c.personId,
      name,
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      c.clientId,
      c.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), c.personId);
    return c;
  });
  const a = people[0]!,
    b = people[1]!;
  let clock = 1000,
    fail = false;
  const now = () => ++clock,
    access = new AccessService(db, now),
    features = createRecordFeatures(db, access);
  const history = new HistoryService(db, features.records, access),
    writes = new WriteCoordinator(
      db,
      features.inbox,
      history,
      now,
      features.records,
      () => {
        if (fail) throw new Error('commit failure');
      },
      [features.shopping.commands(), features.shoppingGroups.commands(), features.recipes.commands()],
    );
  const shared = access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, c = a) => writes.execute(c, kind, envelope(args));
  const get = (id: string) =>
    features.records.project(features.records.get(a, id)) as ShoppingEntry | ShoppingGroup | Recipe;
  const target = (id: string) => ({ recordId: id, expectedRevision: get(id).revision });
  const list = (scopeId = shared) => {
    const id = randomUUID();
    applied(run('CreateShoppingList', { recordId: id, scopeId, name: 'Groceries', purpose: 'groceries' }));
    return id;
  };
  const recipe = (scopeId = shared) => {
    const args = {
      recordId: randomUUID(),
      scopeId,
      ...emptyRecipeFields(),
      title: 'Soup',
      collectionIds: [],
      ingredients: [
        { ingredientId: randomUUID(), text: '½ cup milk' },
        { ingredientId: randomUUID(), text: 'salt, to taste' },
      ],
    };
    applied(run('CreateRecipe', args));
    return args;
  };
  const selection = (r: ReturnType<typeof recipe>, listId: string) => ({
    recordId: randomUUID(),
    recipeId: r.recordId,
    expectedRecipeRevision: 1,
    listId,
    expectedListRevision: 1,
    name: 'Soup this week',
    ingredients: r.ingredients.map((i) => ({
      ingredientId: i.ingredientId,
      entryId: randomUUID(),
      sourceId: randomUUID(),
      label: i.text,
      quantity: '',
      notes: '',
    })),
  });
  return {
    db,
    a,
    b,
    access,
    ...features,
    history,
    writes,
    envelope,
    run,
    get,
    target,
    list,
    recipe,
    selection,
    shared,
    privateScope,
    setFailure: (v: boolean) => {
      fail = v;
    },
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('list deletion checks the confirmed contents and atomically supports retry, undo and redo', () => {
  const f = fixture();
  try {
    const list = f.list(),
      args = f.selection(f.recipe(), list);
    applied(f.run('AddRecipeIngredients', args));
    const ids = [...args.ingredients.map((i) => i.entryId), args.recordId];
    const stale = ids.map(f.target);
    const purchaseId = randomUUID();
    applied(
      f.run(
        'PurchaseShoppingEntry',
        { ...f.target(ids[0]!), purchaseId, purchaseItemId: randomUUID(), boughtAt: 1234 },
        f.b,
      ),
    );
    rejected(f.run('DeleteShoppingList', { ...f.target(list), members: stale }), 'list_members_changed');
    assert.equal(f.get(list).deletedAt, null);
    rejected(
      f.run('DeleteShoppingList', { ...f.target(list), members: ids.slice(1).map(f.target) }),
      'list_members_changed',
    );
    const request = f.envelope({ ...f.target(list), members: ids.map(f.target) });
    f.setFailure(true);
    assert.throws(() => f.writes.execute(f.a, 'DeleteShoppingList', request));
    f.setFailure(false);
    for (const id of [list, ...ids]) assert.equal(f.get(id).deletedAt, null);
    const saved = applied(f.writes.execute(f.a, 'DeleteShoppingList', request));
    assert.equal(saved.result.records.length, 4);
    assert.equal(applied(f.writes.execute(f.a, 'DeleteShoppingList', request)).replayed, true);
    for (const id of [list, ...ids]) assert.ok(f.get(id).deletedAt);
    assert.equal(f.shopping.get(f.a, purchaseId).content.deletedAt, null);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    for (const id of [list, ...ids]) assert.equal(f.get(id).deletedAt, null);
    assert.equal((f.get(ids[0]!) as ShoppingEntry).groupId, args.recordId);
    assert.equal((f.get(ids[0]!) as ShoppingEntry).state, 'purchased');
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    for (const id of [list, ...ids]) assert.ok(f.get(id).deletedAt);
  } finally {
    f.close();
  }
});

test('recipe checklist is one durable action, with exact source snapshots, replay and guarded compound undo', () => {
  const f = fixture();
  try {
    const list = f.list(),
      r = f.recipe(),
      args = f.selection(r, list),
      request = f.envelope(args);
    const saved = applied(f.writes.execute(f.a, 'AddRecipeIngredients', request));
    assert.equal(saved.result.records.length, 3);
    assert.equal(f.get(r.recordId).revision, 1);
    assert.equal(applied(f.writes.execute(f.a, 'AddRecipeIngredients', request)).replayed, true);
    const item = f.get(args.ingredients[0]!.entryId) as ShoppingEntry;
    assert.equal(item.groupId, args.recordId);
    assert.deepEqual(item.recipeSources, [
      {
        sourceId: args.ingredients[0]!.sourceId,
        recipeId: r.recordId,
        recipeRevision: 1,
        recipeTitle: 'Soup',
        ingredientId: r.ingredients[0]!.ingredientId,
        ingredientText: '½ cup milk',
        quantitySnapshot: '',
      },
    ]);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    assert.ok(f.get(item.recordId).deletedAt);
    assert.ok(f.get(args.recordId).deletedAt);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    const purchase = applied(
      f.run(
        'PurchaseShoppingEntry',
        {
          ...f.target(item.recordId),
          purchaseId: randomUUID(),
          purchaseItemId: randomUUID(),
          boughtAt: 1234,
        },
        f.b,
      ),
    );
    assert.ok(purchase.changeSetId);
    const previous = f.history
      .list(f.a, args.recordId, 'shopping_group')
      .find((h) => h.kind === 'RedoChangeSet')!;
    assert.equal(previous.canUndo, false);
    assert.equal(f.run('UndoChangeSet', { changeSetId: previous.changeSetId }).status, 'Rejected');
    assert.deepEqual((f.get(item.recordId) as ShoppingEntry).recipeSources, item.recipeSources);
  } finally {
    f.close();
  }
});
test('deleting a group retains its items; stale membership, partner edits and occupied lists protect undo', () => {
  const f = fixture();
  try {
    const list = f.list(),
      args = f.selection(f.recipe(), list);
    applied(f.run('AddRecipeIngredients', args));
    const members = args.ingredients.map((i) => f.target(i.entryId));
    rejected(
      f.run('DeleteShoppingGroup', { ...f.target(args.recordId), members: members.slice(1) }),
      'group_members_changed',
    );
    const removed = applied(f.run('DeleteShoppingGroup', { ...f.target(args.recordId), members }));
    for (const member of members) {
      const item = f.get(member.recordId) as ShoppingEntry;
      assert.equal(item.deletedAt, null);
      assert.equal(item.groupId, null);
    }
    applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    for (const member of members)
      assert.equal((f.get(member.recordId) as ShoppingEntry).groupId, args.recordId);
    const other = f.list();
    applied(f.run('MoveShoppingEntry', { ...f.target(members[0]!.recordId), listId: other }));
    assert.equal((f.get(members[0]!.recordId) as ShoppingEntry).groupId, null);
    rejected(
      f.run('MoveShoppingEntry', {
        ...f.target(members[0]!.recordId),
        listId: other,
        groupId: args.recordId,
      }),
      'group_unavailable',
    );
    const empty = randomUUID();
    applied(f.run('CreateShoppingGroup', { recordId: empty, listId: other, name: 'Hardware' }));
    applied(f.run('DeleteShoppingRecord', f.target(members[0]!.recordId)));
    rejected(f.run('DeleteShoppingRecord', f.target(other)), 'list_contains_groups');
    f.records.assertComplete();
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});
test('same-scope references, current recipe/list revisions and exact ingredient identities are enforced atomically', () => {
  const f = fixture();
  try {
    const list = f.list(),
      r = f.recipe(),
      privateRecipe = f.recipe(f.privateScope),
      args = f.selection(r, list);
    rejected(f.run('AddRecipeIngredients', f.selection(privateRecipe, list)), 'scope_mismatch');
    rejected(f.run('AddRecipeIngredients', f.selection(privateRecipe, list), f.b), 'unavailable');
    rejected(f.run('AddRecipeIngredients', { ...args, expectedRecipeRevision: 2 }), 'revision_conflict');
    rejected(f.run('AddRecipeIngredients', { ...args, expectedListRevision: 2 }), 'revision_conflict');
    rejected(
      f.run('AddRecipeIngredients', { ...args, ingredients: [args.ingredients[0], args.ingredients[0]] }),
      'duplicate_ingredient_selection',
    );
    rejected(
      f.run('AddRecipeIngredients', {
        ...args,
        ingredients: [{ ...args.ingredients[0], ingredientId: randomUUID() }],
      }),
      'ingredient_unavailable',
    );
    assert.equal(f.shoppingGroups.snapshot(f.a).length, 0);
    assert.equal(f.shopping.snapshot(f.a).entries.length, 0);
    const privateList = f.list(f.privateScope),
      privateArgs = f.selection(privateRecipe, privateList);
    applied(f.run('AddRecipeIngredients', privateArgs));
    assert.throws(() => f.shoppingGroups.get(f.b, privateArgs.recordId), NotFound);
    assert.equal(f.shoppingGroups.snapshot(f.b).length, 0);
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE shopping_entry_groups SET list_id=? WHERE entry_id=?')
          .run(list, privateArgs.ingredients[0]!.entryId),
      /FOREIGN KEY/,
    );
    const before = f.get(privateRecipe.recordId) as Recipe;
    const { scopeId: _scope, collectionIds: _collections, ...fields } = privateRecipe;
    applied(
      f.run('UpdateRecipe', {
        ...fields,
        expectedRevision: before.revision,
        title: 'Changed soup',
        ingredients: [],
      }),
    );
    applied(f.run('DeleteRecipe', f.target(privateRecipe.recordId)));
    const retained = (f.get(privateArgs.ingredients[0]!.entryId) as ShoppingEntry).recipeSources![0]!;
    assert.equal(retained.recipeTitle, 'Soup');
    assert.equal(retained.ingredientText, '½ cup milk');
    assert.equal(retained.recipeRevision, 1);
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE recipe_shopping_sources SET ingredient_text=? WHERE source_id=?')
          .run('changed', retained.sourceId),
      /immutable/,
    );
  } finally {
    f.close();
  }
});
test('failed commit leaves no group, item, source or receipt, and an exact retry remains safe', () => {
  const f = fixture();
  try {
    const args = f.selection(f.recipe(), f.list()),
      request = f.envelope(args);
    f.setFailure(true);
    assert.throws(() => f.writes.execute(f.a, 'AddRecipeIngredients', request), /commit failure/);
    f.setFailure(false);
    assert.equal(f.shoppingGroups.snapshot(f.a).length, 0);
    assert.equal(f.shopping.snapshot(f.a).entries.length, 0);
    assert.equal(
      (f.db.prepare('SELECT count(*) AS n FROM recipe_shopping_sources').get() as { n: number }).n,
      0,
    );
    assert.equal(
      f.db.prepare('SELECT 1 FROM operation_receipts WHERE operation_id=?').get(request.operationId),
      undefined,
    );
    applied(f.writes.execute(f.a, 'AddRecipeIngredients', request));
    rejected(f.run('AddRecipeIngredients', { ...args, recordId: randomUUID() }), 'id_unavailable');
    assert.equal(f.shoppingGroups.snapshot(f.a).length, 1);
  } finally {
    f.close();
  }
});

test('recipe export creates a named list and notes atomically, replays, and reverses all children', () => {
  const f = fixture();
  try {
    const recipe = f.recipe(f.privateScope),
      listId = randomUUID();
    const args = {
      ...f.selection(recipe, listId),
      newList: { name: 'Soup ingredients', purpose: 'groceries', notes: 'Check the market' },
    };
    const request = f.envelope(args);
    const saved = applied(f.writes.execute(f.a, 'AddRecipeIngredients', request));
    assert.equal(saved.result.records.length, 4);
    assert.equal(f.shopping.get(f.a, listId).content.notes, 'Check the market');
    assert.equal(f.shopping.get(f.a, listId).content.scopeId, f.privateScope);
    assert.throws(() => f.shopping.get(f.b, listId), NotFound);
    assert.equal(applied(f.writes.execute(f.a, 'AddRecipeIngredients', request)).replayed, true);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    assert.ok(f.shopping.get(f.a, listId).content.deletedAt);
    assert.ok(f.get(args.recordId).deletedAt);
    assert.ok(f.get(args.ingredients[0]!.entryId).deletedAt);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    assert.equal(f.shopping.get(f.a, listId).content.deletedAt, null);
    assert.equal(f.shopping.get(f.a, listId).content.notes, 'Check the market');
    assert.equal(f.get(args.ingredients[0]!.entryId).deletedAt, null);
    const badList = randomUUID(),
      bad = { ...f.selection(recipe, badList), newList: args.newList };
    bad.ingredients[0]!.ingredientId = randomUUID();
    assert.equal(f.run('AddRecipeIngredients', bad).status, 'Rejected');
    assert.equal(f.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(badList), undefined);
    // An older client does not erase newly added notes when renaming a list.
    applied(
      f.run('UpdateShoppingList', {
        recordId: listId,
        expectedRevision: f.shopping.get(f.a, listId).revision,
        name: 'Renamed',
        purpose: 'groceries',
      }),
    );
    assert.equal(f.shopping.get(f.a, listId).content.notes, 'Check the market');
  } finally {
    f.close();
  }
});

test('sourcing notes update an existing list once with the export, preserving guarded undo and redo', () => {
  const f = fixture();
  try {
    const list = f.list(),
      recipe = f.recipe(),
      args = {
        ...f.selection(recipe, list),
        listNotes: 'Everything else is at Example supermarket. (Assumed.)',
      };
    const saved = applied(f.run('AddRecipeIngredients', args));
    assert.equal(f.shopping.get(f.a, list).content.notes, args.listNotes);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    assert.equal(f.shopping.get(f.a, list).content.notes, '');
    assert.equal(f.shopping.get(f.a, list).content.deletedAt, null);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    assert.equal(f.shopping.get(f.a, list).content.notes, args.listNotes);
    const stale = f.run('AddRecipeIngredients', {
      ...f.selection(recipe, list),
      listNotes: 'Stale overwrite',
    });
    assert.equal(stale.status, 'Rejected');
    assert.equal(f.shopping.get(f.a, list).content.notes, args.listNotes);
  } finally {
    f.close();
  }
});
