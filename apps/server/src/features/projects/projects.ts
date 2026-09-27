import { randomUUID } from 'node:crypto';
import {
  Attachments,
  emptyProjects,
  isValid,
  projectCommands,
  projectContentSchemas,
  type Attachment,
  type Command,
  type PageBlock,
  type ProjectKind,
  type ProjectPage,
  type ProjectRecord,
  type ProjectSnapshot,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { requireHuman, type AccessService, type HumanRequestContext as Context } from '../access/access.js';
import type { RecordAdapter, RecordContent, TrackedRecord } from '../records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import { RecordLinkPolicy } from '../records/record-links.js';
import { AttachmentRepository } from '../media/attachments.js';
import { PageBlocksRepository } from './page-blocks.js';
import { ProjectHierarchy } from './hierarchy.js';

type Kind = keyof typeof projectCommands;
type Member = { recordId: string; expectedRevision: number };
const tables: Record<ProjectKind, [string, string]> = {
  project: ['projects', 'project_id'],
  project_page: ['project_pages', 'page_id'],
};
export class ProjectsRepository {
  private readonly attachments: AttachmentRepository;
  private readonly blocks: PageBlocksRepository;
  private readonly hierarchy: ProjectHierarchy;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.attachments = new AttachmentRepository(db, access);
    this.blocks = new PageBlocksRepository(db, new RecordLinkPolicy(db, access));
    this.hierarchy = new ProjectHierarchy(db);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(projectCommands) as Kind[],
      execute: (context, kind, payload, now) => {
        requireHuman(context);
        try {
          return this.execute(context, kind as Kind, payload, now);
        } catch (error) {
          if (error instanceof NotFound) throw new Rejection('unavailable');
          throw error;
        }
      },
    };
  }
  adapters(): RecordAdapter[] {
    return (Object.keys(tables) as ProjectKind[]).map((kind) => ({
      kind,
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      supportsAttachments: true,
      get: (context, id) => this.get(context, id, kind),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(kind, value),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now, true),
      ...(kind === 'project_page'
        ? {
            setAttachments: (context: Context, before: TrackedRecord, attachments: unknown, now: number) =>
              this.setPageAttachments(context, before, attachments, now),
          }
        : {}),
      ...(kind === 'project' ? { assertConsistent: () => this.hierarchy.assertConsistent() } : {}),
    }));
  }
  private content(kind: ProjectKind, value: unknown): RecordContent {
    if (!isValid(projectContentSchemas[kind], value)) throw new Error('Invalid project history content');
    const c = value as RecordContent;
    if (!String(c.title).trim()) throw new Rejection('title_required');
    if (kind === 'project_page') {
      const page = c as Omit<ProjectPage, 'recordId' | 'kind' | 'revision' | 'createdAt' | 'updatedAt'>;
      if (new Set(page.blocks.map((b) => b.blockId)).size !== page.blocks.length)
        throw new Rejection('duplicate_page_block');
      const photos = page.blocks
        .filter((b): b is Extract<PageBlock, { kind: 'attachment' }> => b.kind === 'attachment')
        .map((b) => b.attachmentId);
      if (new Set(photos).size !== photos.length) throw new Rejection('duplicate_attachment_block');
      if (
        photos.length !== page.attachments.length ||
        photos.some((id) => !page.attachments.some((a) => a.attachmentId === id))
      )
        throw new Rejection('page_attachment_mismatch');
      for (const block of page.blocks)
        if (block.kind === 'web_link') {
          try {
            const url = new URL(block.url);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
              throw new Error();
          } catch {
            throw new Rejection('invalid_web_link');
          }
        }
    }
    return c;
  }
  get(context: Context, id: string, expectedKind?: ProjectKind): TrackedRecord {
    requireHuman(context);
    const row = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as
      | {
          kind: ProjectKind;
          scope_id: string;
          revision: number;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
        }
      | undefined;
    if (
      !row ||
      !Object.hasOwn(tables, row.kind) ||
      (expectedKind && expectedKind !== row.kind) ||
      !this.access.canAccess(context, row.scope_id)
    )
      throw new NotFound();
    const [table, key] = tables[row.kind],
      data = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    if (!data) throw new Error('Project payload missing');
    const fields =
      row.kind === 'project'
        ? { title: data.title, description: data.description, archived: data.archived === 1 }
        : {
            title: data.title,
            projectId: data.project_id,
            parentPageId: data.parent_page_id,
            position: data.position,
            blocks: this.blocks.list(id),
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
  project(record: TrackedRecord): ProjectRecord {
    const { content, ...header } = record;
    return { ...header, ...this.content(record.kind as ProjectKind, content) } as ProjectRecord;
  }
  snapshot(context: Context): ProjectSnapshot {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id) WHERE r.kind IN ('project','project_page') AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at,r.record_id LIMIT 2001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 2000) throw new Rejection('cache_capacity_exceeded');
    const result = emptyProjects();
    for (const row of rows) {
      const record = this.project(this.get(context, row.record_id));
      if (record.kind === 'project') result.projects.push(record);
      else result.pages.push(record);
    }
    return result;
  }
  private require(context: Context, id: string, kind: ProjectKind, revision?: number) {
    const record = this.get(context, id, kind);
    if (revision !== undefined && record.revision !== revision) throw new Rejection('revision_conflict');
    return record;
  }
  private live(record: TrackedRecord) {
    if (record.content.deletedAt !== null) throw new Rejection('deleted');
    return record;
  }
  private parent(context: Context, projectId: string, parentPageId: string | null, pageId?: string) {
    const project = this.live(this.require(context, projectId, 'project'));
    if (parentPageId) {
      if (parentPageId === pageId) throw new Rejection('page_cycle');
      const parent = this.live(this.require(context, parentPageId, 'project_page'));
      if (parent.content.projectId !== projectId) throw new Rejection('page_parent_unavailable');
    }
    return project;
  }
  private create(context: Context, kind: ProjectKind, id: string, value: RecordContent, now: number) {
    const c = this.content(kind, value);
    this.access.requireScope(context, c.scopeId);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    if (kind === 'project')
      this.db
        .prepare("INSERT INTO projects VALUES (?,'project',?,?,?,?)")
        .run(id, c.scopeId, c.title, c.description, c.archived ? 1 : 0);
    else
      this.db
        .prepare("INSERT INTO project_pages VALUES (?,'project_page',?,?,?,?,?)")
        .run(id, c.scopeId, c.projectId, c.parentPageId, c.title, c.position);
    this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
      creating: true,
      live: true,
    });
    if (kind === 'project_page') this.blocks.replace(context, id, c.scopeId, c.blocks as PageBlock[], now);
    return this.get(context, id);
  }
  private setContent(
    context: Context,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
    historical = false,
  ) {
    const c = this.content(before.kind as ProjectKind, value),
      id = before.recordId;
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    if (before.kind === 'project')
      this.db
        .prepare('UPDATE projects SET title=?,description=?,archived=? WHERE project_id=?')
        .run(c.title, c.description, c.archived ? 1 : 0, id);
    else {
      if (c.parentPageId === id) throw new Rejection('page_cycle');
      const project = this.require(context, String(c.projectId), 'project');
      if (project.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
      this.db
        .prepare('UPDATE project_pages SET project_id=?,parent_page_id=?,title=?,position=? WHERE page_id=?')
        .run(c.projectId, c.parentPageId, c.title, c.position, id);
    }
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, id);
    this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
      live: c.deletedAt === null,
    });
    if (before.kind === 'project_page')
      this.blocks.replace(context, id, c.scopeId, c.blocks as PageBlock[], now, historical);
    return this.get(context, id);
  }
  private setPageAttachments(context: Context, before: TrackedRecord, value: unknown, now: number) {
    if (!isValid(Attachments, value)) throw new Rejection('invalid_attachments');
    const ids = new Set(value.map((a) => a.attachmentId));
    const blocks = (before.content.blocks as PageBlock[]).filter(
      (b) => b.kind !== 'attachment' || ids.has(b.attachmentId),
    );
    const present = new Set(
      blocks
        .filter((b): b is Extract<PageBlock, { kind: 'attachment' }> => b.kind === 'attachment')
        .map((b) => b.attachmentId),
    );
    for (const a of value)
      if (!present.has(a.attachmentId))
        blocks.push({ blockId: randomUUID(), kind: 'attachment', attachmentId: a.attachmentId });
    if (blocks.length > 200) throw new Rejection('page_block_limit');
    return this.setContent(context, before, { ...before.content, attachments: value, blocks }, now);
  }
  private checkMembers(expected: Member[], actual: { page_id: string; revision: number }[], exact: boolean) {
    if (
      new Set(expected.map((p) => p.recordId)).size !== expected.length ||
      (exact && expected.length !== actual.length) ||
      expected.some(
        (p) => !actual.some((row) => row.page_id === p.recordId && row.revision === p.expectedRevision),
      )
    )
      throw new Rejection('project_members_changed');
  }
  private execute(context: Context, kind: Kind, payload: unknown, now: number): RecordMutation {
    const result: RecordMutation = { records: [], changes: [] };
    const change = (before: TrackedRecord, content: RecordContent) => {
      const after = this.setContent(context, before, content, now);
      result.records.push(after);
      result.changes.push({ before, after });
    };
    if (kind === 'CreateProject' || kind === 'CreateProjectPage') {
      const args = payload as Command<'CreateProject'>['arguments'];
      let content: RecordContent;
      if (kind === 'CreateProject')
        content = {
          scopeId: args.scopeId,
          title: args.title,
          description: args.description,
          archived: false,
          deletedAt: null,
          attachments: [],
        };
      else {
        const page = payload as Command<'CreateProjectPage'>['arguments'],
          project = this.parent(context, page.projectId, page.parentPageId, page.recordId);
        content = {
          scopeId: project.content.scopeId,
          deletedAt: null,
          attachments: [],
          title: page.title,
          projectId: page.projectId,
          parentPageId: page.parentPageId,
          position: this.hierarchy.position(page.projectId, page.parentPageId),
          blocks: page.blocks,
        };
      }
      const after = this.create(
        context,
        kind === 'CreateProject' ? 'project' : 'project_page',
        args.recordId,
        content,
        now,
      );
      return { records: [after], changes: [{ before: null, after }] };
    }
    const args = payload as Member,
      isPage = kind.endsWith('Page'),
      before = this.require(
        context,
        args.recordId,
        isPage ? 'project_page' : 'project',
        args.expectedRevision,
      );
    if (kind === 'RestoreProject' || kind === 'RestoreProjectPage') {
      if (before.content.deletedAt === null) throw new Rejection('not_deleted');
      const restore = payload as Command<'RestoreProject'>['arguments'] &
        Command<'RestoreProjectPage'>['arguments'];
      const members = isPage ? restore.descendants : restore.pages;
      const available = (
        isPage
          ? this.hierarchy.descendants(before.recordId, String(before.content.projectId))
          : this.hierarchy.pages(before.recordId)
      ).filter((p) => p.deleted_at !== null);
      this.checkMembers(members, available, false);
      change(before, { ...before.content, deletedAt: null });
      for (const member of members) {
        const page = this.require(context, member.recordId, 'project_page', member.expectedRevision);
        change(page, { ...page.content, deletedAt: null });
      }
      return result;
    }
    this.live(before);
    if (kind === 'DeleteProject' || kind === 'DeleteProjectPage') {
      const remove = payload as Command<'DeleteProject'>['arguments'] &
        Command<'DeleteProjectPage'>['arguments'];
      const pages = (
        isPage
          ? this.hierarchy.descendants(before.recordId, String(before.content.projectId))
          : this.hierarchy.pages(before.recordId)
      ).filter((p) => p.deleted_at === null);
      this.checkMembers(isPage ? remove.descendants : remove.pages, pages, true);
      for (const child of pages) {
        const page = this.get(context, child.page_id, 'project_page');
        change(page, { ...page.content, deletedAt: now });
      }
      change(before, { ...before.content, deletedAt: now });
      return result;
    }
    if (kind === 'MoveProjectPage') {
      const move = payload as Command<'MoveProjectPage'>['arguments'];
      const project = this.parent(context, move.projectId, move.parentPageId, before.recordId);
      if (project.content.scopeId !== before.content.scopeId) throw new Rejection('scope_mismatch');
      const descendants = this.hierarchy.descendants(before.recordId, String(before.content.projectId));
      this.checkMembers(move.descendants, descendants, true);
      if (descendants.some((p) => p.page_id === move.parentPageId)) throw new Rejection('page_cycle');
      change(before, {
        ...before.content,
        projectId: move.projectId,
        parentPageId: move.parentPageId,
        position: this.hierarchy.position(move.projectId, move.parentPageId),
      });
      for (const descendant of descendants) {
        const child = this.get(context, descendant.page_id, 'project_page');
        change(child, { ...child.content, projectId: move.projectId });
      }
      return result;
    }
    if (kind === 'UpdateProjectPage') {
      const edit = payload as Command<'UpdateProjectPage'>['arguments'];
      const photos = new Set(
        edit.blocks
          .filter((b): b is Extract<PageBlock, { kind: 'attachment' }> => b.kind === 'attachment')
          .map((b) => b.attachmentId),
      );
      change(before, {
        ...before.content,
        title: edit.title,
        blocks: edit.blocks,
        attachments: (before.content.attachments as Attachment[]).filter((a) => photos.has(a.attachmentId)),
      });
      return result;
    }
    const { recordId: _id, expectedRevision: _revision, ...fields } = payload as Record<string, unknown>;
    change(before, { ...before.content, ...fields });
    return result;
  }
}
