import {
  NoteContent,
  noteCommands,
  isValid,
  type Note,
  type Attachment,
  type Command,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { AccessService, requireHuman, type HumanRequestContext } from '../access/access.js';
import type { RecordAdapter, RecordContent, TrackedRecord } from '../records/record-registry.js';
import type { CommandHandler } from '../records/command-handler.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { AttachmentRepository } from '../media/attachments.js';

/** Standalone durable notes use the same registry, attachments and history as other records. */
export class NotesRepository {
  private readonly photos: AttachmentRepository;
  constructor(
    private db: Sqlite,
    private access: AccessService,
  ) {
    this.photos = new AttachmentRepository(db, access);
  }
  private content(value: unknown): NoteContent {
    if (!isValid(NoteContent, value)) throw new Error('Invalid note history content');
    if (!value.title.trim()) throw new Rejection('title_required');
    return value;
  }
  get(context: HumanRequestContext, id: string): TrackedRecord {
    requireHuman(context);
    const row = this.db
      .prepare(
        `SELECT r.*,n.title,n.body,n.category FROM records r JOIN notes n ON n.note_id=r.record_id WHERE r.record_id=? AND r.kind='note'`,
      )
      .get(id) as
      | {
          record_id: string;
          scope_id: string;
          revision: number;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
          title: string;
          body: string;
          category: string;
        }
      | undefined;
    if (!row || !this.access.canAccess(context, row.scope_id)) throw new NotFound();
    return {
      recordId: id,
      kind: 'note',
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: this.content({
        scopeId: row.scope_id,
        deletedAt: row.deleted_at,
        title: row.title,
        body: row.body,
        category: row.category,
        attachments: this.photos.list(id),
      }),
    };
  }
  project(record: TrackedRecord): Note {
    return {
      recordId: record.recordId,
      kind: 'note',
      revision: record.revision,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...this.content(record.content),
    };
  }
  snapshot(context: HumanRequestContext): Note[] {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT record_id FROM records JOIN visibility_scopes USING(scope_id) WHERE records.kind='note' AND (visibility_scopes.kind='shared' OR owner_person_id=?) ORDER BY updated_at DESC,record_id LIMIT 2001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 2000) throw new Rejection('cache_capacity_exceeded');
    return rows.map((row) => this.project(this.get(context, row.record_id)));
  }
  adapters(): RecordAdapter[] {
    // Historical migration rehearsals construct the registry before this feature existed.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes'").get()) return [];
    return [
      {
        kind: 'note',
        supportsAttachments: true,
        payloadTable: 'notes',
        payloadId: 'note_id',
        get: (c, id) => this.get(c, id),
        project: (r) => this.project(r),
        validateContent: (v) => this.content(v),
        setContent: (c, b, v, n) => this.setContent(c, b, v, n),
      },
    ];
  }
  private setContent(
    context: HumanRequestContext,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(value);
    this.access.requireScope(context, c.scopeId);
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    this.db
      .prepare('UPDATE notes SET title=?,body=?,category=? WHERE note_id=?')
      .run(c.title, c.body, c.category, before.recordId);
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, before.recordId);
    this.photos.replace(context, before.recordId, c.scopeId, c.attachments, now, {
      live: c.deletedAt === null,
    });
    return this.get(context, before.recordId);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(noteCommands) as (keyof typeof noteCommands)[],
      execute: (context, kind, payload, now) => {
        requireHuman(context);
        if (kind === 'CreateNote') {
          const args = payload as Command<'CreateNote'>['arguments'];
          this.access.requireScope(context, args.scopeId);
          if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(args.recordId))
            throw new Rejection('id_unavailable');
          const { recordId: _id, ...fields } = args;
          const c = this.content({ ...fields, deletedAt: null, attachments: args.attachments ?? [] });
          this.db
            .prepare("INSERT INTO records VALUES (?,'note',?,1,?,?,NULL)")
            .run(args.recordId, c.scopeId, now, now);
          this.db
            .prepare("INSERT INTO notes VALUES (?,'note',?,?,?,?)")
            .run(args.recordId, c.scopeId, c.title.trim(), c.body, c.category.trim());
          this.photos.replace(context, args.recordId, c.scopeId, c.attachments as Attachment[], now, {
            creating: true,
            live: true,
          });
          const after = this.get(context, args.recordId);
          return { records: [after], changes: [{ before: null, after }] };
        }
        const args = payload as Command<'UpdateNote'>['arguments'];
        let before: TrackedRecord;
        try {
          before = this.get(context, args.recordId);
        } catch (error) {
          if (error instanceof NotFound) throw new Rejection('unavailable');
          throw error;
        }
        if (before.revision !== args.expectedRevision) throw new Rejection('revision_conflict');
        if (kind === 'UpdateNote' && before.content.deletedAt !== null) throw new Rejection('deleted');
        if (kind === 'DeleteNote' && before.content.deletedAt !== null)
          throw new Rejection('already_deleted');
        if (kind === 'RestoreNote' && before.content.deletedAt === null) throw new Rejection('not_deleted');
        const next =
          kind === 'UpdateNote'
            ? { ...before.content, title: args.title.trim(), body: args.body, category: args.category.trim() }
            : { ...before.content, deletedAt: kind === 'DeleteNote' ? now : null };
        const after = this.setContent(context, before, next, now);
        return { records: [after], changes: [{ before, after }] };
      },
    };
  }
}
