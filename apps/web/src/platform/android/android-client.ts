import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type {
  AttachmentDraft,
  ClientPlatform,
  ClientState,
  Draft,
  EditorBuffer,
  StorageUsage,
  WidgetNavigation,
} from '@our-place/client';
import type {
  AuthenticationOptions,
  Attachment,
  BackupStatus,
  CommandKind,
  CommandOutcome,
  HistoryEntry,
  EntryCategory,
  Session,
  ShoppingRecord,
  RecipeImportDetails,
  SuggestionReplyTarget,
  SuggestionMessage,
} from '@our-place/contracts';
type NativeMethod =
  | 'appVersion'
  | 'publishedAppVersion'
  | 'state'
  | 'takeWidgetNavigation'
  | 'endpoint'
  | 'openExternalUrl'
  | 'configure'
  | 'login'
  | 'authenticationOptions'
  | 'logout'
  | 'refresh'
  | 'sync'
  | 'createDraft'
  | 'suggestionMessages'
  | 'saveDraft'
  | 'discardDraft'
  | 'submitDraft'
  | 'addPhoto'
  | 'removePhoto'
  | 'copyRejectedDraft'
  | 'photoPath'
  | 'command'
  | 'history'
  | 'shoppingHistory'
  | 'recordHistory'
  | 'recipeImport'
  | 'saveEditor'
  | 'readEditor'
  | 'clearEditor'
  | 'storage'
  | 'localStorage'
  | 'backups'
  | 'createBackup'
  | 'acquirePhoto'
  | 'dictate'
  | 'recoverDraft'
  | 'openAttachmentDraft'
  | 'readAttachmentDraft'
  | 'saveAttachmentDraft'
  | 'discardAttachmentDraft'
  | 'addAttachmentPhoto'
  | 'submitAttachmentDraft'
  | 'acquireAttachmentPhoto'
  | 'reconcileEdits';
