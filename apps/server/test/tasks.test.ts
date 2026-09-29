import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandKind, CommandOutcome, Envelope, TaskRecurrence, TaskRecord } from '@our-place/contracts';
import {
  initialiseInstallation,
  installation,
  migrate,
  openDatabase,
} from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { AccessService, type RequestContext } from '../src/features/access/access.js';
import { InboxRepository } from '../src/features/inbox/inbox.js';
import { inboxRecordAdapter } from '../src/features/inbox/inbox-record.js';
import { RecordRegistry } from '../src/features/records/record-registry.js';
import { ShoppingRepository } from '../src/features/shopping/shopping.js';
import { TasksRepository } from '../src/features/tasks/tasks.js';
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
function fixture(migrationsPath?: string) {
  const root = mkdtempSync(join(tmpdir(), 'our-place-tasks-')),
    db = openDatabase(join(root, 'test.sqlite'));
  migrate(db, migrationsPath);
  initialiseInstallation(db);
  const a: RequestContext = {
      personId: randomUUID(),
      clientId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    },
    b: RequestContext = {
      personId: randomUUID(),
      clientId: randomUUID(),
      credentialId: randomUUID(),
      kind: 'browser',
    };
  for (const [context, name] of [
    [a, 't'],
    [b, 'b'],
  ] as const) {
    db.prepare('INSERT INTO people(person_id,username,display_name,password_verifier) VALUES (?,?,?,?)').run(
      context.personId,
      name,
      name,
      'fixture',
    );
    db.prepare("INSERT INTO clients(client_id,person_id,kind) VALUES (?,?,'browser')").run(
      context.clientId,
      context.personId,
    );
    db.prepare("INSERT INTO visibility_scopes VALUES (?,'private',?)").run(randomUUID(), context.personId);
  }
  let clock = Date.parse('2026-09-26T15:00:00Z');
  const now = () => ++clock;
  const access = new AccessService(db, now),
    inbox = new InboxRepository(db, access),
    shopping = new ShoppingRepository(db, access),
    tasks = new TasksRepository(db, access);
  const records = new RecordRegistry(db, [
    inboxRecordAdapter(inbox),
    ...shopping.adapters(),
    ...(migrationsPath ? [] : tasks.adapters()),
  ]);
  const history = new HistoryService(db, records, access),
    writes = new WriteCoordinator(db, inbox, history, now, records, undefined, [
      shopping.commands(),
      tasks.commands(),
    ]);
  const shared = access.scopes(a).find((s) => s.kind === 'shared')!.scopeId,
    privateScope = access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown): Envelope => ({
    operationId: randomUUID(),
    contractVersion: 1,
    expectedServerEpoch: installation(db).recovery_epoch,
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, context = a) =>
    writes.execute(context, kind, envelope(args));
  const create = (recurrence: TaskRecurrence | null = null, scopeId = shared) => ({
    recordId: randomUUID(),
    occurrenceId: randomUUID(),
    scopeId,
    title: 'Replace filter',
    instructions: 'Use the compatible model',
    context: 'home' as const,
    defaultAssigneeId: null,
    defaultPriority: 1,
    recurrence,
    assigneeId: null,
    priority: 1,
    deadlineDate: null,
    targetDate: null,
    reviewDate: null,
  });
  const get = (id: string) => tasks.project(tasks.get(a, id));
  const complete = (taskId: string, occurrenceId: string) => {
    const task = get(taskId),
      occurrence = get(occurrenceId);
    assert.equal(task.kind, 'task');
    return {
      recordId: occurrenceId,
      expectedRevision: occurrence.revision,
      expectedTaskRevision: task.revision,
      completionId: randomUUID(),
      nextOccurrenceId: task.kind === 'task' && task.recurrence ? randomUUID() : null,
      completedAt: Date.parse('2026-09-10T00:30:00Z'),
      performedByPersonId: a.personId,
      note: 'Actually done earlier',
    };
  };
  return {
    db,
    root,
    a,
    b,
    now,
    access,
    inbox,
    shopping,
    tasks,
    records,
    history,
    writes,
    shared,
    privateScope,
    envelope,
    run,
    create,
    get,
    complete,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const monthly: TaskRecurrence = {
  version: 1,
  mode: 'after_completion',
  count: 1,
  unit: 'months',
  timeZone: 'America/Toronto',
};
test('actual completion drives recurrence and preserves attribution, rule and atomic history through undo/redo', () => {
  const f = fixture();
  try {
    const create = { ...f.create(monthly), occurrenceId: 'aaaaaaaa-occurrence' };
    applied(f.run('CreateTask', create));
    const args = {
      ...f.complete(create.recordId, create.occurrenceId),
      nextOccurrenceId: 'zzzzzzzz-occurrence',
      completedAt: Date.parse('2026-02-01T02:00:00Z'),
      performedByPersonId: f.b.personId,
    };
    const command = f.envelope(args),
      result = applied(f.writes.execute(f.a, 'CompleteTaskOccurrence', command));
    assert.equal(result.result.records.length, 4);
    const next = f.get(args.nextOccurrenceId!);
    assert.equal(next.kind, 'task_occurrence');
    if (next.kind === 'task_occurrence') assert.equal(next.targetDate, '2026-02-28');
    const completion = f.get(args.completionId);
    assert.equal(completion.kind, 'task_completion');
    if (completion.kind === 'task_completion') {
      assert.equal(completion.performerName, 'b');
      assert.equal(completion.completedAt, args.completedAt);
      assert.deepEqual(completion.recurrence, monthly);
      assert.equal(completion.ruleRevision, 1);
    }
    const entries = f.history.list<TaskRecord>(f.a, create.occurrenceId, 'task_occurrence');
    assert.equal(entries[0]!.actor.personId, f.a.personId);
    const undone = applied(f.run('UndoChangeSet', { changeSetId: result.changeSetId }));
    assert.equal((f.get(create.occurrenceId) as { state: string }).state, 'open');
    assert.notEqual(f.get(args.nextOccurrenceId!).deletedAt, null);
    assert.notEqual(f.get(args.completionId).deletedAt, null);
    applied(f.run('RedoChangeSet', { changeSetId: undone.changeSetId }));
    assert.equal(f.get(args.completionId).deletedAt, null);
    assert.deepEqual(applied(f.writes.execute(f.a, 'CompleteTaskOccurrence', command)), {
      ...result,
      replayed: true,
    });
  } finally {
    f.close();
  }
});
test('competing completions, partner changes to the next occurrence, and definition edits guard reversals', () => {
  const f = fixture();
  try {
    const create = f.create(monthly);
    applied(f.run('CreateTask', create));
    const args = f.complete(create.recordId, create.occurrenceId);
    const result = applied(f.run('CompleteTaskOccurrence', args));
    rejected(
      f.run(
        'CompleteTaskOccurrence',
        { ...args, completionId: randomUUID(), nextOccurrenceId: randomUUID() },
        f.b,
      ),
      'revision_conflict',
    );
    const next = f.get(args.nextOccurrenceId!);
    applied(
      f.run(
        'PostponeTaskOccurrence',
        { recordId: next.recordId, expectedRevision: next.revision, field: 'targetDate', date: '2026-11-01' },
        f.b,
      ),
    );
    rejected(f.run('UndoChangeSet', { changeSetId: result.changeSetId }), 'revision_conflict');
    rejected(f.run('UndoChangeSet', { changeSetId: result.changeSetId }, f.b), 'unavailable');
    const other = f.create(monthly);
    applied(f.run('CreateTask', other));
    const bought = applied(f.run('CompleteTaskOccurrence', f.complete(other.recordId, other.occurrenceId)));
    const task = f.get(other.recordId);
    assert.equal(task.kind, 'task');
    if (task.kind === 'task')
      applied(
        f.run('UpdateTaskDefinition', {
          recordId: task.recordId,
          expectedRevision: task.revision,
          title: 'New task instructions',
          instructions: task.instructions,
          context: task.context,
          defaultAssigneeId: null,
          defaultPriority: 2,
          recurrence: null,
        }),
      );
    rejected(f.run('UndoChangeSet', { changeSetId: bought.changeSetId }), 'revision_conflict');
  } finally {
    f.close();
  }
});
test('postponement leaves real deadlines intact; dates and private assignment are validated', () => {
  const f = fixture();
  try {
    const create = {
      ...f.create(),
      deadlineDate: '2026-09-28',
      targetDate: '2026-09-26',
      reviewDate: '2026-10-01',
    };
    applied(f.run('CreateTask', create));
    applied(
      f.run('PostponeTaskOccurrence', {
        recordId: create.occurrenceId,
        expectedRevision: 1,
        field: 'targetDate',
        date: '2026-10-03',
      }),
    );
    const item = f.get(create.occurrenceId);
    assert.equal(item.kind, 'task_occurrence');
    if (item.kind === 'task_occurrence') {
      assert.equal(item.deadlineDate, '2026-09-28');
      assert.equal(item.targetDate, '2026-10-03');
      assert.equal(item.reviewDate, '2026-10-01');
    }
    rejected(
      f.run('PostponeTaskOccurrence', {
        recordId: create.occurrenceId,
        expectedRevision: 2,
        field: 'targetDate',
        date: '2026-02-30',
      }),
      'invalid_calendar_date',
    );
    rejected(
      f.run('CreateTask', { ...f.create(null, f.privateScope), defaultAssigneeId: f.b.personId }),
      'private_task_requires_owner',
    );
    const privateTask = f.create(null, f.privateScope);
    applied(f.run('CreateTask', privateTask));
    assert.equal(
      f.tasks.snapshot(f.b).definitions.some((t) => t.recordId === privateTask.recordId),
      false,
    );
    assert.throws(() => f.history.list(f.b, privateTask.occurrenceId, 'task_occurrence'), NotFound);
    rejected(
      f.run('CompleteTaskOccurrence', {
        ...f.complete(privateTask.recordId, privateTask.occurrenceId),
        performedByPersonId: f.b.personId,
      }),
      'private_task_requires_owner',
    );
    rejected(
      f.run('CreateTask', { ...f.create(monthly), recurrence: { ...monthly, timeZone: 'wrong/zone' } }),
      'invalid_time_zone',
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    f.close();
  }
});
test('task deletion/restoration preserves dates, and undo creation closes the unique open slot', () => {
  const f = fixture();
  try {
    const create = { ...f.create(monthly), targetDate: '2026-10-01' };
    const created = applied(f.run('CreateTask', create));
    const deleted = applied(
      f.run('DeleteTask', {
        recordId: create.recordId,
        expectedRevision: 1,
        occurrence: { recordId: create.occurrenceId, expectedRevision: 1 },
      }),
    );
    assert.notEqual(f.get(create.occurrenceId).deletedAt, null);
    applied(
      f.run('RestoreTask', {
        recordId: create.recordId,
        expectedRevision: 2,
        occurrence: { recordId: create.occurrenceId, expectedRevision: 2 },
      }),
    );
    const item = f.get(create.occurrenceId);
    if (item.kind === 'task_occurrence') {
      assert.equal(item.state, 'open');
      assert.equal(item.targetDate, '2026-10-01');
    }
    rejected(f.run('UndoChangeSet', { changeSetId: deleted.changeSetId }), 'revision_conflict');
    rejected(f.run('UndoChangeSet', { changeSetId: created.changeSetId }), 'revision_conflict');
    const fresh = f.create();
    const added = applied(f.run('CreateTask', fresh));
    const undone = applied(f.run('UndoChangeSet', { changeSetId: added.changeSetId }));
    assert.equal((f.get(fresh.occurrenceId) as { state: string }).state, 'cancelled');
    applied(f.run('RedoChangeSet', { changeSetId: undone.changeSetId }));
    assert.equal((f.get(fresh.occurrenceId) as { state: string }).state, 'open');
  } finally {
    f.close();
  }
});
test('failed commit rolls back task completion, next occurrence, history and receipt', () => {
  const f = fixture();
  try {
    const create = f.create(monthly);
    applied(f.run('CreateTask', create));
    const args = f.complete(create.recordId, create.occurrenceId),
      command = f.envelope(args);
    const failure = new WriteCoordinator(
      f.db,
      f.inbox,
      f.history,
      f.now,
      f.records,
      () => {
        throw new Error('injected commit failure');
      },
      [f.tasks.commands()],
    );
    const before = f.tasks.snapshot(f.a);
    assert.throws(() => failure.execute(f.a, 'CompleteTaskOccurrence', command), /injected/);
    assert.deepEqual(f.tasks.snapshot(f.a), before);
    assert.equal(
      f.writes.resolve(f.a, command.operationId, command.expectedServerEpoch).status,
      'Unresolved',
    );
    applied(f.writes.execute(f.a, 'CompleteTaskOccurrence', command));
  } finally {
    f.close();
  }
});
test('task migration preserves existing shopping purchases, receipts and history', () => {
  const path = mkdtempSync(join(tmpdir(), 'our-place-before-tasks-'));
  for (const file of [
    '001_foundation.sql',
    '002_operations.sql',
    '003_capture_categories.sql',
    '004_shopping.sql',
  ])
    copyFileSync(join(migrationsRoot, file), join(path, file));
  const f = fixture(path);
  try {
    const listId = randomUUID(),
      entryId = randomUUID();
    // Seed the historical list shape; current list writes include migration 032's notes.
    f.db
      .prepare("INSERT INTO records VALUES (?,'shopping_list',?,1,?,?,NULL)")
      .run(listId, f.shared, f.now(), f.now());
    f.db
      .prepare('INSERT INTO shopping_lists VALUES (?,?,?,?,?)')
      .run(listId, 'shopping_list', f.shared, 'Keep this list', 'household');
    applied(
      f.run('AddShoppingEntry', {
        recordId: entryId,
        listId,
        label: 'Keep this purchase',
        quantity: '2',
        notes: '',
      }),
    );
    const command = f.envelope({
      recordId: entryId,
      expectedRevision: 1,
      purchaseId: randomUUID(),
      purchaseItemId: randomUUID(),
      boughtAt: f.now(),
    });
    const bought = applied(f.writes.execute(f.a, 'PurchaseShoppingEntry', command));
    // Read the old schema directly: current history queries require migration 007.
    const historySelects = ['change_sets', 'record_changes'].map((table) => {
      const columns = f.db.pragma(`table_info(${table})`) as { name: string }[];
      return `SELECT ${columns.map((column) => column.name).join(',')} FROM ${table} ORDER BY rowid`;
    });
    const before = {
      identity: installation(f.db),
      shopping: f.shopping.snapshot(f.a),
      history: historySelects.map((sql) => f.db.prepare(sql).all()),
    };
    migrate(f.db);
    assert.deepEqual(
      {
        identity: installation(f.db),
        shopping: f.shopping.snapshot(f.a),
        history: historySelects.map((sql) => f.db.prepare(sql).all()),
      },
      before,
    );
    assert.equal(f.history.list(f.a, entryId, 'shopping_entry')[0]?.actor.personId, f.a.personId);
    assert.deepEqual(applied(f.writes.execute(f.a, 'PurchaseShoppingEntry', command)), {
      ...bought,
      replayed: true,
    });
  } finally {
    f.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test('private tasks default to their owner through creation and recurrence; shared tasks stay unassigned', () => {
  const f = fixture();
  try {
    const args = f.create(monthly, f.privateScope);
    applied(f.run('CreateTask', args));
    assert.equal(f.tasks.get(f.a, args.recordId).content.defaultAssigneeId, f.a.personId);
    assert.equal(f.tasks.get(f.a, args.occurrenceId).content.assigneeId, f.a.personId);
    const completion = f.complete(args.recordId, args.occurrenceId);
    applied(f.run('CompleteTaskOccurrence', completion));
    assert.equal(f.tasks.get(f.a, completion.nextOccurrenceId!).content.assigneeId, f.a.personId);
    const shared = f.create();
    applied(f.run('CreateTask', shared));
    assert.equal(f.tasks.get(f.a, shared.recordId).content.defaultAssigneeId, null);
    assert.equal(f.tasks.get(f.a, shared.occurrenceId).content.assigneeId, null);
  } finally {
    f.close();
  }
});

test('approximate planning, calendar visibility and legacy requests survive undo and recurrence', () => {
  const f = fixture();
  try {
    const create = { ...f.create(monthly), approximateDate: 'week', calendarVisible: false };
    applied(f.run('CreateTask', create));
    const first = f.get(create.occurrenceId);
    assert.equal(first.kind, 'task_occurrence');
    if (first.kind !== 'task_occurrence') throw new Error();
    assert.equal(first.approximateDate, 'week');
    assert.equal(first.calendarVisible, false);
    const edited = applied(
      f.run('UpdateTaskOccurrence', {
        recordId: first.recordId,
        expectedRevision: first.revision,
        assigneeId: null,
        priority: 2,
        deadlineDate: null,
        targetDate: null,
        reviewDate: null,
      }),
    );
    assert.equal((f.get(first.recordId) as typeof first).approximateDate, 'week');
    assert.equal((f.get(first.recordId) as typeof first).calendarVisible, false);
    applied(f.run('UndoChangeSet', { changeSetId: edited.changeSetId }));
    const current = f.get(first.recordId);
    const moved = applied(
      f.run('PostponeTaskOccurrence', {
        recordId: first.recordId,
        expectedRevision: current.revision,
        field: 'targetDate',
        date: '2026-10-01',
      }),
    );
    assert.equal((f.get(first.recordId) as typeof first).approximateDate, null);
    applied(f.run('UndoChangeSet', { changeSetId: moved.changeSetId }));
    assert.equal((f.get(first.recordId) as typeof first).approximateDate, 'week');
    const complete = f.complete(create.recordId, create.occurrenceId);
    applied(f.run('CompleteTaskOccurrence', complete));
    const next = f.get(complete.nextOccurrenceId!);
    assert.equal(next.kind, 'task_occurrence');
    if (next.kind === 'task_occurrence') {
      assert.equal(next.calendarVisible, false);
      assert.equal(next.approximateDate, null);
      assert.ok(next.targetDate);
    }
  } finally {
    f.close();
  }
});
