import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Attachment,
  RestockItem,
  Purchase,
  CommandKind,
  CommandOutcome,
  Envelope,
  ShoppingRecord,
} from '@our-place/contracts';
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

// Attachment ownership/retention tests need metadata; byte transport is exercised by HTTP/browser tests.
function photo(f: ReturnType<typeof fixture>, scopeId = f.shared): Attachment {
  const mediaId = randomUUID();
  f.db
    .prepare(
      `INSERT INTO media_objects(media_id,scope_id,creator_client_id,digest,byte_length,mime_type,
    storage_key,generation,state,created_at,unreferenced_at,protected_until)
    VALUES (?,?,?, ?,1,'image/png',?,?,'ready',?,?,0)`,
    )
    .run(mediaId, scopeId, f.a.clientId, 'a'.repeat(64), mediaId, randomUUID(), f.now(), f.now());
  return {
    attachmentId: randomUUID(),
    mediaId,
    digest: 'a'.repeat(64),
    byteLength: 1,
    mimeType: 'image/png',
    position: 0,
    caption: 'Product label',
  };
}
const photos = (f: ReturnType<typeof fixture>, id: string) =>
  (f.get(id) as RestockItem | Purchase).attachments;

test('restock photos survive old-client detail edits and follow deletion, restore and history retention', () => {
  const f = fixture();
  try {
    const id = f.product(),
      image = photo(f);
    applied(f.run('SetRecordAttachments', { recordId: id, expectedRevision: 1, attachments: [image] }));
    applied(
      f.run('UpdateRestockItem', {
        recordId: id,
        expectedRevision: 2,
        name: 'Brush heads',
        model: 'New size',
        quantity: '2 packs',
        notes: 'Soft',
        productUrl: null,
      }),
    );
    assert.deepEqual(photos(f, id), [image], 'Old request without attachments must preserve them');
    assert.deepEqual(f.shopping.snapshot(f.b).restockItems[0]!.attachments, [image]);
    const retention = () =>
      (
        f.db.prepare('SELECT unreferenced_at FROM media_objects WHERE media_id=?').get(image.mediaId) as {
          unreferenced_at: number | null;
        }
      ).unreferenced_at;
    assert.equal(retention(), null);
    applied(f.run('DeleteShoppingRecord', { recordId: id, expectedRevision: 3 }));
    assert.ok(retention());
    applied(f.run('RestoreShoppingRecord', { recordId: id, expectedRevision: 4 }));
    assert.equal(retention(), null);
    const removed = applied(
      f.run('SetRecordAttachments', { recordId: id, expectedRevision: 5, attachments: [] }),
    );
    assert.ok(retention());
    const restored = applied(f.run('UndoChangeSet', { changeSetId: removed.changeSetId }));
    assert.deepEqual(photos(f, id), [image]);
    assert.equal(retention(), null);
    applied(f.run('RedoChangeSet', { changeSetId: restored.changeSetId }));
    assert.deepEqual(photos(f, id), []);
    const history = f.history.list<RestockItem>(f.a, id, 'restock_item');
    assert.deepEqual(history[1]!.version.attachments, [image]);
    assert.deepEqual(history.at(-1)!.version.attachments, []);
  } finally {
    f.close();
  }
});

test('receipt edits leave immutable purchase facts intact, replay once and reject stale partner changes', () => {
  const f = fixture();
  try {
    const entry = f.add(f.list()),
      buy = f.buy(entry);
    applied(f.run('PurchaseShoppingEntry', buy));
    const image = photo(f),
      request = f.envelope({ recordId: buy.purchaseId, expectedRevision: 1, attachments: [image] });
    const before = f.db.prepare('SELECT * FROM purchases').all();
    const lines = f.db.prepare('SELECT * FROM purchase_items').all();
    const saved = applied(f.writes.execute(f.a, 'SetRecordAttachments', request));
    assert.equal(applied(f.writes.execute(f.a, 'SetRecordAttachments', request)).replayed, true);
    assert.equal(f.get(buy.purchaseId).revision, 2);
    assert.equal(f.get(entry).revision, 2);
    assert.deepEqual(f.db.prepare('SELECT * FROM purchases').all(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM purchase_items').all(), lines);
    assert.throws(
      () =>
        f.db.transaction(() => {
          const record = f.shopping.get(f.a, buy.purchaseId);
          f.records.setContent(f.a, record, { ...record.content, boughtAt: 0 }, f.now());
        })(),
      /Purchase snapshots are immutable/,
    );
    rejected(
      f.run('SetRecordAttachments', { recordId: buy.purchaseId, expectedRevision: 1, attachments: [] }, f.b),
      'revision_conflict',
    );
    const annotated = { ...image, caption: 'Partner added receipt detail' };
    applied(
      f.run(
        'SetRecordAttachments',
        { recordId: buy.purchaseId, expectedRevision: 2, attachments: [annotated] },
        f.b,
      ),
    );
    assert.equal(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }).status, 'Rejected');
    assert.deepEqual(photos(f, buy.purchaseId), [annotated]);
    assert.deepEqual(
      f.history.list<Purchase>(f.a, buy.purchaseId, 'purchase').at(-1)!.version.attachments,
      [],
    );
  } finally {
    f.close();
  }
});