const native = registerPlugin<{
  invoke(options: { method: NativeMethod; args: Record<string, unknown> }): Promise<{ value: unknown }>;
  addListener(event: 'changed', listener: () => void): Promise<PluginListenerHandle>;
}>('Household');
/** A typed bridge only; Android persistence and networking are owned by Kotlin. */
export class AndroidClient implements ClientPlatform {
  private readonly backListeners = new Set<{
    listener: () => boolean;
    priority: 'dialog' | 'detail' | undefined;
  }>();
  private readonly handleBack = (event: Event) => {
    if (event.defaultPrevented) return;
    // Window-target events do not reliably run capture listeners before ordinary listeners in WebView.
    for (const priority of ['dialog', 'detail', undefined] as const) {
      for (const registration of [...this.backListeners].reverse()) {
        if (registration.priority === priority && registration.listener()) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
    }
  };
  onBack(listener: () => boolean, priority?: 'dialog' | 'detail'): () => void {
    const registration = { listener, priority };
    if (!this.backListeners.size) window.addEventListener('ourplace:back', this.handleBack);
    this.backListeners.add(registration);
    return () => {
      this.backListeners.delete(registration);
      if (!this.backListeners.size) window.removeEventListener('ourplace:back', this.handleBack);
    };
  }
  private async invoke<T>(method: NativeMethod, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return (await native.invoke({ method, args })).value as T;
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message.replaceAll('_', ' ') : 'Native operation failed',
      );
    }
  }
  subscribe(listener: () => void): () => void {
    const handle = native.addListener('changed', listener);
    return () => {
      void handle.then((value) => value.remove());
    };
  }
  state(): Promise<ClientState> {
    return this.invoke('state');
  }
  takeWidgetNavigation(): Promise<WidgetNavigation | null> {
    return this.invoke('takeWidgetNavigation');
  }
  serverAddress(): Promise<string> {
    return this.invoke('endpoint');
  }
  appVersion(): Promise<{ version: string; sha256: string }> {
    return this.invoke('appVersion');
  }
  publishedAppVersion(): Promise<{ sha256: string }> {
    return this.invoke('publishedAppVersion');
  }
  openExternalUrl(url: string): Promise<void> {
    return this.invoke('openExternalUrl', { url });
  }
  configureServer(url: string): Promise<void> {
    return this.invoke('configure', { url });
  }
  login(username: string, password: string): Promise<Session> {
    return this.invoke('login', { username, password });
  }
  authenticationOptions(): Promise<AuthenticationOptions> {
    return this.invoke('authenticationOptions');
  }
  logout(): Promise<void> {
    return this.invoke('logout');
  }
  refresh(): Promise<void> {
    return this.invoke('refresh');
  }
  sync(): Promise<void> {
    return this.invoke('sync');
  }
  createDraft(
    scopeId: string,
    category: EntryCategory = 'inbox',
    replyTarget?: SuggestionReplyTarget,
  ): Promise<Draft> {
    return this.invoke('createDraft', { scopeId, category, ...(replyTarget ? { replyTarget } : {}) });
  }
  suggestionMessages(suggestionId: string, beforeSequence: number): Promise<SuggestionMessage[]> {
    return this.invoke('suggestionMessages', { suggestionId, beforeSequence });
  }
  saveDraft(draftId: string, text: string, scopeId: string): Promise<Draft> {
    return this.invoke('saveDraft', { draftId, text, scopeId });
  }
  discardDraft(draftId: string): Promise<void> {
    return this.invoke('discardDraft', { draftId });
  }
  submitDraft(draftId: string, requestWork?: boolean): Promise<void> {
    return this.invoke('submitDraft', { draftId, ...(requestWork === undefined ? {} : { requestWork }) });
  }
  async addPhoto(draftId: string, file: Blob): Promise<Draft> {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a photo under 25 MB');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(file);
    });
    return this.invoke('addPhoto', { draftId, base64, mimeType: file.type });
  }
  removePhoto(draftId: string, mediaId: string): Promise<Draft> {
    return this.invoke('removePhoto', { draftId, mediaId });
  }
  copyRejectedDraft(draftId: string): Promise<Draft> {
    return this.invoke('copyRejectedDraft', { draftId });
  }
  async photoUrl(mediaId: string, descriptor?: Attachment): Promise<string> {
    return Capacitor.convertFileSrc(await this.invoke('photoPath', { mediaId, descriptor }));
  }
  command(
    recordId: string,
    kind: CommandKind,
    args: unknown,
    expectedServerEpoch: string,
  ): Promise<CommandOutcome> {
    return this.invoke('command', { recordId, kind, arguments: args, expectedServerEpoch });
  }
  history(recordId: string): Promise<HistoryEntry[]> {
    return this.invoke('history', { recordId });
  }
  recipeImport(importId: string): Promise<RecipeImportDetails> {
    return this.invoke('recipeImport', { importId });
  }
  shoppingHistory(recordId: string): Promise<HistoryEntry<ShoppingRecord>[]> {
    return this.invoke('shoppingHistory', { recordId });
  }
  recordHistory<Version>(recordId: string): Promise<HistoryEntry<Version>[]> {
    return this.invoke('recordHistory', { recordId });
  }
  saveEditor(recordId: string, text: string, baseRevision: number, serverEpoch: string): Promise<void> {
    return this.invoke('saveEditor', { recordId, text, baseRevision, serverEpoch });
  }
  async readEditor(recordId: string): Promise<EditorBuffer | undefined> {
    return (await this.invoke<EditorBuffer | null>('readEditor', { recordId })) ?? undefined;
  }
  clearEditor(recordId: string): Promise<void> {
    return this.invoke('clearEditor', { recordId });
  }
  openAttachmentDraft(
    recordId: string,
    scopeId: string,
    revision: number,
    attachments: Attachment[],
  ): Promise<AttachmentDraft> {
    return this.invoke('openAttachmentDraft', { recordId, scopeId, revision, attachments });
  }
  readAttachmentDraft(draftId: string): Promise<AttachmentDraft> {
    return this.invoke('readAttachmentDraft', { draftId });
  }
  saveAttachmentDraft(
    draftId: string,
    revision: number,
    attachments: Attachment[],
  ): Promise<AttachmentDraft> {
    return this.invoke('saveAttachmentDraft', { draftId, revision, attachments });
  }
  discardAttachmentDraft(draftId: string): Promise<void> {
    return this.invoke('discardAttachmentDraft', { draftId });
  }
  submitAttachmentDraft(draftId: string): Promise<CommandOutcome> {
    return this.invoke('submitAttachmentDraft', { draftId });
  }
  acquireAttachmentPhoto(draftId: string, mode: 'camera' | 'gallery'): Promise<void> {
    return this.invoke('acquireAttachmentPhoto', { draftId, mode });
  }
  async addAttachmentPhoto(draftId: string, file: Blob): Promise<AttachmentDraft> {
    if (file.size > 25 * 1024 * 1024) throw new Error('Choose a photo under 25 MB');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(file);
    });
    return this.invoke('addAttachmentPhoto', { draftId, base64, mimeType: file.type });
  }
  storage(): Promise<StorageUsage> {
    return this.invoke('storage');
  }
  localStorage(): Promise<{ databaseBytes: number; mediaBytes: number; sampledAt: number }> {
    return this.invoke('localStorage');
  }
  backups(): Promise<BackupStatus> {
    return this.invoke('backups');
  }
  createBackup(): Promise<void> {
    return this.invoke('createBackup');
  }
  acquirePhoto(draftId: string, mode: 'camera' | 'gallery'): Promise<void> {
    return this.invoke('acquirePhoto', { draftId, mode });
  }
  dictate(category: EntryCategory = 'inbox'): Promise<void> {
    return this.invoke('dictate', { category });
  }
  recoverDraft(draftId: string): Promise<Draft | null> {
    return this.invoke('recoverDraft', { draftId });
  }
  reconcileEdits(): Promise<void> {
    return this.invoke('reconcileEdits');
  }
}
