import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandKind, CommandOutcome, Envelope, ShoppingRecord } from '@our-place/contracts';
import {
  initialiseInstallation,
  installation,
  migrate,
  openDatabase,
} from '../src/infrastructure/database.js';
import { AccessService, type RequestContext } from '../src/features/access/access.js';
import { InboxRepository } from '../src/features/inbox/inbox.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { ShoppingRepository } from '../src/features/shopping/shopping.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { NotFound } from '../src/application/errors.js';
function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}
function rejected(outcome: CommandOutcome, code: string) {
  assert.equal(outcome.status, 'Rejected', JSON.stringify(outcome));
  if (outcome.status === 'Rejected') assert.equal(outcome.code, code);
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'our-place-shopping-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db);
  initialiseInstallation(db);
  const a: RequestContext = {
    clientId: randomUUID(),
    personId: randomUUID(),
    credentialId: randomUUID(),
    kind: 'browser',
  };
  const b: RequestContext = {
    clientId: randomUUID(),
    personId: randomUUID(),
    credentialId: randomUUID(),
    kind: 'browser',
  };
  for (const [person, name] of [
    [a, 't'],
    [b, 'b'],
  ] as const) {
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      person.personId,
      name,
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      person.clientId,
      person.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), person.personId);
  }
  let clock = 1000;
  const now = () => ++clock;
  const access = new AccessService(db, now),
    inbox = new InboxRepository(db, access),
    shopping = new ShoppingRepository(db, access);
  const records = new RecordRegistry(db, [inboxRecordAdapter(inbox), ...shopping.adapters()]);
  const history = new HistoryService(db, records, access),
    writes = new WriteCoordinator(db, inbox, history, now, records, undefined, [shopping.commands()]);
  const shared = access.scopes(a).find((scope) => scope.kind === 'shared')!.scopeId,
    privateScope = access.scopes(a).find((scope) => scope.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, person = a) => writes.execute(person, kind, envelope(args));
  const list = (scopeId = shared) => {
    const id = randomUUID();
    applied(run('CreateShoppingList', { recordId: id, scopeId, name: 'Groceries', purpose: 'groceries' }));
    return id;
  };
  const add = (listId: string, label = 'Milk') => {
    const id = randomUUID();
    applied(run('AddShoppingEntry', { recordId: id, listId, label, quantity: '2 cartons', notes: '' }));
    return id;
  };
  const product = (scopeId = shared) => {
    const id = randomUUID();
    applied(
      run('CreateRestockItem', {
        recordId: id,
        scopeId,
        name: 'Brush heads',
        model: 'Compatible model',
        quantity: '1 pack',
        notes: 'Soft',
        productUrl: 'https://example.com/brush',
      }),
    );
    return id;
  };
  const get = (id: string) => shopping.project(shopping.get(a, id));
  const buy = (id: string) => ({
    recordId: id,
    expectedRevision: get(id).revision,
    purchaseId: randomUUID(),
    purchaseItemId: randomUUID(),
    boughtAt: now(),
  });
  return {
    db,
    a,
    b,
    now,
    access,
    inbox,
    shopping,
    records,
    history,
    writes,
    shared,
    privateScope,
    envelope,
    run,
    list,
    add,
    product,
    get,
    buy,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('purchase check-off records attribution and snapshots, supports atomic undo/redo, and survives a lost acknowledgement', () => {
  const f = fixture();
  try {
    const list = f.list(),
      id = f.add(list),
      args = f.buy(id),
      request = f.envelope(args);
    const bought = applied(f.writes.execute(f.a, 'PurchaseShoppingEntry', request));
    assert.equal(bought.result.records.length, 2);
    const purchase = f.get(args.purchaseId);
    assert.equal(purchase.kind, 'purchase');
    if (purchase.kind !== 'purchase') throw new Error();
    assert.equal(purchase.buyerPersonId, f.a.personId);
    assert.equal(purchase.buyerName, 't');
    assert.equal(purchase.items[0]!.quantity, '2 cartons');
    assert.equal((f.get(id) as { state: string }).state, 'purchased');
    const undone = applied(f.run('UndoChangeSet', { changeSetId: bought.changeSetId }));
    assert.equal((f.get(id) as { state: string }).state, 'needed');
    assert.ok(f.get(args.purchaseId).deletedAt);
    applied(f.run('RedoChangeSet', { changeSetId: undone.changeSetId }));
    applied(
      f.run(
        'UpdateShoppingEntry',
        {
          recordId: id,
          expectedRevision: f.get(id).revision,
          label: 'Oat milk',
          quantity: 'two large cartons',
          notes: 'Partner correction',
        },
        f.b,
      ),
    );
    assert.deepEqual(
      applied(f.writes.execute(f.a, 'PurchaseShoppingEntry', request)).receipt,
      bought.receipt,
    );
    assert.equal((f.get(id) as { label: string }).label, 'Oat milk');
    const versions = f.history.list<ShoppingRecord>(f.a, id, 'shopping_entry');
    assert.equal(versions.length, 5);
    assert.equal((f.get(args.purchaseId) as typeof purchase).items[0]!.label, 'Milk');
    assert.equal(f.shopping.snapshot(f.b).purchases.length, 1);
  } finally {
    f.close();
  }
});
test('Need this deduplicates concurrent requests and preserves bought history; a new need guards an old purchase undo', () => {
  const f = fixture();
  try {
    const list = f.list(),
      restock = f.product(),
      id = randomUUID();
    const need = { recordId: id, listId: list, restockItemId: restock, expectedRestockRevision: 1 };
    applied(f.run('NeedRestockItem', need));
    const duplicate = applied(f.run('NeedRestockItem', { ...need, recordId: randomUUID() }, f.b));
    assert.equal(duplicate.result.records[0]!.recordId, id);
    assert.equal(duplicate.changeSetId, undefined);
    const args = f.buy(id),
      bought = applied(f.run('PurchaseShoppingEntry', args));
    const next = applied(f.run('NeedRestockItem', { ...need, recordId: randomUUID() }, f.b));
    assert.notEqual(next.result.records[0]!.recordId, id);
    rejected(f.run('UndoChangeSet', { changeSetId: bought.changeSetId }), 'restock_already_needed');
    assert.equal(f.get(args.purchaseId).deletedAt, null);
    assert.equal((f.get(id) as { state: string }).state, 'purchased');
    assert.equal(f.shopping.snapshot(f.a).entries.length, 2);
  } finally {
    f.close();
  }
});
test('shopping scopes protect lists, histories and restock links; SQL rejects cross-scope containment', () => {
  const f = fixture();
  try {
    const sharedList = f.list(),
      privateList = f.list(f.privateScope),
      privateItem = f.add(privateList, 'Secret present'),
      restock = f.product(f.privateScope);
    assert.throws(() => f.shopping.get(f.b, privateItem), NotFound);
    assert.throws(() => f.history.list(f.b, privateItem, 'shopping_entry'), NotFound);
    assert.equal(f.shopping.snapshot(f.b).lists.length, 1);
    assert.equal(f.shopping.snapshot(f.b).entries.length, 0);
    rejected(
      f.run('NeedRestockItem', {
        recordId: randomUUID(),
        listId: sharedList,
        restockItemId: restock,
        expectedRestockRevision: 1,
      }),
      'scope_mismatch',
    );
    rejected(
      f.run(
        'AddShoppingEntry',
        { recordId: randomUUID(), listId: privateList, label: 'Probe', quantity: '', notes: '' },
        f.b,
      ),
      'unavailable',
    );
    assert.throws(
      () =>
        f.db
          .prepare('UPDATE shopping_entries SET shopping_list_id=? WHERE shopping_entry_id=?')
          .run(sharedList, privateItem),
      /FOREIGN KEY/,
    );
    rejected(
      f.run('MoveShoppingEntry', { recordId: privateItem, expectedRevision: 1, listId: sharedList }),
      'scope_mismatch',
    );
  } finally {
    f.close();
  }
});
test('deletion frees a restock slot, restoration guards duplicates, and list removal respects active children', () => {
  const f = fixture();
  try {
    const list = f.list(),
      restock = f.product(),
      id = randomUUID();
    const need = { recordId: id, listId: list, restockItemId: restock, expectedRestockRevision: 1 };
    applied(f.run('NeedRestockItem', need));
    rejected(f.run('DeleteShoppingRecord', { recordId: list, expectedRevision: 1 }), 'list_contains_items');
    const deletion = applied(f.run('DeleteShoppingRecord', { recordId: id, expectedRevision: 1 }));
    const next = randomUUID();
    applied(f.run('NeedRestockItem', { ...need, recordId: next }));
    rejected(f.run('UndoChangeSet', { changeSetId: deletion.changeSetId }), 'restock_already_needed');
    applied(f.run('DeleteShoppingRecord', { recordId: next, expectedRevision: 1 }));
    applied(f.run('UndoChangeSet', { changeSetId: deletion.changeSetId }));
    assert.equal(f.get(id).deletedAt, null);
    assert.equal(f.get(list).revision, 1);
    const second = f.list();
    applied(
      f.run('MoveShoppingEntry', { recordId: id, expectedRevision: f.get(id).revision, listId: second }),
    );
    applied(f.run('DeleteShoppingRecord', { recordId: list, expectedRevision: 1 }));
  } finally {
    f.close();
  }
});
test('competing purchase operations reject stale revisions; failed commit rolls back purchase, check-off, history and receipt', () => {
  const f = fixture();
  try {
    const id = f.add(f.list()),
      args = f.buy(id);
    const failing = new WriteCoordinator(
      f.db,
      f.inbox,
      f.history,
      f.now,
      f.records,
      () => {
        throw new Error('injected');
      },
      [f.shopping.commands()],
    );
    const request = f.envelope(args);
    assert.throws(() => failing.execute(f.a, 'PurchaseShoppingEntry', request), /injected/);
    assert.equal(f.shopping.snapshot(f.a).purchases.length, 0);
    assert.equal(f.get(id).revision, 1);
    assert.equal(
      f.writes.resolve(f.a, request.operationId, request.expectedServerEpoch).status,
      'Unresolved',
    );
    applied(f.writes.execute(f.a, 'PurchaseShoppingEntry', request));
    rejected(
      f.run(
        'PurchaseShoppingEntry',
        { ...args, purchaseId: randomUUID(), purchaseItemId: randomUUID() },
        f.b,
      ),
      'revision_conflict',
    );
    assert.equal(f.shopping.snapshot(f.b).purchases.length, 1);
  } finally {
    f.close();
  }
});
