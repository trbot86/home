import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';

export const NoteFields = {
  title: Type.String({ minLength: 1, maxLength: 300 }),
  body: Type.String({ maxLength: 20000 }),
  category: Type.String({ maxLength: 120 }),
};
export const NoteContent = object({
  scopeId: Id,
  deletedAt: Type.Union([Instant, Type.Null()]),
  ...NoteFields,
  attachments: Attachments,
});
export type NoteContent = Static<typeof NoteContent>;
export type Note = NoteContent & {
  recordId: string;
  kind: 'note';
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export const noteCommands = {
  CreateNote: object({ recordId: Id, scopeId: Id, ...NoteFields, attachments: Type.Optional(Attachments) }),
  UpdateNote: object({ recordId: Id, expectedRevision: Revision, ...NoteFields }),
  DeleteNote: object({ recordId: Id, expectedRevision: Revision }),
  RestoreNote: object({ recordId: Id, expectedRevision: Revision }),
};
