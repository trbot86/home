import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandKind, Envelope, CommandOutcome } from '@our-place/contracts';
import {
  initialiseInstallation,
  installation,
  migrate,
  openDatabase,
  immediate,
} from '../src/infrastructure/database.js';
import { AccessService, type RequestContext } from '../src/features/access/access.js';
import { InboxRepository } from '../src/features/inbox/inbox.js';
import { HistoryService } from '../src/features/history/history.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { ProtocolConflict, NotFound, Rejection } from '../src/application/errors.js';
import { migrationsRoot } from '../src/paths.js';

function fixture(migrationsPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'our-place-foundation-'));
  const db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationsPath);
  initialiseInstallation(db);
  const alice: RequestContext = {
    clientId: randomUUID(),
    personId: randomUUID(),
    credentialId: randomUUID(),
    kind: 'browser',
  };
  const bob: RequestContext = {
    clientId: randomUUID(),
    personId: randomUUID(),
    credentialId: randomUUID(),
    kind: 'browser',
  };
  for (const [person, name] of [
    [alice, 'Alice'],
    [bob, 'Bob'],
  ] as const) {
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      person.personId,
      name.toLowerCase(),
      name,
      'test-only-no-login',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      person.clientId,
      person.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), person.personId);
  }
  let time = 1000;
  const now = () => ++time;
  const access = new AccessService(db, now);
  const inbox = new InboxRepository(db, access);
  const records = new RecordRegistry(db, [inboxRecordAdapter(inbox)]);
  const history = new HistoryService(db, records, access);
  const writes = new WriteCoordinator(db, inbox, history, now, records);
  const shared = access.scopes(alice).find((s) => s.kind === 'shared')!.scopeId;
  const privateScope = access.scopes(alice).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const create = (scopeId = shared) =>
    envelope({
      inboxId: randomUUID(),
      scopeId,
      text: 'Original note',
      capturedAt: 123,
      source: { kind: 'typed' },
      attachments: [],
    });
  return {
    root,
    db,
    alice,
    bob,
    now,
    access,
    inbox,
    history,
    writes,
    records,
    shared,
    privateScope,
    envelope,
    create,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied');
  if (outcome.status !== 'Applied') throw new Error('Expected applied');
  return outcome;
}

test('shopping migration preserves existing household identity, inbox, history and receipts', () => {
  const oldMigrations = mkdtempSync(join(tmpdir(), 'our-place-before-shopping-'));
  for (const file of ['001_foundation.sql', '002_operations.sql', '003_capture_categories.sql'])
    copyFileSync(join(migrationsRoot, file), join(oldMigrations, file));
  const f = fixture(oldMigrations);
  try {
    const command = f.create();
    const original = applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
    const tables = [
      'installation_state',
      'people',
      'clients',
      'visibility_scopes',
      'records',
      'inbox_entries',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const selects = tables.map((table) => {
      const columns = f.db.pragma(`table_info(${table})`) as { name: string }[];
      return `SELECT ${columns.map((column) => column.name).join(',')} FROM ${table} ORDER BY rowid`;
    });
    const snapshot = () => selects.map((sql) => f.db.prepare(sql).all());
    const before = snapshot();
    migrate(f.db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.deepEqual(applied(f.writes.execute(f.alice, 'CreateInboxEntry', command)), {
      ...original,
      replayed: true,
    });
    applied(f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: original.changeSetId })));
    assert.notEqual(f.inbox.get(f.alice, original.result.records[0]!.recordId).deletedAt, null);
  } finally {
    f.close();
    rmSync(oldMigrations, { recursive: true, force: true });
  }
});