test('shopping attachments enforce private visibility, allowed kinds and atomic rejection', () => {
  const f = fixture();
  try {
    const privateId = f.product(f.privateScope),
      sharedId = f.product(),
      secret = photo(f, f.privateScope);
    applied(
      f.run('SetRecordAttachments', { recordId: privateId, expectedRevision: 1, attachments: [secret] }),
    );
    rejected(
      f.run('SetRecordAttachments', { recordId: privateId, expectedRevision: 2, attachments: [] }, f.b),
      'unavailable',
    );
    assert.throws(() => f.history.list(f.b, privateId, 'restock_item'), NotFound);
    assert.equal(
      f.shopping.snapshot(f.b).restockItems.some((r) => r.recordId === privateId),
      false,
    );
    const valid = photo(f),
      invalid = { ...secret, attachmentId: randomUUID(), position: 1 };
    rejected(
      f.run('SetRecordAttachments', {
        recordId: sharedId,
        expectedRevision: 1,
        attachments: [valid, invalid],
      }),
      'media_unavailable',
    );
    assert.equal(f.get(sharedId).revision, 1);
    assert.deepEqual(photos(f, sharedId), []);
    assert.equal(f.db.prepare('SELECT 1 FROM attachments WHERE media_id=?').get(valid.mediaId), undefined);
    const list = f.list(),
      entry = f.add(list);
    for (const id of [list, entry])
      rejected(
        f.run('SetRecordAttachments', { recordId: id, expectedRevision: 1, attachments: [] }),
        'attachments_not_supported',
      );
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
    const attempt = f.envelope({ recordId: sharedId, expectedRevision: 1, attachments: [valid] });
    assert.throws(() => failing.execute(f.a, 'SetRecordAttachments', attempt), /injected/);
    assert.equal(f.get(sharedId).revision, 1);
    assert.deepEqual(photos(f, sharedId), []);
    assert.equal(
      f.writes.resolve(f.a, attempt.operationId, attempt.expectedServerEpoch).status,
      'Unresolved',
    );
  } finally {
    f.close();
  }
});

test('pre-photo shopping history normalises missing fields without changing existing journals', () => {
  const f = fixture();
  try {
    const product = f.product(),
      entry = f.add(f.list()),
      buy = f.buy(entry);
    applied(f.run('PurchaseShoppingEntry', buy));
    for (const id of [product, buy.purchaseId]) {
      const row = f.db
        .prepare('SELECT change_set_id,delta_json FROM record_changes WHERE record_id=?')
        .get(id) as { change_set_id: string; delta_json: string };
      const delta = JSON.parse(row.delta_json);
      delete delta.baseline.attachments;
      f.db.prepare('UPDATE record_changes SET delta_json=? WHERE record_id=?').run(JSON.stringify(delta), id);
      const stored = f.db.prepare('SELECT delta_json FROM record_changes WHERE record_id=?').get(id);
      const kind = id === product ? 'restock_item' : 'purchase';
      const old = f.history.list<RestockItem | Purchase>(f.a, id, kind);
      assert.deepEqual(old[0]!.version.attachments, []);
      const image = photo(f);
      applied(f.run('SetRecordAttachments', { recordId: id, expectedRevision: 1, attachments: [image] }));
      assert.deepEqual(f.history.list<RestockItem | Purchase>(f.a, id, kind).at(-1)!.version.attachments, []);
      assert.deepEqual(
        f.db
          .prepare('SELECT delta_json FROM record_changes WHERE record_id=? AND change_set_id=?')
          .get(id, row.change_set_id),
        stored,
      );
    }
  } finally {
    f.close();
  }
});
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
