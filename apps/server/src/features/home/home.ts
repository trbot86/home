import { randomUUID } from 'node:crypto';
import {
  emptyHome,
  homeCommands,
  homeContentSchemas,
  isCalendarDate,
  isValid,
  type Attachment,
  type Command,
  type HomeKind,
  type HomeRecord,
  type HomeSnapshot,
  type MaintenancePlan,
  type TaskCompletion,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AccessService, requireHuman, type HumanRequestContext as RequestContext } from '../access/access.js';
import type {
  RecordAdapter,
  RecordChange,
  RecordContent,
  TrackedRecord,
} from '../records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import { AttachmentRepository } from '../media/attachments.js';

type HomeCommandKind = keyof typeof homeCommands;
const tables: Record<HomeKind, [string, string]> = {
  home_asset: ['home_assets', 'asset_id'],
  maintenance_record: ['maintenance_records', 'maintenance_record_id'],
};
type Header = {
  record_id: string;
  kind: HomeKind;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

/** Owns assets, service records and the task-owned maintenance relation; no separate scheduler. */
export class HomeRepository {
  private readonly attachments: AttachmentRepository;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.attachments = new AttachmentRepository(db, access);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(homeCommands) as HomeCommandKind[],
      execute: (context, kind, payload, now) => this.execute(context, kind as HomeCommandKind, payload, now),
    };
  }
  adapters(): RecordAdapter[] {
    return (Object.keys(tables) as HomeKind[]).map((kind) => ({
      kind,
      supportsAttachments: true,
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      get: (context, id) => this.get(context, id, kind),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(kind, value),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now),
      // Retire service rows before parents; restore their parents before service rows.
      reversalOrder: (_before, content) =>
        kind === 'maintenance_record'
          ? content.deletedAt === null
            ? 2
            : -2
          : content.deletedAt === null
            ? -3
            : 3,
      ...(kind === 'home_asset' ? { assertConsistent: () => this.assertConsistent() } : {}),
    }));
  }
  private content(kind: HomeKind, value: unknown): RecordContent {
    if (!isValid(homeContentSchemas[kind], value)) throw new Error('Invalid home history content');
    const c = value as RecordContent;
    if (kind === 'home_asset') {
      if (!String(c.name).trim()) throw new Rejection('name_required');
      if (c.acquiredDate !== null && !isCalendarDate(String(c.acquiredDate)))
        throw new Rejection('invalid_calendar_date');
    } else if ((c.costAmount === null) !== (c.currency === null))
      throw new Rejection('cost_requires_currency');
    return c;
  }
  get(context: RequestContext, id: string, expectedKind?: HomeKind): TrackedRecord {
    requireHuman(context);
    const row = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as Header | undefined;
    if (
      !row ||
      !Object.hasOwn(tables, row.kind) ||
      (expectedKind && row.kind !== expectedKind) ||
      !this.access.canAccess(context, row.scope_id)
    )
      throw new NotFound();
    const [table, key] = tables[row.kind];
    const data = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    if (!data) throw new Error('Home payload missing');
    const fields =
      row.kind === 'home_asset'
        ? {
            name: data.name,
            model: data.model,
            serial: data.serial,
            location: data.location,
            acquiredDate: data.acquired_date,
            notes: data.notes,
            archived: data.archived === 1,
          }
        : {
            assetId: data.asset_id,
            completionId: data.completion_id,
            occurredAt: data.occurred_at,
            notes: data.notes,
            costAmount: data.cost_amount,
            currency: data.currency,
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
        attachments: this.attachments.list(id),
        ...fields,
      }),
    };
  }
  project(record: TrackedRecord): HomeRecord {
    const { recordId, kind, revision, createdAt, updatedAt } = record;
    return {
      recordId,
      kind,
      revision,
      createdAt,
      updatedAt,
      ...this.content(kind as HomeKind, record.content),
    } as HomeRecord;
  }
  snapshot(context: RequestContext): HomeSnapshot {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind IN ('home_asset','maintenance_record') AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at,r.record_id LIMIT 4001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 4000) throw new Rejection('cache_capacity_exceeded');
    const snapshot = emptyHome();
    for (const row of rows) {
      const record = this.project(this.get(context, row.record_id));
      if (record.kind === 'home_asset') snapshot.assets.push(record);
      else snapshot.serviceRecords.push(record);
    }
    return snapshot;
  }
  private require(context: RequestContext, id: string, kind: HomeKind, revision?: number): TrackedRecord {
    let record: TrackedRecord;
    try {
      record = this.get(context, id, kind);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (revision !== undefined && revision !== record.revision) throw new Rejection('revision_conflict');
    return record;
  }
  taskPlan(taskId: string): MaintenancePlan | null {
    return (
      (this.db
        .prepare('SELECT asset_id AS assetId,reference FROM maintenance_plans WHERE task_id=?')
        .get(taskId) as MaintenancePlan | undefined) ?? null
    );
  }
  validateTaskPlan(
    context: RequestContext,
    scopeId: string,
    plan: MaintenancePlan | null,
    previous: MaintenancePlan | null,
  ): void {
    if (!plan) return;
    const asset = this.require(context, plan.assetId, 'home_asset');
    if (asset.content.scopeId !== scopeId) throw new Rejection('scope_mismatch');
    if (asset.content.deletedAt !== null) throw new Rejection('asset_unavailable');
    // Archiving preserves existing plans, but cannot silently add a new one.
    if (asset.content.archived && previous?.assetId !== plan.assetId) throw new Rejection('asset_archived');
  }
  saveTaskPlan(taskId: string, scopeId: string, plan: MaintenancePlan | null): void {
    if (!this.db.inTransaction) throw new Error('Maintenance relation must share the task transaction');
    if (!plan) this.db.prepare('DELETE FROM maintenance_plans WHERE task_id=?').run(taskId);
    else
      this.db
        .prepare(
          `INSERT INTO maintenance_plans(task_id,scope_id,asset_id,reference) VALUES (?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET asset_id=excluded.asset_id,reference=excluded.reference`,
        )
        .run(taskId, scopeId, plan.assetId, plan.reference);
  }
  recordCompletion(
    context: RequestContext,
    plan: MaintenancePlan,
    completion: TaskCompletion,
    now: number,
  ): RecordChange {
    const after = this.create(
      context,
      'maintenance_record',
      randomUUID(),
      {
        scopeId: completion.scopeId,
        deletedAt: null,
        attachments: [],
        assetId: plan.assetId,
        completionId: completion.recordId,
        occurredAt: completion.completedAt,
        notes: completion.note,
        costAmount: null,
        currency: null,
      },
      now,
    );
    return { before: null, after };
  }
  private checkReferences(context: RequestContext, kind: HomeKind, id: string, c: RecordContent): void {
    if (kind === 'home_asset') {
      if (
        c.deletedAt !== null &&
        this.db
          .prepare(
            `SELECT 1 FROM maintenance_plans p JOIN records r ON r.record_id=p.task_id WHERE p.asset_id=? AND r.deleted_at IS NULL
        UNION ALL SELECT 1 FROM maintenance_records m JOIN records r ON r.record_id=m.maintenance_record_id WHERE m.asset_id=? AND r.deleted_at IS NULL LIMIT 1`,
          )
          .get(id, id)
      )
        throw new Rejection('asset_has_active_records');
      return;
    }
    const asset = this.require(context, String(c.assetId), 'home_asset');
    if (asset.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
    if (c.deletedAt === null && asset.content.deletedAt !== null) throw new Rejection('asset_unavailable');
    if (c.completionId !== null) {
      const completion = this.db
        .prepare('SELECT scope_id,completed_at FROM task_completions WHERE completion_id=?')
        .get(c.completionId) as { scope_id: string; completed_at: number } | undefined;
      if (!completion || completion.scope_id !== c.scopeId) throw new Rejection('completion_unavailable');
      if (completion.completed_at !== c.occurredAt) throw new Rejection('completion_time_is_fixed');
    }
  }
  private create(
    context: RequestContext,
    kind: HomeKind,
    id: string,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(kind, value);
    this.access.requireScope(context, c.scopeId);
    this.checkReferences(context, kind, id, c);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    if (kind === 'home_asset')
      this.db
        .prepare("INSERT INTO home_assets VALUES (?,'home_asset',?,?,?,?,?,?,?,?)")
        .run(
          id,
          c.scopeId,
          c.name,
          c.model,
          c.serial,
          c.location,
          c.acquiredDate,
          c.notes,
          c.archived ? 1 : 0,
        );
    else
      this.db
        .prepare("INSERT INTO maintenance_records VALUES (?,'maintenance_record',?,?,?,?,?,?,?)")
        .run(id, c.scopeId, c.assetId, c.completionId, c.occurredAt, c.notes, c.costAmount, c.currency);
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
    const kind = before.kind as HomeKind,
      c = this.content(kind, value),
      id = before.recordId;
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    if (
      kind === 'maintenance_record' &&
      (c.assetId !== before.content.assetId || c.completionId !== before.content.completionId)
    )
      throw new Rejection('service_relationship_is_fixed');
    this.checkReferences(context, kind, id, c);
    if (kind === 'home_asset')
      this.db
        .prepare(
          'UPDATE home_assets SET name=?,model=?,serial=?,location=?,acquired_date=?,notes=?,archived=? WHERE asset_id=?',
        )
        .run(c.name, c.model, c.serial, c.location, c.acquiredDate, c.notes, c.archived ? 1 : 0, id);
    else
      this.db
        .prepare(
          'UPDATE maintenance_records SET occurred_at=?,notes=?,cost_amount=?,currency=? WHERE maintenance_record_id=?',
        )
        .run(c.occurredAt, c.notes, c.costAmount, c.currency, id);
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, id);
    this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
      live: c.deletedAt === null,
    });
    return this.get(context, id, kind);
  }
  private execute(
    context: RequestContext,
    kind: HomeCommandKind,
    payload: unknown,
    now: number,
  ): RecordMutation {
    requireHuman(context);
    const a = payload as Command<'CreateHomeAsset'>['arguments'] &
      Command<'CreateMaintenanceRecord'>['arguments'] & { expectedRevision: number; archived: boolean };
    const changes: RecordChange[] = [];
    const create = (type: HomeKind, c: RecordContent) =>
      changes.push({ before: null, after: this.create(context, type, a.recordId, c, now) });
    const result = () => ({ records: changes.map((change) => change.after), changes });
    if (
      (kind === 'CreateMaintenanceRecord' || kind === 'UpdateMaintenanceRecord') &&
      a.occurredAt > now + 300000
    )
      throw new Rejection('service_in_future');
    if (kind === 'CreateHomeAsset') {
      const { recordId: _id, ...fields } = payload as Command<'CreateHomeAsset'>['arguments'];
      create('home_asset', { ...fields, deletedAt: null, archived: false, attachments: [] });
      return result();
    }
    if (kind === 'CreateMaintenanceRecord') {
      const { recordId: _id, ...fields } = payload as Command<'CreateMaintenanceRecord'>['arguments'];
      create('maintenance_record', { ...fields, completionId: null, deletedAt: null, attachments: [] });
      return result();
    }
    const before = this.require(
      context,
      a.recordId,
      kind.includes('HomeAsset') ? 'home_asset' : 'maintenance_record',
      a.expectedRevision,
    );
    let content = { ...before.content };
    if (kind.startsWith('Delete') || kind.startsWith('Restore')) {
      const deleting = kind.startsWith('Delete');
      if (deleting === (before.content.deletedAt !== null))
        throw new Rejection(deleting ? 'already_deleted' : 'not_deleted');
      if (before.kind === 'maintenance_record' && before.content.completionId)
        throw new Rejection('use_completion_history_to_undo');
      content.deletedAt = deleting ? now : null;
    } else {
      if (before.content.deletedAt !== null) throw new Rejection('deleted');
      const {
        recordId: _id,
        expectedRevision: _revision,
        ...fields
      } = payload as Command<'UpdateHomeAsset'>['arguments'];
      content = { ...content, ...fields };
    }
    changes.push({ before, after: this.setContent(context, before, content, now) });
    return result();
  }
  private assertConsistent(): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM maintenance_records m JOIN records r ON r.record_id=m.maintenance_record_id JOIN records c ON c.record_id=m.completion_id
      WHERE (r.deleted_at IS NULL)<>(c.deleted_at IS NULL) LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('service_completion_dependency_changed');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM maintenance_plans p JOIN records a ON a.record_id=p.asset_id JOIN records t ON t.record_id=p.task_id
      WHERE t.deleted_at IS NULL AND a.deleted_at IS NOT NULL
      UNION ALL SELECT 1 FROM maintenance_records m JOIN records a ON a.record_id=m.asset_id JOIN records r ON r.record_id=m.maintenance_record_id
      WHERE r.deleted_at IS NULL AND a.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('asset_has_active_records');
  }
}
