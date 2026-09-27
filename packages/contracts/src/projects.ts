import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';

const title = Type.String({ minLength: 1, maxLength: 300 });
const nullableId = Type.Union([Id, Type.Null()]);
export const PageBlock = Type.Union([
  object({ blockId: Id, kind: Type.Literal('text'), text: Type.String({ maxLength: 20000 }) }),
  object({
    blockId: Id,
    kind: Type.Literal('web_link'),
    url: Type.String({ maxLength: 4096, pattern: '^https?://[^\\s]+$' }),
    title: Type.String({ maxLength: 300 }),
    notes: Type.String({ maxLength: 10000 }),
  }),
  object({
    blockId: Id,
    kind: Type.Literal('record_link'),
    recordId: Id,
    caption: Type.String({ maxLength: 1000 }),
  }),
  object({ blockId: Id, kind: Type.Literal('attachment'), attachmentId: Id }),
]);
export type PageBlock = Static<typeof PageBlock>;
export const PageBlocks = Type.Array(PageBlock, { maxItems: 200 });
export const ProjectFields = { title, description: Type.String({ maxLength: 20000 }) };
export const ProjectPageFields = { title, blocks: PageBlocks };
const common = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]), attachments: Attachments };
export const projectContentSchemas = {
  project: object({ ...common, ...ProjectFields, archived: Type.Boolean() }),
  project_page: object({
    ...common,
    ...ProjectPageFields,
    projectId: Id,
    parentPageId: nullableId,
    position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  }),
} as const;
export type ProjectKind = keyof typeof projectContentSchemas;
type Header<K extends ProjectKind> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type Project = Header<'project'> & Static<typeof projectContentSchemas.project>;
export type ProjectPage = Header<'project_page'> & Static<typeof projectContentSchemas.project_page>;
export type ProjectRecord = Project | ProjectPage;
export type ProjectSnapshot = { projects: Project[]; pages: ProjectPage[] };
export const emptyProjects = (): ProjectSnapshot => ({ projects: [], pages: [] });
const target = { recordId: Id, expectedRevision: Revision };
const members = Type.Array(object(target), { maxItems: 2000 });
export const projectCommands = {
  CreateProject: object({ recordId: Id, scopeId: Id, ...ProjectFields }),
  UpdateProject: object({ ...target, ...ProjectFields }),
  SetProjectArchived: object({ ...target, archived: Type.Boolean() }),
  DeleteProject: object({ ...target, pages: members }),
  RestoreProject: object({ ...target, pages: members }),
  CreateProjectPage: object({ recordId: Id, projectId: Id, parentPageId: nullableId, ...ProjectPageFields }),
  UpdateProjectPage: object({ ...target, ...ProjectPageFields }),
  MoveProjectPage: object({ ...target, projectId: Id, parentPageId: nullableId, descendants: members }),
  DeleteProjectPage: object({ ...target, descendants: members }),
  RestoreProjectPage: object({ ...target, descendants: members }),
} as const;