test('multi-record history reverses atomically and rejects an intervening edit to either root', () => {
  const f = fixture();
  try {
    const ids = [0, 1]
      .map(
        () => applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create())).result.records[0]!.recordId,
      )
      .sort();
    const changeSetId = immediate(f.db, () => {
      const now = f.now();
      const changes = ids.map((id, index) => {
        const before = f.records.get(f.alice, id);
        return {
          before,
          after: f.records.setContent(f.alice, before, { ...before.content, text: `Together ${index}` }, now),
        };
      });
      return f.history.record(f.alice, 'SetInboxEntryText', changes, now);
    });
    const undoCommand = f.envelope({ changeSetId });
    const undo = applied(f.writes.execute(f.alice, 'UndoChangeSet', undoCommand));
    assert.equal(undo.result.records.length, 2);
    for (const id of ids) assert.equal(f.inbox.get(f.alice, id).text, 'Original note');
    assert.deepEqual(applied(f.writes.execute(f.alice, 'UndoChangeSet', undoCommand)).receipt, undo.receipt);
    const redo = applied(
      f.writes.execute(f.alice, 'RedoChangeSet', f.envelope({ changeSetId: undo.changeSetId })),
    );
    assert.deepEqual(
      ids.map((id) => f.inbox.get(f.alice, id).text),
      ['Together 0', 'Together 1'],
    );
    applied(
      f.writes.execute(
        f.bob,
        'SetInboxEntryText',
        f.envelope({ inboxId: ids[1], expectedRevision: 4, text: 'Partner edit' }),
      ),
    );
    assert.equal(f.history.list(f.alice, ids[0]!)[0]!.canUndo, false);
    const rejected = f.writes.execute(
      f.alice,
      'UndoChangeSet',
      f.envelope({ changeSetId: redo.changeSetId }),
    );
    assert.equal(rejected.status, 'Rejected');
    assert.equal(f.inbox.get(f.alice, ids[0]!).revision, 4);
    assert.deepEqual(
      ids.map((id) => f.inbox.get(f.alice, id).text),
      ['Together 0', 'Partner edit'],
    );
  } finally {
    f.close();
  }
});

test('a domain rejection in the second inverse rolls back the first inverse and history', () => {
  const f = fixture();
  try {
    const ids = [0, 1]
      .map(
        () => applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create())).result.records[0]!.recordId,
      )
      .sort();
    const changeSetId = immediate(f.db, () => {
      const now = f.now();
      const changes = ids.map((id) => {
        const before = f.records.get(f.alice, id);
        return {
          before,
          after: f.records.setContent(f.alice, before, { ...before.content, text: 'Compound edit' }, now),
        };
      });
      return f.history.record(f.alice, 'SetInboxEntryText', changes, now);
    });
    const adapter = inboxRecordAdapter(f.inbox);
    const guarded = new RecordRegistry(f.db, [
      {
        ...adapter,
        setContent(context, before, content, now) {
          if (before.recordId === ids[1]) throw new Rejection('fixture_dependency_changed');
          return adapter.setContent(context, before, content, now);
        },
      },
    ]);
    const history = new HistoryService(f.db, guarded, f.access);
    const writes = new WriteCoordinator(f.db, f.inbox, history, f.now, guarded);
    const historyCount = f.db.prepare('SELECT count(*) AS n FROM change_sets').get();
    const command = f.envelope({ changeSetId });
    assert.equal(writes.execute(f.alice, 'UndoChangeSet', command).status, 'Rejected');
    for (const id of ids) {
      assert.equal(f.inbox.get(f.alice, id).text, 'Compound edit');
      assert.equal(f.inbox.get(f.alice, id).revision, 2);
    }
    assert.deepEqual(f.db.prepare('SELECT count(*) AS n FROM change_sets').get(), historyCount);
    assert.equal((writes.execute(f.alice, 'UndoChangeSet', command) as { replayed: boolean }).replayed, true);
  } finally {
    f.close();
  }
});

test('retained inbox deltas without categories still reconstruct and undo after adapter generalisation', () => {
  const f = fixture();
  try {
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create()));
    const id = first.result.records[0]!.recordId;
    const row = f.db.prepare('SELECT delta_json FROM record_changes WHERE record_id=?').get(id) as {
      delta_json: string;
    };
    const legacy = JSON.parse(row.delta_json);
    delete legacy.baseline.category;
    f.db.prepare('UPDATE record_changes SET delta_json=? WHERE record_id=?').run(JSON.stringify(legacy), id);
    const edited = applied(
      f.writes.execute(
        f.alice,
        'SetInboxEntryText',
        f.envelope({ inboxId: id, expectedRevision: 1, text: 'Later text' }),
      ),
    );
    assert.deepEqual(
      f.history.list(f.alice, id).map((entry) => [entry.version.text, entry.version.category]),
      [
        ['Later text', 'inbox'],
        ['Original note', 'inbox'],
      ],
    );
    applied(f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: edited.changeSetId })));
    assert.equal(f.inbox.get(f.alice, id).text, 'Original note');
  } finally {
    f.close();
  }
});

