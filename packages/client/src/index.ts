import type {
  Attachment,
  AuthenticationOptions,
  BackupStatus,
  CommandKind,
  CommandOutcome,
  HistoryEntry,
  InboxEntry,
  EntryCategory,
  Session,
  ShoppingRecord,
  ShoppingSnapshot,
  TaskSnapshot,
  HomeSnapshot,
  RecipeSnapshot,
  ProjectSnapshot,
  RecipeImportSummary,
  RecipeImportDetails,
  SavedView,
  CalendarSettings,
  BeginCalendarConnection,
  AgendaSnapshot,
} from '@our-place/contracts';
export type Draft = {
  draftId: string;
  clientId: string;
  scopeId: string;
  category?: EntryCategory;
  text: string;
  createdAt: number;
  revision: number;
  state: 'DRAFT' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'REJECTED';
  attachments: Attachment[];
  frozenJson?: string;
  frozenHash?: string;
  outcome?: CommandOutcome;
  settled?: boolean;
};
export type ClientState = {
  session: Session | null;
  entries: InboxEntry[];
  shopping: ShoppingSnapshot;
  tasks: TaskSnapshot;
  home: HomeSnapshot;
  recipes: RecipeSnapshot;
  projects: ProjectSnapshot;
  recipeImports: RecipeImportSummary[];
  views: SavedView[];
  agenda: AgendaSnapshot;
  drafts: Draft[];
  online: boolean;
  sampledAt: number | null;
  pendingEdits: string[];
  recoveryRequired: boolean;
};
export type StorageUsage = {
  databaseBytes: number;
  mediaBytes: number;
  stagingBytes: number;
  sampledAt: number;
};
export type EditorBuffer = { text: string; baseRevision: number; serverEpoch: string };
export type AttachmentDraft = {
  draftId: string;
  clientId: string;
  recordId: string;
  scopeId: string;
  baseRevision: number;
  serverEpoch: string;
  revision: number;
  attachments: Attachment[];
  localMediaIds: string[];
  state: 'DRAFT' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'REJECTED';
  operationId?: string;
  outcome?: CommandOutcome;
};
export * from './task-views.js';
export * from './agenda-view.js';
export * from './widget-navigation.js';
export type WidgetNavigation = {
  token: string;
  clientId: string;
  serverEpoch: string;
  recordId: string;
  action: 'show' | 'complete' | 'postpone';
};
export type RunRecordCommand = (
  target: { recordId: string },
  kind: CommandKind,
  args: unknown,
  label: string,
  epoch?: string,
) => Promise<CommandOutcome | null>;
export interface ClientPlatform {
  /** Consume one native widget shortcut. This requests navigation only, never a mutation. */
  takeWidgetNavigation?(): Promise<WidgetNavigation | null>;
  /** Dialogs dismiss first, then nested detail navigation, then the app-level fallback. */
  onBack?(listener: () => boolean, priority?: 'dialog' | 'detail'): () => void;
  subscribe(listener: () => void): () => void;
  state(): Promise<ClientState>;
  authenticationOptions(): Promise<AuthenticationOptions>;
  login(username: string, password: string): Promise<Session>;
  logout(): Promise<void>;
  refresh(): Promise<void>;
  createDraft(scopeId: string, category?: EntryCategory): Promise<Draft>;
  saveDraft(draftId: string, text: string, scopeId: string): Promise<Draft>;
  discardDraft(draftId: string): Promise<void>;
  addPhoto(draftId: string, file: Blob): Promise<Draft>;
  removePhoto(draftId: string, mediaId: string): Promise<Draft>;
  photoUrl(mediaId: string, descriptor?: Attachment): Promise<string>;
  submitDraft(draftId: string): Promise<void>;
  copyRejectedDraft(draftId: string): Promise<Draft>;
  sync(): Promise<void>;
  command(
    recordId: string,
    kind: CommandKind,
    args: unknown,
    expectedServerEpoch: string,
  ): Promise<CommandOutcome>;
  history(recordId: string): Promise<HistoryEntry[]>;
  shoppingHistory(recordId: string): Promise<HistoryEntry<ShoppingRecord>[]>;
  recordHistory<Version>(recordId: string): Promise<HistoryEntry<Version>[]>;
  recipeImport(importId: string): Promise<RecipeImportDetails>;
  saveEditor(recordId: string, text: string, baseRevision: number, serverEpoch: string): Promise<void>;
  readEditor(recordId: string): Promise<EditorBuffer | undefined>;
  clearEditor(recordId: string): Promise<void>;
  openAttachmentDraft(
    recordId: string,
    scopeId: string,
    revision: number,
    attachments: Attachment[],
  ): Promise<AttachmentDraft>;
  readAttachmentDraft(draftId: string): Promise<AttachmentDraft>;
  saveAttachmentDraft(draftId: string, revision: number, attachments: Attachment[]): Promise<AttachmentDraft>;
  addAttachmentPhoto(draftId: string, file: Blob): Promise<AttachmentDraft>;
  discardAttachmentDraft(draftId: string): Promise<void>;
  submitAttachmentDraft(draftId: string): Promise<CommandOutcome>;
  acquireAttachmentPhoto?(draftId: string, mode: 'camera' | 'gallery'): Promise<void>;
  storage(): Promise<StorageUsage>;
  backups(): Promise<BackupStatus>;
  createBackup(): Promise<void>;
  /** Account setup uses the system browser on Android; these methods are browser-only. */
  calendarSettings?(): Promise<CalendarSettings>;
  beginCalendarConnection?(
    input: BeginCalendarConnection,
  ): Promise<{ authorizationUrl: string; expiresAt: number }>;
  finishCalendarConnection?(handoffId: string): Promise<{ connectionId: string }>;
  discoverCalendars?(connectionId: string): Promise<unknown>;
  serverAddress?(): Promise<string>;
  /** Native hosts open web links outside the app so unfinished work stays in place. */
  openExternalUrl?(url: string): Promise<void>;
  configureServer?(url: string): Promise<void>;
  acquirePhoto?(draftId: string, mode: 'camera' | 'gallery'): Promise<void>;
  dictate?(category?: EntryCategory): Promise<void>;
  localStorage?(): Promise<{ databaseBytes: number; mediaBytes: number; sampledAt: number }>;
  recoverDraft(draftId: string): Promise<Draft | null>;
  reconcileEdits(): Promise<void>;
}
