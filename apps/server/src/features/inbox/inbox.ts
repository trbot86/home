import {
  categoryOf,
  type Attachment,
  type Command,
  type EntryCategory,
  type InboxEntry,
  type InboxPage,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { installation } from '../../infrastructure/database.js';
import {
  AccessService,
  requireHuman,
  type RequestContext,
  type HumanRequestContext,
} from '../access/access.js';
import { requireIntegration } from '../access/integrations.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AttachmentRepository } from '../media/attachments.js';

export type InboxContent = Pick<
  InboxEntry,
  'scopeId' | 'text' | 'capturedAt' | 'source' | 'attachments' | 'deletedAt' | 'category'
>;
type InboxRow = {
  record_id: string;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  text: string;
  category: EntryCategory;
  captured_at: number;
  source_json: string;
};
export function contentOf(entry: InboxEntry): InboxContent {
  const { scopeId, text, capturedAt, source, attachments, deletedAt } = entry;
  return { scopeId, text, capturedAt, source, attachments, deletedAt, category: categoryOf(entry) };
}
export class InboxRepository {
  private readonly attachments: AttachmentRepository;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.attachments = new AttachmentRepository(db, access);
  }
  snapshot(context: HumanRequestContext, now: number) {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind='inbox' AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at DESC,r.record_id DESC LIMIT 2001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 2000) throw new Rejection('cache_capacity_exceeded');
    return {
      entries: rows.map((row) => this.get(context, row.record_id)),
      serverEpoch: installation(this.db).recovery_epoch,
      sampledAt: now,
    };
  }
  get(context: HumanRequestContext, id: string): InboxEntry {
    requireHuman(context);
    const row = this.db
      .prepare(
        'SELECT r.*, i.text,i.captured_at,i.source_json,i.category FROM records r JOIN inbox_entries i ON i.inbox_id=r.record_id WHERE r.record_id=?',
      )
      .get(id) as InboxRow | undefined;
    if (!row || !this.access.canAccess(context, row.scope_id)) throw new NotFound();
    return {
      inboxId: id,
      scopeId: row.scope_id,
      revision: row.revision,
      text: row.text,
      category: row.category,
      capturedAt: row.captured_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      source: JSON.parse(row.source_json),
      attachments: this.attachments.list(id),
    };
  }
  list(
    context: HumanRequestContext,
    now: number,
    options: { scopeId?: string; deleted?: boolean; cursor?: string; limit?: number } = {},
  ): InboxPage {
    requireHuman(context);
    if (options.scopeId) this.access.requireScope(context, options.scopeId);
    const limit = Math.min(Math.max(options.limit ?? 40, 1), 100);
    let cursor: [number, string] | undefined;
    if (options.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(options.cursor, 'base64url').toString());
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          !Number.isSafeInteger(value[0]) ||
          typeof value[1] !== 'string'
        )
          throw new Error();
        cursor = value as [number, string];
      } catch {
        throw new Rejection('invalid_cursor');
      }
    }
    const rows = this.db
      .prepare(
        `SELECT r.record_id,r.created_at FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind='inbox' AND (s.kind='shared' OR s.owner_person_id=@person)
      AND (@scope IS NULL OR r.scope_id=@scope) AND (r.deleted_at IS NOT NULL)=@deleted
      AND (@cursorTime IS NULL OR (r.created_at,r.record_id)<(@cursorTime,@cursorId))
      ORDER BY r.created_at DESC,r.record_id DESC LIMIT @limit`,
      )
      .all({
        person: context.personId,
        scope: options.scopeId ?? null,
        deleted: options.deleted ? 1 : 0,
        cursorTime: cursor?.[0] ?? null,
        cursorId: cursor?.[1] ?? null,
        limit: limit + 1,
      }) as { record_id: string; created_at: number }[];
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return {
      entries: selected.map((row) => this.get(context, row.record_id)),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.created_at, last.record_id])).toString('base64url')
          : null,
      serverEpoch: installation(this.db).recovery_epoch,
      sampledAt: now,
    };
  }
  create(context: RequestContext, args: Command<'CreateInboxEntry'>['arguments'], now: number): InboxEntry {
    if (context.kind === 'integration') {
      requireIntegration(this.db, context, now);
      if (
        !this.db
          .prepare("SELECT 1 FROM visibility_scopes WHERE scope_id=? AND kind='shared'")
          .get(args.scopeId) ||
        args.attachments.length ||
        args.source.kind !== 'voice' ||
        args.source.uri !== undefined ||
        categoryOf(args) !== 'inbox' ||
        args.text.length > 1000
      )
        throw new Rejection('capture_only');
    } else this.access.requireScope(context, args.scopeId);
    if (!args.text.trim() && args.attachments.length === 0) throw new Rejection('empty_entry');
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(args.inboxId))
      throw new Rejection('id_unavailable');
    this.db
      .prepare("INSERT INTO records VALUES (?, 'inbox', ?,1,?,?,NULL)")
      .run(args.inboxId, args.scopeId, now, now);
    this.db
      .prepare(
        "INSERT INTO inbox_entries(inbox_id,record_kind,text,captured_at,source_json,category) VALUES (?, 'inbox', ?,?,?,?)",
      )
      .run(args.inboxId, args.text, args.capturedAt, JSON.stringify(args.source), categoryOf(args));
    if (context.kind !== 'integration') {
      this.attachments.replace(context, args.inboxId, args.scopeId, args.attachments, now, {
        creating: true,
        live: true,
      });
      return this.get(context, args.inboxId);
    }
    return { ...args, category: 'inbox', revision: 1, createdAt: now, updatedAt: now, deletedAt: null };
  }
  requireRevision(context: HumanRequestContext, id: string, expected: number): InboxEntry {
    let entry: InboxEntry;
    try {
      entry = this.get(context, id);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (entry.revision !== expected) throw new Rejection('revision_conflict');
    return entry;
  }
  setContent(context: HumanRequestContext, before: InboxEntry, next: InboxContent, now: number): InboxEntry {
    requireHuman(context);
    if (
      next.scopeId !== before.scopeId ||
      JSON.stringify(next.source) !== JSON.stringify(before.source) ||
      next.capturedAt !== before.capturedAt
    )
      throw new Error('Unsupported content mutation');
    if (!next.text.trim() && next.attachments.length === 0) throw new Rejection('empty_entry');
    this.db
      .prepare('UPDATE inbox_entries SET text=?,category=? WHERE inbox_id=?')
      .run(next.text, categoryOf(next), before.inboxId);
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, next.deletedAt, before.inboxId);
    this.attachments.replace(context, before.inboxId, next.scopeId, next.attachments, now, {
      live: next.deletedAt === null,
    });
    return this.get(context, before.inboxId);
  }
}