test('categories preserve legacy retries, history, private visibility and guarded undo', () => {
  const f = fixture();
  try {
    const legacy = f.create();
    const created = applied(f.writes.execute(f.alice, 'CreateInboxEntry', legacy));
    const id = created.result.records[0]!.recordId;
    assert.equal(f.inbox.get(f.alice, id).category, 'inbox');
    const move = f.envelope({ inboxId: id, expectedRevision: 1, category: 'app_suggestion' });
    const moved = applied(f.writes.execute(f.alice, 'SetInboxEntryCategory', move));
    assert.equal(f.inbox.get(f.bob, id).category, 'app_suggestion');
    assert.deepEqual(applied(f.writes.execute(f.alice, 'CreateInboxEntry', legacy)).receipt, created.receipt);
    assert.equal(f.inbox.get(f.alice, id).category, 'app_suggestion');
    assert.equal(applied(f.writes.execute(f.alice, 'SetInboxEntryCategory', move)).replayed, true);
    assert.deepEqual(
      f.history.list(f.alice, id).map((h) => h.version.category),
      ['app_suggestion', 'inbox'],
    );
    const undo = applied(
      f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: moved.changeSetId })),
    );
    assert.equal(f.inbox.get(f.alice, id).category, 'inbox');
    applied(f.writes.execute(f.alice, 'RedoChangeSet', f.envelope({ changeSetId: undo.changeSetId })));
    assert.equal(f.inbox.get(f.alice, id).category, 'app_suggestion');
    const privateCreate = f.create(f.privateScope);
    (privateCreate.arguments as Record<string, unknown>).category = 'app_suggestion';
    const privateId = applied(f.writes.execute(f.alice, 'CreateInboxEntry', privateCreate)).result.records[0]!
      .recordId;
    assert.throws(() => f.inbox.get(f.bob, privateId), NotFound);
    assert.equal(
      f.writes.execute(
        f.bob,
        'SetInboxEntryCategory',
        f.envelope({ inboxId: privateId, expectedRevision: 1, category: 'inbox' }),
      ).status,
      'Rejected',
    );
    assert.equal(
      f.writes.execute(
        f.alice,
        'SetInboxEntryCategory',
        f.envelope({ inboxId: id, expectedRevision: 1, category: 'inbox' }),
      ).status,
      'Rejected',
    );
    assert.equal(
      f.writes.execute(
        f.alice,
        'SetInboxEntryCategory',
        f.envelope({ inboxId: id, expectedRevision: 4, category: 'invalid' }),
      ).status,
      'Rejected',
    );
  } finally {
    f.close();
  }
});
test('lost acknowledgement retries preserve original receipt after another person edits or deletes', () => {
  const f = fixture();
  try {
    const command = f.create();
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
    const id = first.result.records[0]!.recordId;
    applied(
      f.writes.execute(
        f.bob,
        'SetInboxEntryText',
        f.envelope({ inboxId: id, expectedRevision: 1, text: 'Bob changed this' }),
      ),
    );
    const replay = applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal(f.inbox.get(f.alice, id).text, 'Bob changed this');
    applied(f.writes.execute(f.bob, 'DeleteInboxEntry', f.envelope({ inboxId: id, expectedRevision: 2 })));
    f.writes.execute(f.alice, 'CreateInboxEntry', command);
    assert.equal(f.inbox.list(f.alice, f.now()).entries.length, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM records').get() as { n: number }).n, 1);
  } finally {
    f.close();
  }
});
test('operation digest is key-order independent, conflicts on changed arguments and is client scoped', () => {
  const f = fixture();
  try {
    const command = f.create();
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
    const reordered = JSON.parse(JSON.stringify(command, Object.keys(command).reverse())) as Envelope;
    const args = command.arguments as Record<string, unknown>;
    reordered.arguments = Object.fromEntries(Object.entries(args).reverse());
    assert.equal(applied(f.writes.execute(f.alice, 'CreateInboxEntry', reordered)).replayed, true);
    assert.throws(
      () =>
        f.writes.execute(f.alice, 'CreateInboxEntry', {
          ...command,
          arguments: { ...args, text: 'Changed' },
        }),
      ProtocolConflict,
    );
    const secondClientCommand = { ...f.create(), operationId: first.receipt.operationId };
    applied(f.writes.execute(f.bob, 'CreateInboxEntry', secondClientCommand));
  } finally {
    f.close();
  }
});
test('private IDs, lists, history, edits and inverses cannot expose another person content', () => {
  const f = fixture();
  try {
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create(f.privateScope)));
    const id = first.result.records[0]!.recordId;
    assert.equal(f.inbox.list(f.bob, f.now()).entries.length, 0);
    assert.throws(() => f.inbox.get(f.bob, id), NotFound);
    assert.throws(() => f.history.list(f.bob, id), NotFound);
    const result = f.writes.execute(
      f.bob,
      'SetInboxEntryText',
      f.envelope({ inboxId: id, expectedRevision: 1, text: 'Not allowed' }),
    );
    assert.equal(result.status, 'Rejected');
    assert.equal(
      f.writes.execute(f.bob, 'UndoChangeSet', f.envelope({ changeSetId: first.changeSetId })).status,
      'Rejected',
    );
  } finally {
    f.close();
  }
});
test('well-formed invalid arguments and stale edits receive durable final rejection', () => {
  const f = fixture();
  try {
    const invalid = f.envelope({ text: 5 });
    const rejected = f.writes.execute(f.alice, 'CreateInboxEntry', invalid);
    assert.equal(rejected.status, 'Rejected');
    assert.equal(
      (f.writes.execute(f.alice, 'CreateInboxEntry', invalid) as { replayed?: boolean }).replayed,
      true,
    );
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create()));
    const id = first.result.records[0]!.recordId;
    const edit = f.envelope({ inboxId: id, expectedRevision: 1, text: 'First edit' });
    applied(f.writes.execute(f.bob, 'SetInboxEntryText', edit));
    const stale = f.envelope({ inboxId: id, expectedRevision: 1, text: 'Original note' });
    assert.equal(f.writes.execute(f.alice, 'SetInboxEntryText', stale).status, 'Rejected');
    assert.equal(
      (f.writes.execute(f.alice, 'SetInboxEntryText', stale) as { replayed?: boolean }).replayed,
      true,
    );
  } finally {
    f.close();
  }
});
test('injected commit failure rolls back domain, history and receipt together', () => {
  const f = fixture();
  try {
    const coordinator = new WriteCoordinator(f.db, f.inbox, f.history, f.now, f.records, () => {
      throw new Error('injected failure');
    });
    const command = f.create();
    assert.throws(() => coordinator.execute(f.alice, 'CreateInboxEntry', command), /injected/);
    for (const table of ['records', 'inbox_entries', 'change_sets', 'record_changes', 'operation_receipts'])
      assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
  } finally {
    f.close();
  }
});
test('interleaved history preserves all versions; undo guards ownership and current revision', () => {
  const f = fixture();
  try {
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create()));
    const id = first.result.records[0]!.recordId;
    const a = applied(
      f.writes.execute(
        f.alice,
        'SetInboxEntryText',
        f.envelope({ inboxId: id, expectedRevision: 1, text: 'Alice edit' }),
      ),
    );
    const b = applied(
      f.writes.execute(
        f.bob,
        'SetInboxEntryText',
        f.envelope({ inboxId: id, expectedRevision: 2, text: 'Bob edit' }),
      ),
    );
    assert.equal(
      f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: a.changeSetId })).status,
      'Rejected',
    );
    const undo = applied(
      f.writes.execute(f.bob, 'UndoChangeSet', f.envelope({ changeSetId: b.changeSetId })),
    );
    assert.equal(f.inbox.get(f.alice, id).text, 'Alice edit');
    assert.equal(f.inbox.get(f.alice, id).revision, 4);
    const redo = applied(
      f.writes.execute(f.bob, 'RedoChangeSet', f.envelope({ changeSetId: undo.changeSetId })),
    );
    assert.equal(redo.result.records[0]!.revision, 5);
    assert.equal(f.inbox.get(f.alice, id).text, 'Bob edit');
    assert.deepEqual(
      f.history.list(f.alice, id).map((h) => h.version.text),
      ['Bob edit', 'Alice edit', 'Bob edit', 'Alice edit', 'Original note'],
    );
  } finally {
    f.close();
  }
});
test('undo creation soft-deletes and redo restores with increasing revisions', () => {
  const f = fixture();
  try {
    const first = applied(f.writes.execute(f.alice, 'CreateInboxEntry', f.create()));
    const id = first.result.records[0]!.recordId;
    const undo = applied(
      f.writes.execute(f.alice, 'UndoChangeSet', f.envelope({ changeSetId: first.changeSetId })),
    );
    assert.ok(f.inbox.get(f.alice, id).deletedAt);
    applied(f.writes.execute(f.alice, 'RedoChangeSet', f.envelope({ changeSetId: undo.changeSetId })));
    assert.equal(f.inbox.get(f.alice, id).deletedAt, null);
    assert.equal(f.inbox.get(f.alice, id).revision, 3);
  } finally {
    f.close();
  }
});
test('restore epoch blocks absent old operations but surviving receipts still resolve', () => {
  const f = fixture();
  try {
    const committed = f.create();
    const absent = f.create();
    applied(f.writes.execute(f.alice, 'CreateInboxEntry', committed));
    f.db.prepare('UPDATE installation_state SET recovery_epoch=?,restored_from_at=?').run(randomUUID(), 500);
    assert.equal(applied(f.writes.execute(f.alice, 'CreateInboxEntry', committed)).replayed, true);
    assert.equal(f.writes.execute(f.alice, 'CreateInboxEntry', absent).status, 'RecoveryRequired');
    assert.equal(
      f.writes.resolve(f.alice, absent.operationId, absent.expectedServerEpoch).status,
      'RecoveryRequired',
    );
  } finally {
    f.close();
  }
});
test('photo-only capture defers without a receipt until identical media is ready', () => {
  const f = fixture();
  try {
    const mediaId = randomUUID();
    const command = f.envelope({
      inboxId: randomUUID(),
      scopeId: f.shared,
      text: '',
      capturedAt: 5,
      source: { kind: 'photo' },
      attachments: [
        {
          attachmentId: randomUUID(),
          mediaId,
          digest: 'a'.repeat(64),
          byteLength: 12,
          mimeType: 'image/png',
          position: 0,
        },
      ],
    });
    assert.equal(f.writes.execute(f.alice, 'CreateInboxEntry', command).status, 'Deferred');
    assert.equal(
      f.writes.resolve(f.alice, command.operationId, command.expectedServerEpoch).status,
      'Unresolved',
    );
    f.db
      .prepare("INSERT INTO media_objects VALUES (?,?,?,?,?,?,?,?,'ready',?,NULL,?)")
      .run(
        mediaId,
        f.shared,
        f.alice.clientId,
        'a'.repeat(64),
        12,
        'image/png',
        'objects/test',
        'test-generation',
        f.now(),
        100000,
      );
    const result = applied(f.writes.execute(f.alice, 'CreateInboxEntry', command));
    assert.equal(f.inbox.get(f.alice, result.result.records[0]!.recordId).attachments.length, 1);
  } finally {
    f.close();
  }
});
test('pagination orders equal timestamps by ID and respects private scopes', () => {
  const f = fixture();
  try {
    for (let n = 0; n < 6; n++)
      applied(
        f.writes.execute(
          n < 3 && n % 2 ? f.bob : f.alice,
          'CreateInboxEntry',
          f.create(n < 3 ? f.shared : f.privateScope),
        ),
      );
    f.db.prepare('UPDATE records SET created_at=1000').run();
    const first = f.inbox.list(f.bob, f.now(), { limit: 2 });
    const second = f.inbox.list(f.bob, f.now(), { limit: 2, cursor: first.nextCursor! });
    assert.equal(first.entries.length + second.entries.length, 3);
    assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.inboxId)).size, 3);
  } finally {
    f.close();
  }
});
