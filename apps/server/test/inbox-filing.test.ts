import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  filingOf,
  type Attachment,
  type CommandKind,
  type CommandOutcome,
  type InboxEntry,
} from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { migrate } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { ProtocolConflict } from '../src/application/errors.js';

function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}
function rejected(outcome: CommandOutcome, code: string) {
  assert.equal(outcome.status, 'Rejected', JSON.stringify(outcome));
  if (outcome.status === 'Rejected') assert.equal(outcome.code, code);
}
async function fixture() {
  const f = await integrationFixture(),
    service = await buildApp({
      db: f.db,
      dataRoot: f.dataRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
  const a = service.access.authenticate('a'.repeat(43)),
    b = service.access.authenticate('b'.repeat(43)),
    features = createRecordFeatures(f.db, service.access);
  const shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = <T>(args: T) => ({
    operationId: randomUUID(),
    contractVersion: 1 as const,
    expectedServerEpoch: 'fixture-epoch',
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, c = a) => service.writes.execute(c, kind, envelope(args));
  const note = (scopeId = shared, attachments: Attachment[] = [], text = 'Replace the toothbrush heads') => {
    const inboxId = randomUUID();
    applied(
      run('CreateInboxEntry', {
        inboxId,
        scopeId,
        text,
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments,
      }),
    );
    return service.inbox.get(a, inboxId);
  };
  const task = (scopeId = shared) => ({
    kind: 'CreateTask' as const,
    arguments: {
      recordId: randomUUID(),
      occurrenceId: randomUUID(),
      scopeId,
      title: 'Replace brush heads',
      instructions: 'Use the original note and photos.',
      context: 'home' as const,
      defaultAssigneeId: null,
      defaultPriority: 1,
      recurrence: null,
      assigneeId: null,
      priority: 1,
      deadlineDate: null,
      targetDate: null,
      reviewDate: null,
    },
  });
  const file = (source: InboxEntry, destination: unknown, c = a) =>
    run('FileInboxEntry', { inboxId: source.inboxId, expectedRevision: source.revision, destination }, c);
  return {
    ...f,
    service,
    features,
    a,
    b,
    shared,
    privateScope,
    envelope,
    run,
    note,
    task,
    file,
    get: (id: string) => service.inbox.get(a, id),
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('filing into a new task is one reversible action, preserves source media and replays the exact receipt', async () => {
  const f = await fixture();
  try {
    const original = f.service.inbox.snapshot(f.a, f.now()).entries.find((e) => e.attachments.length)!;
    const note = f.note(
      f.shared,
      original.attachments.map((a) => ({ ...a, attachmentId: randomUUID() })),
    );
    const destination = f.task(),
      request = f.envelope({ inboxId: note.inboxId, expectedRevision: note.revision, destination });
    const saved = applied(f.service.writes.execute(f.a, 'FileInboxEntry', request));
    assert.equal(saved.result.records.length, 3);
    assert.deepEqual(f.service.writes.execute(f.a, 'FileInboxEntry', request), { ...saved, replayed: true });
    const filed = f.get(note.inboxId);
    assert.equal(filed.filedAt, f.now());
    assert.deepEqual(filed.destinations, [{ recordId: destination.arguments.recordId, filedAt: f.now() }]);
    for (const key of ['text', 'source', 'capturedAt', 'attachments'] as const)
      assert.deepEqual(filed[key], note[key]);
    assert.equal(f.features.records.get(f.a, destination.arguments.recordId).revision, 1);
    assert.equal(f.features.records.get(f.a, destination.arguments.occurrenceId).revision, 1);
    const history = f.service.history.list(f.a, note.inboxId);
    assert.deepEqual(filingOf(history.at(-1)!.version), { filedAt: null, destinations: [] });
    const undo = applied(f.run('UndoChangeSet', { changeSetId: saved.changeSetId }));
    assert.deepEqual(filingOf(f.get(note.inboxId)), { filedAt: null, destinations: [] });
    assert.notEqual(f.features.records.get(f.a, destination.arguments.recordId).content.deletedAt, null);
    assert.deepEqual(f.get(note.inboxId).attachments, note.attachments);
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    assert.equal(f.features.records.get(f.a, destination.arguments.recordId).content.deletedAt, null);
    assert.deepEqual(filingOf(f.get(note.inboxId)), filingOf(filed));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.throws(
      () =>
        f.service.writes.execute(f.a, 'FileInboxEntry', {
          ...request,
          arguments: {
            ...request.arguments,
            destination: {
              ...destination,
              arguments: { ...destination.arguments, title: 'Changed request' },
            },
          },
        }),
      ProtocolConflict,
    );
  } finally {
    await f.close();
  }
});

test('existing destinations are weak source-owned references, return keeps provenance, and unlinking never deletes targets', async () => {
  const f = await fixture();
  try {
    const source = f.note(),
      target = f.note(),
      targetHistory = f.service.history.list(f.a, target.inboxId);
    const first = applied(f.file(source, { kind: 'existing', recordId: target.inboxId }));
    assert.deepEqual(f.service.history.list(f.a, target.inboxId), targetHistory);
    let current = f.get(source.inboxId);
    const repeated = applied(f.file(current, { kind: 'existing', recordId: target.inboxId }));
    assert.equal(repeated.changeSetId, undefined);
    assert.equal(f.get(source.inboxId).revision, current.revision);
    applied(f.run('ReturnInboxEntry', { inboxId: source.inboxId, expectedRevision: current.revision }));
    current = f.get(source.inboxId);
    assert.equal(current.filedAt, null);
    assert.equal(current.destinations!.length, 1);
    applied(f.file(current, { kind: 'existing', recordId: target.inboxId }));
    applied(f.run('DeleteInboxEntry', { inboxId: target.inboxId, expectedRevision: target.revision }));
    current = f.get(source.inboxId);
    assert.equal(current.destinations!.length, 1);
    applied(
      f.run('RemoveInboxDestination', {
        inboxId: source.inboxId,
        expectedRevision: current.revision,
        recordId: target.inboxId,
      }),
    );
    assert.deepEqual(filingOf(f.get(source.inboxId)), { filedAt: null, destinations: [] });
    assert.notEqual(f.get(target.inboxId).deletedAt, null);
    assert.ok(first.changeSetId);
    const another = f.note(),
      linked = applied(f.file(another, { kind: 'existing', recordId: source.inboxId }));
    const undo = applied(f.run('UndoChangeSet', { changeSetId: linked.changeSetId }));
    applied(
      f.run('DeleteInboxEntry', {
        inboxId: source.inboxId,
        expectedRevision: f.get(source.inboxId).revision,
      }),
    );
    // History can restore a retained link to a since-deleted target without reviving it.
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    assert.equal(f.get(another.inboxId).destinations![0]!.recordId, source.inboxId);
    assert.notEqual(f.get(source.inboxId).deletedAt, null);
  } finally {
    await f.close();
  }
});

test('filing privacy covers source, destination, creation audience, history and SQL relationships', async () => {
  const f = await fixture();
  try {
    const shared = f.note(),
      secret = f.note(f.privateScope),
      partnerBefore = f.service.inbox.snapshot(f.b, f.now());
    rejected(f.file(shared, { kind: 'existing', recordId: secret.inboxId }), 'link_unavailable');
    rejected(f.file(secret, { kind: 'existing', recordId: shared.inboxId }, f.b), 'unavailable');
    const created = f.task(f.shared);
    rejected(f.file(secret, created), 'filing_requires_same_visibility');
    assert.equal(
      f.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(created.arguments.recordId),
      undefined,
    );
    applied(f.file(secret, { kind: 'existing', recordId: shared.inboxId }));
    assert.deepEqual(f.service.inbox.snapshot(f.b, f.now()), partnerBefore);
    assert.throws(() => f.service.history.list(f.b, secret.inboxId));
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO inbox_destinations VALUES (?,?,?,?,?)')
          .run(shared.inboxId, f.shared, secret.inboxId, f.privateScope, f.now()),
      /audience/,
    );
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO inbox_destinations VALUES (?,?,?,?,?)')
          .run(shared.inboxId, f.shared, secret.inboxId, f.shared, f.now()),
      /FOREIGN KEY/,
    );
    const current = f.get(secret.inboxId);
    rejected(f.file(current, { kind: 'existing', recordId: current.inboxId }), 'cannot_file_into_itself');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('shopping and project creation reuse their domain rules and commit with source filing', async () => {
  const f = await fixture();
  try {
    const list = randomUUID(),
      project = randomUUID(),
      note = f.note();
    applied(
      f.run('CreateShoppingList', {
        recordId: list,
        scopeId: f.shared,
        name: 'Supplies',
        purpose: 'household',
      }),
    );
    applied(
      f.run('CreateProject', { recordId: project, scopeId: f.shared, title: 'Bathroom', description: '' }),
    );
    const entry = randomUUID(),
      page = randomUUID();
    applied(
      f.file(note, {
        kind: 'AddShoppingEntry',
        arguments: {
          recordId: entry,
          listId: list,
          label: 'Brush heads',
          quantity: '2',
          notes: 'Check the original capture.',
        },
      }),
    );
    const next = f.get(note.inboxId);
    applied(
      f.file(next, {
        kind: 'CreateProjectPage',
        arguments: {
          recordId: page,
          projectId: project,
          parentPageId: null,
          title: 'Brush details',
          blocks: [
            {
              blockId: randomUUID(),
              kind: 'record_link',
              recordId: note.inboxId,
              caption: 'Original capture',
            },
          ],
        },
      }),
    );
    assert.equal(f.get(note.inboxId).destinations!.length, 2);
    assert.equal(f.features.records.get(f.a, entry).kind, 'shopping_entry');
    assert.equal(f.features.records.get(f.a, page).kind, 'project_page');
    const missing = {
      kind: 'AddShoppingEntry',
      arguments: {
        recordId: randomUUID(),
        listId: randomUUID(),
        label: 'Missing list',
        quantity: '',
        notes: '',
      },
    };
    rejected(f.file(f.get(note.inboxId), missing), 'unavailable');
    const secret = f.note(f.privateScope);
    rejected(
      f.file(secret, {
        kind: 'CreateProjectPage',
        arguments: {
          recordId: randomUUID(),
          projectId: project,
          parentPageId: null,
          title: 'Private',
          blocks: [],
        },
      }),
      'filing_requires_same_visibility',
    );
    assert.equal(f.get(secret.inboxId).revision, 1);
  } finally {
    await f.close();
  }
});

for (const stage of ['inbox_destinations', 'operation_receipts'])
  test(`failed ${stage} write rolls back the destination, source, history and receipt`, async () => {
    const f = await fixture();
    try {
      const source = f.note(),
        request = f.envelope({
          inboxId: source.inboxId,
          expectedRevision: source.revision,
          destination: f.task(),
        });
      const tables = [
        'records',
        'inbox_entries',
        'inbox_destinations',
        'tasks',
        'task_occurrences',
        'record_changes',
        'change_sets',
        'operation_receipts',
      ];
      const before = tables.map((t) => f.db.prepare(`SELECT * FROM ${t}`).all());
      f.db.exec(
        `CREATE TEMP TRIGGER fail_filing BEFORE INSERT ON ${stage} BEGIN SELECT RAISE(ABORT,'injected filing failure'); END`,
      );
      assert.throws(
        () => f.service.writes.execute(f.a, 'FileInboxEntry', request),
        /injected filing failure/,
      );
      tables.forEach((table, i) =>
        assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), before[i], table),
      );
      f.db.exec('DROP TRIGGER fail_filing');
      applied(f.service.writes.execute(f.a, 'FileInboxEntry', request));
      assert.equal(f.get(source.inboxId).destinations!.length, 1);
    } finally {
      await f.close();
    }
  });

test('stale captures and later partner edits guard filing and compound undo', async () => {
  const f = await fixture();
  try {
    const source = f.note(),
      destination = f.task();
    const filed = applied(f.file(source, destination));
    rejected(f.file(source, f.task()), 'revision_conflict');
    rejected(f.run('UndoChangeSet', { changeSetId: filed.changeSetId }, f.b), 'unavailable');
    applied(
      f.run(
        'UpdateTaskOccurrence',
        {
          recordId: destination.arguments.occurrenceId,
          expectedRevision: 1,
          assigneeId: null,
          priority: 3,
          deadlineDate: null,
          targetDate: null,
          reviewDate: null,
        },
        f.b,
      ),
    );
    const before = f.get(source.inboxId);
    rejected(f.run('UndoChangeSet', { changeSetId: filed.changeSetId }), 'revision_conflict');
    assert.deepEqual(f.get(source.inboxId), before);
    const suggestion = f.note();
    applied(
      f.run('SetInboxEntryCategory', {
        inboxId: suggestion.inboxId,
        expectedRevision: 1,
        category: 'app_suggestion',
      }),
    );
    rejected(f.file(f.get(suggestion.inboxId), f.task()), 'only_inbox_entries_can_be_filed');
  } finally {
    await f.close();
  }
});

test('destination limit rejects further creation before changing any domain data', async () => {
  const f = await fixture();
  try {
    const source = f.note();
    for (let index = 0; index < 20; index++)
      applied(f.file(f.get(source.inboxId), { kind: 'existing', recordId: f.note().inboxId }));
    const before = f.get(source.inboxId),
      destination = f.task();
    rejected(f.file(before, destination), 'inbox_destination_limit');
    assert.deepEqual(f.get(source.inboxId), before);
    assert.equal(
      f.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(destination.arguments.recordId),
      undefined,
    );
    // Refiling a retained destination is still a no-op at capacity.
    applied(f.file(before, { kind: 'existing', recordId: before.destinations![0]!.recordId }));
    assert.equal(f.get(source.inboxId).revision, before.revision);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('HTTP filing rejects unlisted or malformed nested commands and preserves creator validation', async () => {
  const f = await fixture();
  try {
    const note = f.note();
    const send = (destination: unknown) =>
      f.service.app.inject({
        method: 'POST',
        url: '/api/commands/FileInboxEntry',
        headers: { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' },
        payload: f.envelope({ inboxId: note.inboxId, expectedRevision: note.revision, destination }),
      });
    for (const destination of [
      { kind: 'DeleteInboxEntry', arguments: { inboxId: note.inboxId, expectedRevision: 1 } },
      { ...f.task(), arguments: { ...f.task().arguments, defaultPriority: 100 } },
      { ...f.task(), extra: 'unrecognised' },
    ]) {
      const response = await send(destination);
      assert.ok([200, 400].includes(response.statusCode), response.body);
      assert.notEqual(response.json().status, 'Applied');
      assert.deepEqual(f.get(note.inboxId), note);
    }
    const projectId = randomUUID(),
      pageId = randomUUID();
    applied(
      f.run('CreateProject', {
        recordId: projectId,
        scopeId: f.shared,
        title: 'Fixture board',
        description: '',
      }),
    );
    const response = await send({
      kind: 'CreateProjectPage',
      arguments: {
        recordId: pageId,
        projectId,
        parentPageId: randomUUID(),
        title: 'Missing parent',
        blocks: [],
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'Rejected');
    assert.deepEqual(f.get(note.inboxId), note);
    assert.equal(f.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(pageId), undefined);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('old retained history, receipts and capture bytes survive the additive filing migration and its rollback', async () => {
  const f = await integrationFixture();
  try {
    // Bring the published fixture only as far as the currently deployed schema.
    const { readdir } = await import('node:fs/promises');
    for (const file of (await readdir(migrationsRoot)).filter((n) => n.endsWith('.sql') && n < '021_'))
      await copyFile(join(migrationsRoot, file), join(f.oldMigrations, file));
    migrate(f.db, f.oldMigrations);
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name!='schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const selects = tables.map(
      (t) =>
        `SELECT ${(f.db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${t} ORDER BY rowid`,
    );
    const before = selects.map((sql) => JSON.stringify(f.db.prepare(sql).all()));
    const schemas = f.db.prepare('SELECT * FROM schema_migrations').all(),
      filename = '021_inbox_filing.sql';
    const sql = await readFile(join(migrationsRoot, filename), 'utf8');
    await writeFile(join(f.oldMigrations, filename), sql + '\nSELECT missing_filing_migration();');
    assert.throws(() => migrate(f.db, f.oldMigrations), /function/);
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), schemas);
    assert.equal(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name='inbox_destinations'").get(),
      undefined,
    );
    selects.forEach((sql, i) => assert.equal(JSON.stringify(f.db.prepare(sql).all()), before[i], tables[i]));
    migrate(f.db);
    selects.forEach((sql, i) => assert.equal(JSON.stringify(f.db.prepare(sql).all()), before[i], tables[i]));
    const service = await buildApp({
      db: f.db,
      dataRoot: f.dataRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
    try {
      for (const old of f.legacy.commands)
        assert.deepEqual(service.writes.execute(old.context, old.kind, old.command), {
          ...old.outcome,
          replayed: true,
        });
      const pending = f.legacy.pending;
      const frozen = JSON.stringify(pending.command);
      const result = applied(service.writes.execute(pending.context, pending.kind, pending.command));
      assert.equal(JSON.stringify(pending.command), frozen);
      assert.deepEqual(service.writes.execute(pending.context, pending.kind, JSON.parse(frozen)), {
        ...result,
        replayed: true,
      });
      const a = service.access.authenticate('a'.repeat(43));
      for (const note of service.inbox.snapshot(a, f.now()).entries) {
        assert.deepEqual(filingOf(note), { filedAt: null, destinations: [] });
        for (const version of service.history.list(a, note.inboxId))
          assert.deepEqual(filingOf(version.version), { filedAt: null, destinations: [] });
      }
    } finally {
      await service.app.close();
    }
    assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
