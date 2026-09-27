import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Id, Instant, Revision, Digest, object } from './primitives.js';
import { shoppingCommands } from './shopping.js';
import { taskCommands } from './tasks.js';
import { Attachment, SetRecordAttachments } from './attachments.js';
export * from './attachments.js';
export { Id, Instant, Revision, Digest } from './primitives.js';
export * from './shopping.js';
export * from './tasks.js';
export * from './calendar-date.js';
export * from './capture.js';

export const Source = object({
  kind: Type.Union([
    Type.Literal('typed'),
    Type.Literal('voice'),
    Type.Literal('share'),
    Type.Literal('photo'),
  ]),
  uri: Type.Optional(Type.String({ maxLength: 4096 })),
});
export const EntryCategory = Type.Union([Type.Literal('inbox'), Type.Literal('app_suggestion')]);
export type EntryCategory = Static<typeof EntryCategory>;
// Older caches and submitted requests predate categories; their original bytes remain valid.
export function categoryOf(entry: { category?: EntryCategory }): EntryCategory {
  return entry.category ?? 'inbox';
}
export const CreateInboxEntry = object({
  inboxId: Id,
  scopeId: Id,
  capturedAt: Instant,
  text: Type.String({ maxLength: 20000 }),
  source: Source,
  attachments: Type.Array(Attachment, { maxItems: 20 }),
  category: Type.Optional(EntryCategory),
});
export const SetInboxEntryCategory = object({
  inboxId: Id,
  expectedRevision: Revision,
  category: EntryCategory,
});
export const SetInboxEntryText = object({
  inboxId: Id,
  expectedRevision: Revision,
  text: Type.String({ maxLength: 20000 }),
});
export const DeleteInboxEntry = object({ inboxId: Id, expectedRevision: Revision });
export const RestoreInboxEntry = DeleteInboxEntry;
export const ReverseChangeSet = object({ changeSetId: Id });
export const AbandonRestoredOperation = object({
  originalKind: Type.String({ maxLength: 80 }),
  originalCommand: Type.Unknown(),
});
export const argumentSchemas = {
  ...shoppingCommands,
  ...taskCommands,
  SetRecordAttachments,
  CreateInboxEntry,
  SetInboxEntryText,
  SetInboxEntryCategory,
  DeleteInboxEntry,
  RestoreInboxEntry,
  UndoChangeSet: ReverseChangeSet,
  RedoChangeSet: ReverseChangeSet,
} as const;
export type CommandKind = keyof typeof argumentSchemas;
export const Envelope = object({
  operationId: Id,
  contractVersion: Type.Literal(1),
  expectedServerEpoch: Id,
  arguments: Type.Unknown(),
});
export type Envelope = Static<typeof Envelope>;
export type Command<K extends CommandKind> = Omit<Envelope, 'arguments'> & {
  arguments: Static<(typeof argumentSchemas)[K]>;
};
export type RecordVersion = { recordId: string; revision: number };
export type Receipt = { operationId: string; requestDigest: string; recordedAt: number };
export type FinalOutcome =
  | { status: 'Applied'; receipt: Receipt; changeSetId?: string; result: { records: RecordVersion[] } }
  | { status: 'Rejected'; receipt: Receipt; code: string; safeDetails?: { fields: string[] } };
export type CommandOutcome =
  | (FinalOutcome & { replayed?: boolean })
  | { status: 'Deferred'; code: string }
  | { status: 'RecoveryRequired'; currentServerEpoch: string; restorePoint: number | null };
const receiptSchema = object({ operationId: Id, requestDigest: Digest, recordedAt: Instant });
export const OutcomeSchema = Type.Union([
  object({
    status: Type.Literal('Applied'),
    receipt: receiptSchema,
    changeSetId: Type.Optional(Id),
    result: object({ records: Type.Array(object({ recordId: Id, revision: Revision })) }),
    replayed: Type.Optional(Type.Boolean()),
  }),
  object({
    status: Type.Literal('Rejected'),
    receipt: receiptSchema,
    code: Type.String(),
    safeDetails: Type.Optional(object({ fields: Type.Array(Type.String()) })),
    replayed: Type.Optional(Type.Boolean()),
  }),
  object({ status: Type.Literal('Deferred'), code: Type.String() }),
  object({
    status: Type.Literal('RecoveryRequired'),
    currentServerEpoch: Id,
    restorePoint: Type.Union([Instant, Type.Null()]),
  }),
]);
export type Person = { personId: string; displayName: string };
export type HouseholdProfile = Person & { username: string };
export type AuthenticationOptions =
  { mode: 'password' } | { mode: 'trusted-network'; profiles: HouseholdProfile[] };
export type Scope = { scopeId: string; kind: 'shared' | 'private' };
export type Session = {
  person: Person;
  clientId: string;
  scopes: Scope[];
  installationId: string;
  serverEpoch: string;
  restorePoint: number | null;
  isAdministrator: boolean;
};
export type BackupSummary = {
  runId: string;
  startedAt: number;
  snapshotAt: number | null;
  completedAt: number | null;
  state: string;
  byteLength: number | null;
  verifiedAt: number | null;
  available: boolean;
  errorCode: string | null;
};
export type BackupStatus = {
  configured: boolean;
  destinationAvailable: boolean;
  checkedAt: number;
  runs: BackupSummary[];
  externalStatus: 'not_reported' | 'verified' | 'failed';
  secondaryCopy?: { checkedAt: number; snapshotAt: number | null };
  running: boolean;
};
export type InboxEntry = {
  inboxId: string;
  scopeId: string;
  revision: number;
  text: string;
  category: EntryCategory;
  capturedAt: number;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  source: Static<typeof Source>;
  attachments: Attachment[];
};
export type HistoryEntry<Version = InboxEntry> = {
  changeSetId: string;
  actor: Person;
  kind: CommandKind;
  recordedAt: number;
  beforeRevision: number;
  afterRevision: number;
  undoOfId: string | null;
  redoOfId: string | null;
  version: Version;
  canUndo: boolean;
  canRedo: boolean;
};
export type InboxPage = {
  entries: InboxEntry[];
  nextCursor: string | null;
  serverEpoch: string;
  sampledAt: number;
};

export function isValid<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}
export function invalidFields(schema: TSchema, value: unknown): string[] {
  return [...new Set([...Value.Errors(schema, value)].map((error) => error.path))].slice(0, 20);
}
