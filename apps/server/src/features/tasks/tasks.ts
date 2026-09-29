import {
  addCalendarDate,
  calendarDateAt,
  emptyTasks,
  isCalendarDate,
  isTimeZone,
  isValid,
  taskCommands,
  taskContentSchemas,
  type Command,
  type TaskKind,
  type TaskRecord,
  type TaskDefinition,
  type TaskOccurrence,
  type TaskCompletion,
  type TaskRecurrence,
  type TaskSnapshot,
  type Attachment,
  type MaintenancePlan,
  type CookingPlan,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AccessService, requireHuman, type HumanRequestContext as RequestContext } from '../access/access.js';
import type {
  RecordAdapter,
  RecordContent,
  TrackedRecord,
  RecordChange,
} from '../records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import { AttachmentRepository } from '../media/attachments.js';
import { HomeRepository } from '../home/home.js';
import { RecipesRepository } from '../recipes/recipes.js';
type TaskCommandKind = keyof typeof taskCommands;
const tables: Record<TaskKind, [string, string]> = {
  task: ['tasks', 'task_id'],
  task_occurrence: ['task_occurrences', 'occurrence_id'],
  task_completion: ['task_completions', 'completion_id'],
};
type Header = {
  record_id: string;
  kind: TaskKind;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
export class TasksRepository {
  private readonly attachments: AttachmentRepository;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
    private readonly timeZone = 'America/Toronto',
    private readonly home?: HomeRepository,
    private readonly recipes?: RecipesRepository,
  ) {
    if (!isTimeZone(timeZone)) throw new Error('Invalid household timezone');
    this.attachments = new AttachmentRepository(db, access);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(taskCommands) as TaskCommandKind[],
      execute: (context, kind, payload, now) => this.execute(context, kind as TaskCommandKind, payload, now),
    };
  }
  adapters(): RecordAdapter[] {
    return (Object.keys(tables) as TaskKind[]).map((kind) => ({
      kind,
      supportsAttachments: kind !== 'task_occurrence',
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      get: (context, id) => this.get(context, id, kind),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(kind, value),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now),
      reversalOrder: (_before, content) =>
        content.deletedAt !== null || (kind === 'task_occurrence' && content.state !== 'open') ? -1 : 0,
      ...(kind === 'task' ? { assertConsistent: () => this.assertConsistent() } : {}),
    }));
  }
  private content(kind: TaskKind, value: unknown): RecordContent {
    if (!isValid(taskContentSchemas[kind], value)) throw new Error('Invalid task history content');
    const c = value as RecordContent;
    if (kind === 'task' && !String(c.title).trim()) throw new Rejection('title_required');
    for (const field of ['deadlineDate', 'targetDate', 'reviewDate'])
      if (c[field] !== undefined && c[field] !== null && !isCalendarDate(String(c[field])))
        throw new Rejection('invalid_calendar_date');
    const rule = c.recurrence as TaskRecurrence | null | undefined;
    if (rule && !isTimeZone(rule.timeZone)) throw new Rejection('invalid_time_zone');
    return kind === 'task_occurrence'
      ? c
      : {
          ...c,
          attachments: c.attachments ?? [],
          ...(kind === 'task' ? { maintenance: c.maintenance ?? null, cooking: c.cooking ?? null } : {}),
        };
  }
  get(context: RequestContext, id: string, expectedKind?: TaskKind): TrackedRecord {
    requireHuman(context);
    const row = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as Header | undefined;
    if (
      !row ||
      !Object.hasOwn(tables, row.kind) ||
      (expectedKind && row.kind !== expectedKind) ||
      !this.access.canAccess(context, row.scope_id)
    )
      throw new NotFound();
    const [table, key] = tables[row.kind],
      data = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    if (!data) throw new Error('Task payload missing');
    let fields: Record<string, unknown>;
    if (row.kind === 'task') {
      const rule = this.db
        .prepare(
          'SELECT version,mode,interval_count AS count,interval_unit AS unit,time_zone AS timeZone FROM task_recurrences WHERE task_id=?',
        )
        .get(id);
      fields = {
        title: data.title,
        instructions: data.instructions,
        context: data.context,
        defaultAssigneeId: data.default_assignee_id,
        defaultPriority: data.default_priority,
        recurrence: rule ?? null,
        maintenance: this.home?.taskPlan(id) ?? null,
        cooking: this.recipes?.taskPlan(id) ?? null,
      };
    } else if (row.kind === 'task_occurrence')
      fields = {
        taskId: data.task_id,
        ordinal: data.ordinal,
        state: data.state,
        assigneeId: data.assignee_id,
        priority: data.priority,
        deadlineDate: data.deadline_date,
        targetDate: data.target_date,
        reviewDate: data.review_date,
      };
    else
      fields = {
        occurrenceId: data.occurrence_id,
        completedAt: data.completed_at,
        performedByPersonId: data.performed_by_person_id,
        performerName: data.performer_name,
        note: data.note,
        ruleRevision: data.rule_revision,
        recurrence: data.recurrence_json ? JSON.parse(String(data.recurrence_json)) : null,
        nextOccurrenceId: data.next_occurrence_id,
      };
    return {
      recordId: id,
      kind: row.kind,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: this.content(row.kind, {
        scopeId: row.scope_id,
        deletedAt: row.deleted_at,
        ...fields,
        ...(row.kind === 'task_occurrence' ? {} : { attachments: this.attachments.list(id) }),
      }),
    };
  }
  project(record: TrackedRecord): TaskRecord {
    const { recordId, kind, revision, createdAt, updatedAt } = record;
    return {
      recordId,
      kind,
      revision,
      createdAt,
      updatedAt,
      ...this.content(kind as TaskKind, record.content),
    } as TaskRecord;
  }
  snapshot(context: RequestContext): TaskSnapshot {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind IN ('task','task_occurrence','task_completion') AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at,r.record_id LIMIT 4001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 4000) throw new Rejection('cache_capacity_exceeded');
    const snapshot = emptyTasks();
    snapshot.timeZone = this.timeZone;
    snapshot.people = this.db
      .prepare(
        'SELECT person_id AS personId,display_name AS displayName FROM people ORDER BY display_name,person_id',
      )
      .all() as TaskSnapshot['people'];
    for (const row of rows) {
      const record = this.project(this.get(context, row.record_id));
      switch (record.kind) {
        case 'task':
          snapshot.definitions.push(record);
          break;
        case 'task_occurrence':
          snapshot.occurrences.push(record);
          break;
        case 'task_completion':
          snapshot.completions.push(record);
          break;
      }
    }
    return snapshot;
  }
  private require(context: RequestContext, id: string, kind: TaskKind, revision?: number): TrackedRecord {
    let record: TrackedRecord;
    try {
      record = this.get(context, id, kind);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (revision !== undefined && record.revision !== revision) throw new Rejection('revision_conflict');
    return record;
  }
  private live(record: TrackedRecord): TrackedRecord {
    if (record.content.deletedAt !== null) throw new Rejection('deleted');
    return record;
  }
  private defaultAssignee(scopeId: string, personId: string | null): string | null {
    if (personId !== null) return personId;
    const row = this.db
      .prepare("SELECT owner_person_id FROM visibility_scopes WHERE scope_id=? AND kind='private'")
      .get(scopeId) as { owner_person_id: string } | undefined;
    return row?.owner_person_id ?? null;
  }
  private person(context: RequestContext, scopeId: string, personId: string | null): void {
    this.access.requireScope(context, scopeId);
    if (personId === null) return;
    const scope = this.db
      .prepare('SELECT kind,owner_person_id FROM visibility_scopes WHERE scope_id=?')
      .get(scopeId) as { kind: string; owner_person_id: string | null };
    if (scope.kind === 'private' && scope.owner_person_id !== personId)
      throw new Rejection('private_task_requires_owner');
    if (!this.db.prepare('SELECT 1 FROM people WHERE person_id=?').get(personId))
      throw new Rejection('person_unavailable');
  }
  private checkReferences(context: RequestContext, kind: TaskKind, id: string, c: RecordContent): void {
    if (kind === 'task') {
      this.person(context, c.scopeId, c.defaultAssigneeId as string | null);
      const plan = (c.maintenance ?? null) as MaintenancePlan | null;
      if (plan && !this.home) throw new Rejection('maintenance_unavailable');
      this.home?.validateTaskPlan(context, c.scopeId, plan, this.home.taskPlan(id));
      const cooking = (c.cooking ?? null) as CookingPlan | null;
      if (cooking && plan) throw new Rejection('task_has_multiple_completion_plans');
      if (cooking && !this.recipes) throw new Rejection('recipes_unavailable');
      this.recipes?.validateTaskPlan(context, c.scopeId, cooking, this.recipes.taskPlan(id));
    } else if (kind === 'task_occurrence') {
      this.person(context, c.scopeId, c.assigneeId as string | null);
      const task = this.require(context, String(c.taskId), 'task');
      if (task.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
      if (
        c.state === 'open' &&
        c.deletedAt === null &&
        this.db
          .prepare(
            "SELECT 1 FROM task_occurrences WHERE task_id=? AND occurrence_id<>? AND state='open' AND is_live=1",
          )
          .get(c.taskId, id)
      )
        throw new Rejection('task_already_open');
    } else {
      this.person(context, c.scopeId, String(c.performedByPersonId));
      const occurrence = this.require(context, String(c.occurrenceId), 'task_occurrence');
      if (occurrence.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
      if (c.nextOccurrenceId) {
        const next = this.require(context, String(c.nextOccurrenceId), 'task_occurrence');
        if (next.content.taskId !== occurrence.content.taskId)
          throw new Rejection('occurrence_dependency_changed');
      }
      if (
        c.deletedAt === null &&
        this.db
          .prepare('SELECT 1 FROM task_completions WHERE occurrence_id=? AND completion_id<>? AND is_live=1')
          .get(c.occurrenceId, id)
      )
        throw new Rejection('occurrence_already_completed');
    }
  }
  private saveRecurrence(id: string, rule: TaskRecurrence | null): void {
    if (!rule) this.db.prepare('DELETE FROM task_recurrences WHERE task_id=?').run(id);
    else
      this.db
        .prepare(
          `INSERT INTO task_recurrences VALUES (?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,mode=excluded.mode,interval_count=excluded.interval_count,interval_unit=excluded.interval_unit,time_zone=excluded.time_zone`,
        )
        .run(id, rule.version, rule.mode, rule.count, rule.unit, rule.timeZone);
  }
  private create(
    context: RequestContext,
    kind: TaskKind,
    id: string,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(kind, value);
    if (kind === 'task')
      c.defaultAssigneeId = this.defaultAssignee(c.scopeId, c.defaultAssigneeId as string | null);
    if (kind === 'task_occurrence')
      c.assigneeId = this.defaultAssignee(c.scopeId, c.assigneeId as string | null);
    this.access.requireScope(context, c.scopeId);
    this.checkReferences(context, kind, id, c);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    if (kind === 'task') {
      this.db
        .prepare("INSERT INTO tasks VALUES (?,'task',?,?,?,?,?,?)")
        .run(id, c.scopeId, c.title, c.instructions, c.context, c.defaultAssigneeId, c.defaultPriority);
      this.saveRecurrence(id, c.recurrence as TaskRecurrence | null);
      this.home?.saveTaskPlan(id, c.scopeId, c.maintenance as MaintenancePlan | null);
      this.recipes?.saveTaskPlan(id, c.scopeId, c.cooking as CookingPlan | null);
    } else if (kind === 'task_occurrence')
      this.db
        .prepare("INSERT INTO task_occurrences VALUES (?,'task_occurrence',?,?,?,?,?,?,?,?,?,1)")
        .run(
          id,
          c.scopeId,
          c.taskId,
          c.ordinal,
          c.state,
          c.assigneeId,
          c.priority,
          c.deadlineDate,
          c.targetDate,
          c.reviewDate,
        );
    else
      this.db
        .prepare("INSERT INTO task_completions VALUES (?,'task_completion',?,?,?,?,?,?,?,?,?,1)")
        .run(
          id,
          c.scopeId,
          c.occurrenceId,
          c.completedAt,
          c.performedByPersonId,
          c.performerName,
          c.note,
          c.ruleRevision,
          c.recurrence ? JSON.stringify(c.recurrence) : null,
          c.nextOccurrenceId,
        );
    if (kind !== 'task_occurrence')
      this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
        creating: true,
        live: true,
      });
    return this.get(context, id, kind);
  }
  private setContent(
    context: RequestContext,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    requireHuman(context);
    let c = this.content(before.kind as TaskKind, value);
    const id = before.recordId;
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    // Undoing creation retires an open occurrence, so its unique slot is genuinely closed.
    if (before.kind === 'task_occurrence' && c.deletedAt !== null && c.state === 'open')
      c = { ...c, state: 'cancelled' };
    this.checkReferences(context, before.kind as TaskKind, id, c);
    if (before.kind === 'task') {
      this.db
        .prepare(
          'UPDATE tasks SET title=?,instructions=?,context=?,default_assignee_id=?,default_priority=? WHERE task_id=?',
        )
        .run(c.title, c.instructions, c.context, c.defaultAssigneeId, c.defaultPriority, id);
      this.saveRecurrence(id, c.recurrence as TaskRecurrence | null);
      this.home?.saveTaskPlan(id, c.scopeId, c.maintenance as MaintenancePlan | null);
      this.recipes?.saveTaskPlan(id, c.scopeId, c.cooking as CookingPlan | null);
    } else if (before.kind === 'task_occurrence') {
      if (c.taskId !== before.content.taskId || c.ordinal !== before.content.ordinal)
        throw new Error('Occurrence identity cannot change');
      this.db
        .prepare(
          'UPDATE task_occurrences SET state=?,assignee_id=?,priority=?,deadline_date=?,target_date=?,review_date=? WHERE occurrence_id=?',
        )
        .run(c.state, c.assigneeId, c.priority, c.deadlineDate, c.targetDate, c.reviewDate, id);
    } else {
      const { deletedAt: _old, attachments: _oldAttachments, ...old } = before.content,
        { deletedAt: _next, attachments: _nextAttachments, ...next } = c;
      if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('Completion snapshots are immutable');
    }
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, id);
    if (before.kind !== 'task_occurrence')
      this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
        live: c.deletedAt === null,
      });
    return this.get(context, id);
  }
  private ordinal(taskId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM task_occurrences WHERE task_id=?')
        .get(taskId) as { n: number }
    ).n;
  }
  execute(context: RequestContext, kind: TaskCommandKind, payload: unknown, now: number): RecordMutation {
    requireHuman(context);
    const changes: RecordChange[] = [];
    const create = (type: TaskKind, id: string, c: RecordContent) => {
      const after = this.create(context, type, id, c, now);
      changes.push({ before: null, after });
      return after;
    };
    const change = (before: TrackedRecord, c: RecordContent) => {
      const after = this.setContent(context, before, c, now);
      changes.push({ before, after });
      return after;
    };
    const result = () => ({ records: changes.map((change) => change.after), changes });
    if (kind === 'CreateTask') {
      const a = payload as Command<'CreateTask'>['arguments'];
      create('task', a.recordId, {
        scopeId: a.scopeId,
        deletedAt: null,
        title: a.title,
        instructions: a.instructions,
        context: a.context,
        defaultAssigneeId: a.defaultAssigneeId,
        defaultPriority: a.defaultPriority,
        recurrence: a.recurrence,
        maintenance: a.maintenance ?? null,
        cooking: a.cooking ?? null,
      });
      create('task_occurrence', a.occurrenceId, {
        scopeId: a.scopeId,
        deletedAt: null,
        taskId: a.recordId,
        ordinal: 1,
        state: 'open',
        assigneeId: a.assigneeId,
        priority: a.priority,
        deadlineDate: a.deadlineDate,
        targetDate: a.targetDate,
        reviewDate: a.reviewDate,
      });
      return result();
    }
    const a = payload as Command<'UpdateTaskDefinition'>['arguments'];
    const definitionKind = ['UpdateTaskDefinition', 'DeleteTask', 'RestoreTask'].includes(kind);
    const before = this.require(
      context,
      a.recordId,
      definitionKind ? 'task' : 'task_occurrence',
      a.expectedRevision,
    );
    if (kind === 'DeleteTask' || kind === 'RestoreTask') {
      const args = payload as Command<'DeleteTask'>['arguments'],
        deleting = kind === 'DeleteTask';
      if (deleting === (before.content.deletedAt !== null))
        throw new Rejection(deleting ? 'already_deleted' : 'not_deleted');
      const row = this.db
        .prepare(
          `SELECT r.record_id,r.revision FROM task_occurrences o JOIN records r ON r.record_id=o.occurrence_id WHERE o.task_id=? AND ${deleting ? "o.state='open' AND r.deleted_at IS NULL" : "o.state='cancelled' AND r.deleted_at=?"}`,
        )
        .get(...(deleting ? [a.recordId] : [a.recordId, before.content.deletedAt])) as
        { record_id: string; revision: number } | undefined;
      if (
        !!row !== !!args.occurrence ||
        (row &&
          (row.record_id !== args.occurrence!.recordId || row.revision !== args.occurrence!.expectedRevision))
      )
        throw new Rejection('occurrence_dependency_changed');
      change(before, { ...before.content, deletedAt: deleting ? now : null });
      if (row) {
        const occurrence = this.get(context, row.record_id, 'task_occurrence');
        change(occurrence, {
          ...occurrence.content,
          state: deleting ? 'cancelled' : 'open',
          deletedAt: deleting ? now : null,
        });
      }
      return result();
    }
    this.live(before);
    if (kind === 'UpdateTaskDefinition') {
      const { recordId: _id, expectedRevision: _revision, ...fields } = a;
      fields.defaultAssigneeId = this.defaultAssignee(before.content.scopeId, fields.defaultAssigneeId);
      change(before, { ...before.content, ...fields });
      return result();
    }
    const occurrence = this.project(before) as TaskOccurrence;
    const task = this.live(this.require(context, occurrence.taskId, 'task'));
    if (occurrence.state !== 'open') throw new Rejection('occurrence_not_open');
    if (kind === 'PostponeTaskOccurrence') {
      const args = payload as Command<'PostponeTaskOccurrence'>['arguments'];
      change(before, { ...before.content, [args.field]: args.date });
      return result();
    }
    if (kind === 'UpdateTaskOccurrence') {
      const {
        recordId: _id,
        expectedRevision: _revision,
        ...fields
      } = payload as Command<'UpdateTaskOccurrence'>['arguments'];
      fields.assigneeId = this.defaultAssignee(before.content.scopeId, fields.assigneeId);
      change(before, { ...before.content, ...fields });
      return result();
    }
    if (kind !== 'CompleteTaskOccurrence') throw new Error('Unsupported task command');
    const args = payload as Command<'CompleteTaskOccurrence'>['arguments'];
    if (task.revision !== args.expectedTaskRevision) throw new Rejection('revision_conflict');
    if (args.completedAt > now + 300000) throw new Rejection('completion_in_future');
    const definition = this.project(task) as TaskDefinition,
      rule = definition.recurrence;
    if (!!rule !== !!args.nextOccurrenceId) throw new Rejection('next_occurrence_required_for_recurrence');
    this.person(context, occurrence.scopeId, args.performedByPersonId);
    let nextDate: string | null = null;
    if (rule)
      try {
        nextDate = addCalendarDate(calendarDateAt(args.completedAt, rule.timeZone), rule.count, rule.unit);
      } catch {
        throw new Rejection('invalid_recurrence_date');
      }
    // A completion changes this task's aggregate history; its revision also guards later reversal.
    change(task, { ...task.content });
    change(before, { ...before.content, state: 'completed' });
    if (args.nextOccurrenceId)
      create('task_occurrence', args.nextOccurrenceId, {
        scopeId: occurrence.scopeId,
        deletedAt: null,
        taskId: task.recordId,
        ordinal: this.ordinal(task.recordId),
        state: 'open',
        assigneeId: definition.defaultAssigneeId,
        priority: definition.defaultPriority,
        deadlineDate: null,
        targetDate: nextDate,
        reviewDate: null,
      });
    const person = this.db
      .prepare('SELECT display_name FROM people WHERE person_id=?')
      .get(args.performedByPersonId) as { display_name: string };
    const completion = create('task_completion', args.completionId, {
      scopeId: occurrence.scopeId,
      deletedAt: null,
      occurrenceId: before.recordId,
      completedAt: args.completedAt,
      performedByPersonId: args.performedByPersonId,
      performerName: person.display_name,
      note: args.note,
      ruleRevision: task.revision,
      recurrence: rule,
      nextOccurrenceId: args.nextOccurrenceId,
    });
    if (definition.maintenance) {
      if (!this.home) throw new Rejection('maintenance_unavailable');
      changes.push(
        this.home.recordCompletion(
          context,
          definition.maintenance,
          this.project(completion) as TaskCompletion,
          now,
        ),
      );
    }
    if (definition.cooking) {
      if (!this.recipes) throw new Rejection('recipes_unavailable');
      changes.push(
        this.recipes.recordCompletion(
          context,
          definition.cooking,
          this.project(completion) as TaskCompletion,
          now,
        ),
      );
    }
    return result();
  }
  private assertConsistent(): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM task_occurrences o JOIN records t ON t.record_id=o.task_id WHERE o.is_live=1 AND o.state='open' AND t.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('task_has_open_occurrence');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM task_occurrences o WHERE (SELECT count(*) FROM task_completions c WHERE c.occurrence_id=o.occurrence_id AND c.is_live=1) <> CASE WHEN o.state='completed' THEN 1 ELSE 0 END LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('completion_dependency_changed');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM task_completions c JOIN task_occurrences o ON o.occurrence_id=c.occurrence_id JOIN task_occurrences n ON n.occurrence_id=c.next_occurrence_id WHERE n.task_id<>o.task_id OR n.ordinal<=o.ordinal LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('occurrence_dependency_changed');
    for (const [table, key] of [tables.task_occurrence, tables.task_completion])
      if (
        this.db
          .prepare(
            `SELECT 1 FROM ${table} p JOIN records r ON r.record_id=p.${key} WHERE p.is_live<>(r.deleted_at IS NULL) LIMIT 1`,
          )
          .get()
      )
        throw new Error('Task live-index invariant failed');
  }
}
