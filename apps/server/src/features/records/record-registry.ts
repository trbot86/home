import type { Sqlite } from '../../infrastructure/database.js';
import { requireHuman, type HumanRequestContext as RequestContext } from '../access/access.js';
import { NotFound, Rejection } from '../../application/errors.js';

export type RecordContent = Record<string, unknown> & { scopeId: string; deletedAt: number | null };
export type TrackedRecord = {
  recordId: string;
  kind: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  content: RecordContent;
};
export type RecordChange = { before: TrackedRecord | null; after: TrackedRecord };
/** Each feature owns its concrete SQL, validation, history content and public projection. */
export interface RecordAdapter {
  kind: string;
  supportsAttachments?: boolean;
  /** A content owner can reconcile owned attachment blocks in the same action. */
  setAttachments?(
    context: RequestContext,
    before: TrackedRecord,
    attachments: unknown,
    now: number,
  ): TrackedRecord;
  payloadTable: string;
  payloadId: string;
  get(context: RequestContext, id: string): TrackedRecord;
  setContent(
    context: RequestContext,
    before: TrackedRecord,
    content: RecordContent,
    now: number,
  ): TrackedRecord;
  project(record: TrackedRecord): unknown;
  validateContent(content: unknown): RecordContent;
  assertConsistent?(): void;
  /** Close occupied unique slots before restoring others in an atomic reversal. */
  reversalOrder?(before: TrackedRecord, content: RecordContent): number;
}
export class RecordRegistry {
  private readonly adapters = new Map<string, RecordAdapter>();
  constructor(
    private readonly db: Sqlite,
    adapters: RecordAdapter[],
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.kind)) throw new Error('Duplicate record adapter');
      if (![adapter.payloadTable, adapter.payloadId].every((value) => /^[a-z_]+$/.test(value)))
        throw new Error('Invalid static payload identifier');
      this.adapters.set(adapter.kind, adapter);
    }
  }
  private adapter(kind: string): RecordAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`No adapter registered for record kind ${kind}`);
    return adapter;
  }
  get(context: RequestContext, id: string): TrackedRecord {
    requireHuman(context);
    const row = this.db.prepare('SELECT kind FROM records WHERE record_id=?').get(id) as
      { kind: string } | undefined;
    if (!row) throw new NotFound();
    return this.adapter(row.kind).get(context, id);
  }
  requireRevision(context: RequestContext, id: string, revision: number): TrackedRecord {
    let record: TrackedRecord;
    try {
      record = this.get(context, id);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (record.revision !== revision) throw new Rejection('revision_conflict');
    return record;
  }
  setAttachments(
    context: RequestContext,
    before: TrackedRecord,
    attachments: unknown,
    now: number,
  ): TrackedRecord {
    if (!this.adapter(before.kind).supportsAttachments) throw new Rejection('attachments_not_supported');
    if (before.content.deletedAt !== null) throw new Rejection('deleted');
    const owner = this.adapter(before.kind).setAttachments;
    if (owner) return owner(context, before, attachments, now);
    return this.setContent(context, before, { ...before.content, attachments }, now);
  }
  setContent(
    context: RequestContext,
    before: TrackedRecord,
    content: RecordContent,
    now: number,
  ): TrackedRecord {
    requireHuman(context);
    const adapter = this.adapter(before.kind);
    return adapter.setContent(context, before, adapter.validateContent(content), now);
  }
  project(record: TrackedRecord): unknown {
    return this.adapter(record.kind).project(record);
  }
  validateContent(kind: string, content: unknown): RecordContent {
    return this.adapter(kind).validateContent(content);
  }
  reversalOrder(before: TrackedRecord, content: RecordContent): number {
    return this.adapter(before.kind).reversalOrder?.(before, content) ?? 0;
  }
  assertComplete(): void {
    for (const adapter of this.adapters.values()) {
      const missing = this.db
        .prepare(
          `SELECT 1 FROM records r LEFT JOIN ${adapter.payloadTable} p
        ON p.${adapter.payloadId}=r.record_id WHERE r.kind=? AND p.${adapter.payloadId} IS NULL LIMIT 1`,
        )
        .get(adapter.kind);
      if (missing) throw new Error('Record payload invariant failed');
      adapter.assertConsistent?.();
    }
    const kinds = this.db.prepare('SELECT DISTINCT kind FROM records').all() as { kind: string }[];
    for (const { kind } of kinds) this.adapter(kind);
  }
}
