import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { taskCommands } from './tasks.js';
import { shoppingCommands } from './shopping.js';
import { projectCommands } from './projects.js';

export const InboxDestination = object({ recordId: Id, filedAt: Instant });
export type InboxDestination = Static<typeof InboxDestination>;
export const InboxDestinations = Type.Array(InboxDestination, { maxItems: 20 });
export const inboxFilingFields = {
  // Optional for old device caches and version-1 history; never change frozen creates.
  filedAt: Type.Optional(Type.Union([Instant, Type.Null()])),
  destinations: Type.Optional(InboxDestinations),
};
export type InboxFiling = { filedAt?: number | null; destinations?: InboxDestination[] };
export function filingOf(entry: InboxFiling) {
  return { filedAt: entry.filedAt ?? null, destinations: entry.destinations ?? [] };
}
export const FilingDestination = Type.Union([
  object({ kind: Type.Literal('existing'), recordId: Id }),
  object({ kind: Type.Literal('CreateTask'), arguments: taskCommands.CreateTask }),
  object({ kind: Type.Literal('AddShoppingEntry'), arguments: shoppingCommands.AddShoppingEntry }),
  object({
    kind: Type.Literal('CreateProjectPage'),
    arguments: projectCommands.CreateProjectPage,
    newProject: Type.Optional(projectCommands.CreateProject),
  }),
]);
export type FilingDestination = Static<typeof FilingDestination>;
const source = { inboxId: Id, expectedRevision: Revision };
export const inboxFilingCommands = {
  FileInboxEntry: object({ ...source, destination: FilingDestination }),
  ReturnInboxEntry: object(source),
  RemoveInboxDestination: object({ ...source, recordId: Id }),
};
