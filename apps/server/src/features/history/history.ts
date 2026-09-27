import { randomUUID } from 'node:crypto';
import type { CommandKind, HistoryEntry, InboxEntry } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import {
  AccessService,
  requireHuman,
  type HumanRequestContext,
  type RequestContext,
} from '../access/access.js';
import { requireIntegration } from '../access/integrations.js';
import {
  RecordRegistry,
  type RecordChange,
  type RecordContent,
  type TrackedRecord,
} from '../records/record-registry.js';
import { NotFound, Rejection } from '../../application/errors.js';

// Version 1 keeps the existing inbox encoding. Feature adapters validate reconstructed content.
type Delta = { baseline?: RecordContent; fields: Record<string, { before: unknown; after: unknown }> };
type ChangeRow = {
  change_set_id: string;
  actor_person_id: string | null;
  actor_integration_id: string | null;
  display_name: string;
  operation_kind: CommandKind;
  recorded_at: number;
  before_revision: number;
  after_revision: number;
  before_scope_id: string | null;
  after_scope_id: string;
  delta_json: string;
  undo_of_id: string | null;
  redo_of_id: string | null;
  record_id: string;
  payload_version: number;
};
function difference(before: TrackedRecord | null, after: TrackedRecord): Delta {
  if (!before) return { baseline: after.content, fields: {} };
  const fields: Delta['fields'] = {};
  for (const key of new Set([...Object.keys(before.content), ...Object.keys(after.content)])) {
    if (JSON.stringify(before.content[key]) !== JSON.stringify(after.content[key])) {
      if (!(key in before.content) || !(key in after.content))
        throw new Error('History content field shape changed');
      fields[key] = { before: before.content[key], after: after.content[key] };
    }
  }
  return { fields };
}
function decodeDelta(row: ChangeRow): Delta {
  if (row.payload_version !== 1) throw new Error('Unsupported history payload version');
  const delta = JSON.parse(row.delta_json) as Delta;
  if (!delta || !delta.fields || Array.isArray(delta.fields) || typeof delta.fields !== 'object')
    throw new Error('Invalid history delta');
  for (const field of Object.values(delta.fields))
    if (!field || !Object.hasOwn(field, 'before') || !Object.hasOwn(field, 'after'))
      throw new Error('Invalid history field');
  return delta;
}
function applyBefore(content: RecordContent, delta: Delta): RecordContent {
  return {
    ...structuredClone(content),
    ...Object.fromEntries(Object.entries(delta.fields).map(([key, change]) => [key, change.before])),
  };
}
export class HistoryService {
  constructor(
    private readonly db: Sqlite,
    private readonly records: RecordRegistry,
    private readonly access: AccessService,
  ) {}
  record(
    context: RequestContext,
    kind: CommandKind,
    changes: RecordChange[],
    now: number,
    links: { undoOf?: string; redoOf?: string } = {},
  ): string {
    if (context.kind === 'integration') {
      requireIntegration(this.db, context, now);
      if (
        kind !== 'CreateInboxEntry' ||
        links.undoOf ||
        links.redoOf ||
        changes.length !== 1 ||
        changes.some(
          ({ before, after }) =>
            before !== null ||
            after.kind !== 'inbox' ||
            !this.db
              .prepare("SELECT 1 FROM visibility_scopes WHERE scope_id=? AND kind='shared'")
              .get(after.content.scopeId),
        )
      )
        throw new Rejection('capture_only');
    } else requireHuman(context);
    if (!this.db.inTransaction) throw new Error('History must share the content transaction');
    if (!changes.length || new Set(changes.map((change) => change.after.recordId)).size !== changes.length)
      throw new Error('A changeset must contain each changed root exactly once');
    for (const { before, after } of changes) {
      if (before && (before.recordId !== after.recordId || before.kind !== after.kind))
        throw new Error('Record identity changed');
      if (after.revision !== (before?.revision ?? 0) + 1)
        throw new Error('Revision must advance once per action');
      this.records.validateContent(after.kind, after.content);
    }
    const id = randomUUID();
    const actorColumn = context.kind === 'integration' ? 'actor_integration_id' : 'actor_person_id';
    this.db
      .prepare(
        `INSERT INTO change_sets(change_set_id,client_id,${actorColumn},operation_kind,recorded_at,undo_of_id,redo_of_id) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        context.clientId,
        context.kind === 'integration' ? context.integrationId : context.personId,
        kind,
        now,
        links.undoOf ?? null,
        links.redoOf ?? null,
      );
    for (const { before, after } of changes) {
      this.db
        .prepare('INSERT INTO record_changes VALUES (?,?,?,?,?,?,1,?)')
        .run(
          id,
          after.recordId,
          before?.revision ?? 0,
          after.revision,
          before?.content.scopeId ?? null,
          after.content.scopeId,
          JSON.stringify(difference(before, after)),
        );
    }
    return id;
  }
  private rows(id: string): ChangeRow[] {
    return this.db
      .prepare(
        'SELECT cs.*,rc.* FROM change_sets cs JOIN record_changes rc USING(change_set_id) WHERE cs.change_set_id=? ORDER BY rc.record_id',
      )
      .all(id) as ChangeRow[];
  }
  private prepareReversal(
    context: HumanRequestContext,
    id: string,
    redo: boolean,
  ): { row: ChangeRow; current: TrackedRecord }[] {
    requireHuman(context);
    const rows = this.rows(id);
    const first = rows[0];
    if (!first || first.actor_person_id !== context.personId) throw new Rejection('unavailable');
    if (redo ? first.operation_kind !== 'UndoChangeSet' : first.operation_kind === 'UndoChangeSet')
      throw new Rejection('reversal_unavailable');
    if (
      this.db
        .prepare(
          redo
            ? 'SELECT 1 FROM change_sets WHERE redo_of_id=?'
            : 'SELECT 1 FROM change_sets WHERE undo_of_id=?',
        )
        .get(id)
    )
      throw new Rejection('reversal_unavailable');
    // Check every affected root before touching any of them.
    return rows.map((row) => {
      if (
        !this.access.canAccess(context, row.after_scope_id) ||
        (row.before_scope_id && !this.access.canAccess(context, row.before_scope_id))
      )
        throw new Rejection('unavailable');
      return { row, current: this.records.requireRevision(context, row.record_id, row.after_revision) };
    });
  }
  private eligible(
    context: HumanRequestContext,
    row: ChangeRow,
    current: TrackedRecord,
    redo: boolean,
  ): boolean {
    if (row.actor_person_id !== context.personId || row.after_revision !== current.revision) return false;
    try {
      this.prepareReversal(context, row.change_set_id, redo);
      return true;
    } catch (error) {
      if (error instanceof Rejection || error instanceof NotFound) return false;
      throw error;
    }
  }
  reverse(
    context: HumanRequestContext,
    id: string,
    redo: boolean,
    now: number,
  ): { records: TrackedRecord[]; changeSetId: string } {
    const prepared = this.prepareReversal(context, id, redo).map(({ row, current }) => {
      const delta = decodeDelta(row);
      const content = delta.baseline
        ? { ...current.content, deletedAt: now }
        : applyBefore(current.content, delta);
      return { before: current, content: this.records.validateContent(current.kind, content) };
    });
    prepared.sort(
      (a, b) =>
        this.records.reversalOrder(a.before, a.content) - this.records.reversalOrder(b.before, b.content),
    );
    const changes = prepared.map(({ before, content }) => ({
      before,
      after: this.records.setContent(context, before, content, now),
    }));
    const changeSetId = this.record(
      context,
      redo ? 'RedoChangeSet' : 'UndoChangeSet',
      changes,
      now,
      redo ? { redoOf: id } : { undoOf: id },
    );
    return { records: changes.map((change) => change.after), changeSetId };
  }
  list<Version = InboxEntry>(
    context: HumanRequestContext,
    id: string,
    expectedKind = 'inbox',
  ): HistoryEntry<Version>[] {
    requireHuman(context);
    const current = this.records.get(context, id);
    if (current.kind !== expectedKind) throw new NotFound();
    const rows = this.db
      .prepare(
        `SELECT cs.*,rc.*,COALESCE(p.display_name,a.display_name) AS display_name
      FROM change_sets cs JOIN record_changes rc USING(change_set_id)
      LEFT JOIN people p ON p.person_id=cs.actor_person_id
      LEFT JOIN integration_actors a ON a.integration_id=cs.actor_integration_id
      WHERE rc.record_id=? ORDER BY rc.after_revision DESC LIMIT 100`,
      )
      .all(id) as ChangeRow[];
    let content = current.content;
    const entries: HistoryEntry<Version>[] = [];
    for (const row of rows) {
      if (!this.access.canAccess(context, row.after_scope_id)) break;
      entries.push({
        changeSetId: row.change_set_id,
        actor:
          row.actor_person_id !== null
            ? { personId: row.actor_person_id, displayName: row.display_name }
            : {
                kind: 'integration',
                integrationId: row.actor_integration_id!,
                displayName: row.display_name,
              },
        kind: row.operation_kind,
        recordedAt: row.recorded_at,
        beforeRevision: row.before_revision,
        afterRevision: row.after_revision,
        undoOfId: row.undo_of_id,
        redoOfId: row.redo_of_id,
        version: this.records.project({
          ...current,
          content: structuredClone(content),
          revision: row.after_revision,
          updatedAt: row.recorded_at,
        }) as Version,
        canUndo: this.eligible(context, row, current, false),
        canRedo: this.eligible(context, row, current, true),
      });
      if (row.before_scope_id && !this.access.canAccess(context, row.before_scope_id)) break;
      content = this.records.validateContent(current.kind, applyBefore(content, decodeDelta(row)));
    }
    return entries;
  }
}
