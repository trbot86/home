import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandKind,
  CommandOutcome,
  Envelope,
  HomeRecord,
  TaskDefinition,
  TaskOccurrence,
} from '@our-place/contracts';
import {
  initialiseInstallation,
  installation,
  migrate,
  openDatabase,
} from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService, type HumanRequestContext as RequestContext } from '../src/features/access/access.js';
import { InboxRepository } from '../src/features/inbox/inbox.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { HomeRepository } from '../src/features/home/home.js';
import { TasksRepository } from '../src/features/tasks/tasks.js';
import { ShoppingRepository } from '../src/features/shopping/shopping.js';
import { HistoryService } from '../src/features/history/history.js';
import { WriteCoordinator } from '../src/application/write-coordinator.js';
import { NotFound } from '../src/application/errors.js';

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
  const root = mkdtempSync(join(tmpdir(), 'our-place-home-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationsPath);
  initialiseInstallation(db);
  const people = ['Alex', 'Sam'].map((name) => {
    const context: RequestContext = {
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
  let clock = Date.parse('2026-09-27T16:00:00Z');
  const now = () => ++clock;
  const access = new AccessService(db, now),
    inbox = new InboxRepository(db, access),
    shopping = new ShoppingRepository(db, access);
  let failCommit = false;
  const services = () => {
    const home = new HomeRepository(db, access),
      enabled = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='home_assets'").get();
    const tasks = new TasksRepository(db, access, 'America/Toronto', enabled ? home : undefined);
    const records = new RecordRegistry(db, [
      inboxRecordAdapter(inbox),
      ...shopping.adapters(),
      ...tasks.adapters(),
      ...(enabled ? home.adapters() : []),
    ]);
    const history = new HistoryService(db, records, access);
    const writes = new WriteCoordinator(
      db,
      inbox,
      history,
      now,
      records,
      () => {
        if (failCommit) throw new Error('injected failure');
      },
      [shopping.commands(), tasks.commands(), ...(enabled ? [home.commands()] : [])],
    );
    return { home, tasks, records, history, writes };
  };
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
  const assetArgs = (scopeId = shared) => ({
    recordId: randomUUID(),
    scopeId,
    name: 'Heat pump',
    model: 'Fixture model',
    serial: 'Serial fixture',
    location: 'Utility room',
    acquiredDate: '2024-02-29',
    notes: 'Use the washable filter.',
  });
  const taskArgs = (assetId: string | null, scopeId = shared) => ({
    recordId: randomUUID(),
    occurrenceId: randomUUID(),
    scopeId,
    title: 'Clean filter',
    instructions: 'Rinse and dry',
    context: 'home',
    defaultAssigneeId: null,
    defaultPriority: 2,
    recurrence: {
      version: 1,
      mode: 'after_completion',
      count: 1,
      unit: 'months',
      timeZone: 'America/Toronto',
    },
    assigneeId: null,
    priority: 2,
    deadlineDate: null,
    targetDate: null,
    reviewDate: null,
    ...(assetId ? { maintenance: { assetId, reference: 'https://example.com/manual' } } : {}),
  });
  const serviceArgs = (assetId: string, scopeId = shared) => ({
    recordId: randomUUID(),
    scopeId,
    assetId,
    occurredAt: Date.parse('2026-02-14T16:00:00Z'),
    notes: 'Annual service',
    costAmount: '123.4500',
    currency: 'CAD',
  });
  const complete = (args: { recordId: string; occurrenceId: string }) => ({
    recordId: args.occurrenceId,
    expectedRevision: active.tasks.get(a, args.occurrenceId).revision,
    expectedTaskRevision: active.tasks.get(a, args.recordId).revision,
    completionId: randomUUID(),
    nextOccurrenceId: randomUUID(),
    completedAt: Date.parse('2026-09-12T18:00:00Z'),
    performedByPersonId: b.personId,
    note: 'Washed and dried the filter',
  });
  const get = (id: string) => active.home.project(active.home.get(a, id));
  const cleanup = () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
  return {
    db,
    a,
    b,
    shared,
    privateScope,
    envelope,
    run,
    assetArgs,
    taskArgs,
    serviceArgs,
    complete,
    get,
    cleanup,
    services: () => active,
    reconnect: () => {
      active = services();
    },
    failCommit: () => {
      failCommit = true;
    },
  };
}

test('maintenance completion commits service log and recurrence together; replay and per-person undo preserve exact records', () => {
  const f = fixture();
  try {
    const asset = f.assetArgs();
    applied(f.run('CreateHomeAsset', asset));
    const task = f.taskArgs(asset.recordId);
    applied(f.run('CreateTask', task));
    const completion = f.complete(task),
      request = f.envelope(completion);
    const outcome = applied(f.services().writes.execute(f.a, 'CompleteTaskOccurrence', request));
    assert.equal(outcome.result.records.length, 5);
    const log = f.services().home.snapshot(f.a).serviceRecords[0]!;
    assert.equal(log.completionId, completion.completionId);
    assert.equal(log.occurredAt, completion.completedAt);
    assert.equal(log.notes, completion.note);
    const history = f.services().history.list<HomeRecord>(f.a, log.recordId, 'maintenance_record');
    assert.equal(history[0]!.changeSetId, outcome.changeSetId);
    assert.ok('personId' in history[0]!.actor);
    assert.equal(history[0]!.actor.personId, f.a.personId);
    assert.equal(
      f.services().tasks.get(f.a, completion.completionId).content.performedByPersonId,
      f.b.personId,
    );
    assert.equal(f.services().tasks.get(f.a, completion.nextOccurrenceId).content.targetDate, '2026-10-12');
    assert.equal(applied(f.services().writes.execute(f.a, 'CompleteTaskOccurrence', request)).replayed, true);
    assert.equal(f.services().home.snapshot(f.a).serviceRecords.length, 1);
    rejected(f.run('UndoChangeSet', { changeSetId: outcome.changeSetId }, f.b), 'unavailable');
    const undone = applied(f.run('UndoChangeSet', { changeSetId: outcome.changeSetId }));
    assert.notEqual(f.get(log.recordId).deletedAt, null);
    assert.equal(f.services().tasks.get(f.a, task.occurrenceId).content.state, 'open');
    applied(f.run('RedoChangeSet', { changeSetId: undone.changeSetId }));
    assert.equal(f.get(log.recordId).deletedAt, null);
    assert.equal(f.services().home.snapshot(f.a).serviceRecords.length, 1);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.cleanup();
  }
});

test('historical service does not complete a task; exact costs and edits participate in history and guard compound undo', () => {
  const f = fixture();
  try {
    const asset = f.assetArgs();
    applied(f.run('CreateHomeAsset', asset));
    const task = f.taskArgs(asset.recordId);
    applied(f.run('CreateTask', task));
    const manual = f.serviceArgs(asset.recordId);
    applied(f.run('CreateMaintenanceRecord', manual));
    assert.equal(f.services().tasks.get(f.a, task.occurrenceId).content.state, 'open');
    assert.equal(f.services().tasks.snapshot(f.a).completions.length, 0);
    const stored = f.get(manual.recordId);
    assert.equal(stored.kind, 'maintenance_record');
    if (stored.kind === 'maintenance_record') assert.equal(stored.costAmount, '123.4500');
    const completion = f.complete(task),
      finished = applied(f.run('CompleteTaskOccurrence', completion));
    const log = f
      .services()
      .home.snapshot(f.a)
      .serviceRecords.find((row) => row.completionId !== null)!;
    applied(
      f.run(
        'UpdateMaintenanceRecord',
        {
          recordId: log.recordId,
          expectedRevision: log.revision,
          occurredAt: log.occurredAt,
          notes: 'Added invoice information',
          costAmount: '123456789012.3456',
          currency: 'CAD',
        },
        f.b,
      ),
    );
    rejected(f.run('UndoChangeSet', { changeSetId: finished.changeSetId }), 'revision_conflict');
    rejected(
      f.run('UpdateMaintenanceRecord', {
        recordId: log.recordId,
        expectedRevision: 2,
        occurredAt: log.occurredAt + 1,
        notes: '',
        costAmount: null,
        currency: null,
      }),
      'completion_time_is_fixed',
    );
    rejected(
      f.run('DeleteMaintenanceRecord', { recordId: log.recordId, expectedRevision: 2 }),
      'use_completion_history_to_undo',
    );
    applied(f.run('DeleteMaintenanceRecord', { recordId: manual.recordId, expectedRevision: 1 }));
    applied(f.run('RestoreMaintenanceRecord', { recordId: manual.recordId, expectedRevision: 2 }));
  } finally {
    f.cleanup();
  }
});

test('maintenance visibility and same-scope SQL relationships protect assets, tasks, service records and history', () => {
  const f = fixture();
  try {
    const privateAsset = f.assetArgs(f.privateScope);
    applied(f.run('CreateHomeAsset', privateAsset));
    assert.equal(f.services().home.snapshot(f.b).assets.length, 0);
    assert.throws(() => f.services().home.get(f.b, privateAsset.recordId), NotFound);
    assert.throws(() => f.services().history.list(f.b, privateAsset.recordId, 'home_asset'), NotFound);
    rejected(f.run('CreateTask', f.taskArgs(privateAsset.recordId)), 'scope_mismatch');
    rejected(f.run('CreateMaintenanceRecord', f.serviceArgs(privateAsset.recordId)), 'scope_mismatch');
    rejected(
      f.run('CreateMaintenanceRecord', f.serviceArgs(privateAsset.recordId, f.privateScope), f.b),
      'unavailable',
    );
    const sharedTask = f.taskArgs(null);
    applied(f.run('CreateTask', sharedTask));
    assert.throws(
      () =>
        f.db
          .prepare('INSERT INTO maintenance_plans VALUES (?,?,?,?)')
          .run(sharedTask.recordId, f.shared, privateAsset.recordId, ''),
      /FOREIGN KEY/,
    );
    const service = f.serviceArgs(privateAsset.recordId, f.privateScope);
    applied(f.run('CreateMaintenanceRecord', service));
    assert.equal(f.services().home.snapshot(f.b).serviceRecords.length, 0);
  } finally {
    f.cleanup();
  }
});

test('archiving retains existing maintenance; stale links, dates, costs and active-child deletion are guarded', () => {
  const f = fixture();
  try {
    const asset = f.assetArgs();
    const created = applied(f.run('CreateHomeAsset', asset));
    const task = f.taskArgs(asset.recordId);
    applied(f.run('CreateTask', task));
    rejected(f.run('UndoChangeSet', { changeSetId: created.changeSetId }), 'asset_has_active_records');
    applied(f.run('SetHomeAssetArchived', { recordId: asset.recordId, expectedRevision: 1, archived: true }));
    rejected(f.run('CreateTask', f.taskArgs(asset.recordId)), 'asset_archived');
    rejected(
      f.run('DeleteHomeAsset', { recordId: asset.recordId, expectedRevision: 2 }),
      'asset_has_active_records',
    );
    applied(f.run('CompleteTaskOccurrence', f.complete(task)));
    rejected(
      f.run('CreateHomeAsset', { ...f.assetArgs(), acquiredDate: '2026-02-30' }),
      'invalid_calendar_date',
    );
    rejected(
      f.run('CreateMaintenanceRecord', { ...f.serviceArgs(asset.recordId), currency: null }),
      'cost_requires_currency',
    );
    rejected(
      f.run('CreateMaintenanceRecord', { ...f.serviceArgs(asset.recordId), costAmount: '1e3' }),
      'invalid_arguments',
    );
    const otherAsset = f.assetArgs();
    applied(f.run('CreateHomeAsset', otherAsset));
    const current = f.services().tasks.project(f.services().tasks.get(f.a, task.recordId)) as TaskDefinition;
    const update = {
      recordId: current.recordId,
      expectedRevision: current.revision,
      title: current.title,
      instructions: current.instructions,
      context: current.context,
      defaultAssigneeId: current.defaultAssigneeId,
      defaultPriority: current.defaultPriority,
      recurrence: current.recurrence,
      maintenance: { assetId: otherAsset.recordId, reference: '' },
    };
    const stale = f.complete({
      ...task,
      occurrenceId: f
        .services()
        .tasks.snapshot(f.a)
        .occurrences.find((o) => o.taskId === task.recordId && o.state === 'open')!.recordId,
    });
    applied(f.run('UpdateTaskDefinition', update));
    rejected(f.run('CompleteTaskOccurrence', stale), 'revision_conflict');
    const newId = f
      .services()
      .tasks.snapshot(f.a)
      .occurrences.find((o) => o.taskId === task.recordId && o.state === 'open')!.recordId;
    applied(f.run('CompleteTaskOccurrence', f.complete({ ...task, occurrenceId: newId })));
    assert.deepEqual(
      new Set(
        f
          .services()
          .home.snapshot(f.a)
          .serviceRecords.map((r) => r.assetId),
      ),
      new Set([asset.recordId, otherAsset.recordId]),
    );
  } finally {
    f.cleanup();
  }
});

test('commit failure rolls back completion, service record, next occurrence, history and receipt as one unit', () => {
  const f = fixture();
  try {
    const asset = f.assetArgs();
    applied(f.run('CreateHomeAsset', asset));
    const task = f.taskArgs(asset.recordId);
    applied(f.run('CreateTask', task));
    const tables = [
      'records',
      'task_occurrences',
      'task_completions',
      'maintenance_records',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const snapshot = () => tables.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    f.failCommit();
    assert.throws(() => f.run('CompleteTaskOccurrence', f.complete(task)), /injected failure/);
    assert.deepEqual(snapshot(), before);
  } finally {
    f.cleanup();
  }
});

test('Home migration preserves old task receipts, frozen commands, legacy history and household identity', () => {
  const source = mkdtempSync(join(tmpdir(), 'our-place-pre-home-'));
  for (const name of readdirSync(migrationsRoot).filter((name) => /^00[1-7]_/.test(name)))
    copyFileSync(join(migrationsRoot, name), join(source, name));
  const f = fixture(source);
  try {
    // Seed with today's writer, then restore the exact pre-planning schema and history.
    f.db.exec(
      'ALTER TABLE task_occurrences ADD COLUMN calendar_visible INTEGER NOT NULL DEFAULT 1; ALTER TABLE task_occurrences ADD COLUMN approximate_date TEXT',
    );
    const oldTask = f.taskArgs(null),
      oldRequest = f.envelope(oldTask);
    const created = applied(f.services().writes.execute(f.a, 'CreateTask', oldRequest));
    for (const row of f.db.prepare('SELECT change_set_id,record_id,delta_json FROM record_changes').all() as {
      change_set_id: string;
      record_id: string;
      delta_json: string;
    }[]) {
      const delta = JSON.parse(row.delta_json);
      if (delta.baseline) {
        delete delta.baseline.maintenance;
        delete delta.baseline.calendarVisible;
        delete delta.baseline.approximateDate;
      }
      f.db
        .prepare('UPDATE record_changes SET delta_json=? WHERE change_set_id=? AND record_id=?')
        .run(JSON.stringify(delta), row.change_set_id, row.record_id);
    }
    f.db.exec(
      'ALTER TABLE task_occurrences DROP COLUMN calendar_visible; ALTER TABLE task_occurrences DROP COLUMN approximate_date',
    );
    const pending = f.envelope(f.taskArgs(null));
    const names = [
      'installation_state',
      'people',
      'clients',
      'records',
      'tasks',
      'task_occurrences',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const selects = names.map(
      (name) =>
        `SELECT ${(f.db.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name).join(',')} FROM ${name}`,
    );
    const snapshot = () => selects.map((sql) => f.db.prepare(sql).all());
    const before = snapshot();
    migrate(f.db);
    f.reconnect();
    assert.deepEqual(snapshot(), before);
    assert.equal(applied(f.services().writes.execute(f.a, 'CreateTask', oldRequest)).replayed, true);
    applied(f.services().writes.execute(f.a, 'CreateTask', pending));
    assert.equal(f.services().history.list(f.a, oldTask.recordId, 'task')[0]!.canUndo, true);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: created.changeSetId }));
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.cleanup();
    rmSync(source, { recursive: true, force: true });
  }
});
