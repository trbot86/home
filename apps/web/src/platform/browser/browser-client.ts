import type { ClientPlatform, ClientState, Draft, StorageUsage } from '@our-place/client';
import type {
  Attachment,
  AuthenticationOptions,
  BackupStatus,
  CommandKind,
  CommandOutcome,
  Envelope,
  EntryCategory,
  HistoryEntry,
  InboxEntry,
  Session,
  ShoppingRecord,
  ShoppingSnapshot,
  TaskSnapshot,
} from '@our-place/contracts';
import { categoryOf, emptyShopping, emptyTasks, isValid, OutcomeSchema } from '@our-place/contracts';
import { localDatabase, localKey, digest, type Attempt } from './database.js';
import { AttachmentDraftStore } from './attachment-drafts.js';

export class ClientError extends Error {
  constructor(public readonly code: string) {
    super(code.replaceAll('_', ' '));
  }
}
export class BrowserClient implements ClientPlatform {
  private readonly attachmentDrafts = new AttachmentDraftStore();
  private session: Session | null = null;
  private online = navigator.onLine;
  private recoveryRequired = false;
  private readonly listeners = new Set<() => void>();
  private readonly urls = new Map<string, string>();
  private syncing: Promise<void> | null = null;
  private refreshSequence = 0;
  private switchingProfile = false;
  private async request<T>(
    path: string,
    init: RequestInit = {},
    clientId = this.session?.clientId,
  ): Promise<T> {
    let response: Response;
    const headers = new Headers(init.headers);
    if (clientId) headers.set('x-client-id', clientId);
    try {
      response = await fetch(`/api${path}`, { credentials: 'same-origin', ...init, headers });
    } catch {
      this.online = false;
      this.changed();
      throw new ClientError('server_unreachable');
    }
    this.online = true;
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({ code: 'request_failed' }))) as { code?: string };
      throw new ClientError(problem.code ?? 'request_failed');
    }
    return (await response.json()) as T;
  }
  private post<T>(path: string, payload: unknown, clientId = this.session?.clientId): Promise<T> {
    return this.request(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) },
      clientId,
    );
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private requireSession(): Session {
    if (!this.session) throw new ClientError('sign_in_required');
    return this.session;
  }
  async state(): Promise<ClientState> {
    const db = await localDatabase;
    if (!this.session) {
      const username = await db.get('meta', 'activeProfile');
      if (typeof username === 'string') this.session = (await db.get('profiles', username)) ?? null;
    }
    const session = this.session;
    const cache = session ? await db.get('cache', session.clientId) : undefined;
    return {
      session,
      entries: cache?.entries ?? [],
      shopping: cache?.shopping ?? emptyShopping(),
      tasks: cache?.tasks ?? emptyTasks(),
      drafts: session
        ? (await db.getAll('drafts')).filter((d) => d.clientId === session.clientId && !d.settled)
        : [],
      online: this.online && navigator.onLine,
      sampledAt: cache?.sampledAt ?? null,
      pendingEdits: session
        ? (await db.getAll('attempts'))
            .filter((a) => a.clientId === session.clientId && !a.outcome)
            .map((a) => a.recordId)
        : [],
      recoveryRequired: this.recoveryRequired,
    };
  }
  authenticationOptions(): Promise<AuthenticationOptions> {
    return this.request('/auth/options');
  }
  async login(username: string, password: string): Promise<Session> {
    if (this.switchingProfile) throw new ClientError('profile_switch_in_progress');
    this.switchingProfile = true;
    try {
      // Finish the old cookie-authenticated drain before replacing its session.
      await this.syncing?.catch(() => {});
      const db = await localDatabase;
      const key = username.trim().toLowerCase();
      const previous = await db.get('profiles', key);
      const session = await this.post<Session>('/auth/login', {
        username: key,
        ...(password ? { password } : {}),
        clientKind: 'browser',
        ...(previous ? { clientId: previous.clientId } : {}),
      });
      await db.put('profiles', session, key);
      await db.put('meta', key, 'activeProfile');
      this.refreshSequence++;
      this.session = session;
      this.recoveryRequired = false;
      for (const url of this.urls.values()) URL.revokeObjectURL(url);
      this.urls.clear();
      // The profile was selected even if the follow-up cache refresh loses the network.
      try {
        await this.refresh();
      } finally {
        this.changed();
      }
      return session;
    } finally {
      this.switchingProfile = false;
    }
  }
  async logout(): Promise<void> {
    try {
      await this.post('/auth/logout', {});
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== 'authentication_required') throw error;
    }
    const db = await localDatabase;
    await db.delete('meta', 'activeProfile');
    this.session = null;
    this.refreshSequence++;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.changed();
  }
  async refresh(): Promise<void> {
    const existing = this.requireSession();
    const db = await localDatabase;
    const sequence = ++this.refreshSequence;
    const generationKey = localKey(existing.clientId, 'generation');
    const generation = Number((await db.get('meta', generationKey)) ?? 0);
    const current = await this.request<Session>('/session');
    if (current.clientId !== existing.clientId || this.session?.clientId !== existing.clientId)
      throw new ClientError('session_changed');
    const cache = await this.request<{
      entries: InboxEntry[];
      shopping?: ShoppingSnapshot;
      tasks?: TaskSnapshot;
      sampledAt: number;
      serverEpoch: string;
    }>('/cache/inbox');
    if (cache.serverEpoch !== current.serverEpoch) throw new ClientError('server_changed_try_again');
    if (sequence !== this.refreshSequence || this.session?.clientId !== existing.clientId) return;
    if (current.serverEpoch !== existing.serverEpoch) this.recoveryRequired = true;
    const tx = db.transaction(['cache', 'meta', 'profiles', 'drafts', 'media'], 'readwrite');
    if (Number((await tx.objectStore('meta').get(generationKey)) ?? 0) !== generation) {
      await tx.done;
      return;
    }
    if (current.serverEpoch !== existing.serverEpoch) {
      const previous = await tx.objectStore('cache').get(existing.clientId);
      if (previous)
        await tx
          .objectStore('cache')
          .put(previous, localKey(existing.clientId, `recovery:${existing.serverEpoch}`));
    }
    await tx.objectStore('cache').put(cache, existing.clientId);
    await tx.objectStore('meta').put(generation + 1, generationKey);
    const username = await tx.objectStore('meta').get('activeProfile');
    if (typeof username === 'string') await tx.objectStore('profiles').put(current, username);
    for (const draft of await tx.objectStore('drafts').getAll())
      if (
        draft.clientId === existing.clientId &&
        draft.state === 'ACKNOWLEDGED' &&
        cache.entries.some((e) => e.inboxId === draft.draftId)
      ) {
        draft.settled = true;
        await tx.objectStore('drafts').put(draft, draft.draftId);
        for (const attachment of draft.attachments) {
          const key = localKey(existing.clientId, attachment.mediaId);
          await tx.objectStore('media').delete(key);
          const url = this.urls.get(key);
          if (url) URL.revokeObjectURL(url);
          this.urls.delete(key);
        }
      }
    await tx.done;
    if (this.session?.clientId === existing.clientId) this.session = current;
    this.changed();
  }
  async createDraft(scopeId: string, category: EntryCategory = 'inbox'): Promise<Draft> {
    const draft: Draft = {
      draftId: crypto.randomUUID(),
      clientId: this.requireSession().clientId,
      scopeId,
      category,
      text: '',
      createdAt: Date.now(),
      revision: 1,
      state: 'DRAFT',
      attachments: [],
    };
    await (await localDatabase).put('drafts', draft, draft.draftId);
    this.changed();
    return draft;
  }
  private async changeDraft(id: string, change: (draft: Draft) => void): Promise<Draft> {
    const clientId = this.requireSession().clientId;
    const db = await localDatabase;
    const tx = db.transaction('drafts', 'readwrite');
    const draft = await tx.store.get(id);
    if (!draft || draft.clientId !== clientId || draft.state !== 'DRAFT') {
      await tx.done;
      throw new ClientError('draft_locked');
    }
    change(draft);
    draft.revision++;
    await tx.store.put(draft, id);
    await tx.done;
    this.changed();
    return draft;
  }
  saveDraft(id: string, text: string, scopeId: string): Promise<Draft> {
    return this.changeDraft(id, (draft) => {
      draft.text = text;
      draft.scopeId = scopeId;
    });
  }
  async discardDraft(id: string): Promise<void> {
    const db = await localDatabase;
    const tx = db.transaction(['drafts', 'media'], 'readwrite');
    const draft = await tx.objectStore('drafts').get(id);
    if (!draft || draft.clientId !== this.requireSession().clientId || draft.state !== 'DRAFT') {
      await tx.done;
      throw new ClientError('draft_locked');
    }
    for (const attachment of draft.attachments)
      await tx.objectStore('media').delete(localKey(draft.clientId, attachment.mediaId));
    await tx.objectStore('drafts').delete(id);
    await tx.done;
    this.changed();
  }
  async addPhoto(id: string, file: Blob): Promise<Draft> {
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 25 * 1024 * 1024 ||
      file.size === 0
    )
      throw new ClientError('choose_a_jpeg_png_or_webp_under_25_mb');
    const mediaId = crypto.randomUUID();
    const clientId = this.requireSession().clientId;
    const hash = await digest(await file.arrayBuffer());
    const db = await localDatabase;
    const tx = db.transaction(['drafts', 'media'], 'readwrite');
    const draft = await tx.objectStore('drafts').get(id);
    if (!draft || draft.clientId !== clientId || draft.state !== 'DRAFT' || draft.attachments.length >= 20) {
      await tx.done;
      throw new ClientError('draft_locked_or_full');
    }
    const attachment: Attachment = {
      attachmentId: crypto.randomUUID(),
      mediaId,
      digest: hash,
      byteLength: file.size,
      mimeType: file.type as Attachment['mimeType'],
      position: draft.attachments.length,
    };
    await tx.objectStore('media').put({ clientId, mediaId, bytes: file }, localKey(clientId, mediaId));
    draft.attachments.push(attachment);
    draft.revision++;
    await tx.objectStore('drafts').put(draft, id);
    await tx.done;
    this.changed();
    return draft;
  }
  async removePhoto(id: string, mediaId: string): Promise<Draft> {
    const draft = await this.changeDraft(id, (draft) => {
      draft.attachments = draft.attachments
        .filter((a) => a.mediaId !== mediaId)
        .map((a, position) => ({ ...a, position }));
    });
    await (await localDatabase).delete('media', localKey(draft.clientId, mediaId));
    return draft;
  }
  async photoUrl(id: string): Promise<string> {
    const key = localKey(this.requireSession().clientId, id);
    const local = await (await localDatabase).get('media', key);
    if (!local) return `/api/media/${encodeURIComponent(id)}`;
    let url = this.urls.get(key);
    if (!url) {
      url = URL.createObjectURL(local.bytes);
      this.urls.set(key, url);
    }
    return url;
  }
  async submitDraft(id: string): Promise<void> {
    const db = await localDatabase;
    const session = this.requireSession();
    const draft = await db.get('drafts', id);
    if (!draft || draft.clientId !== session.clientId) throw new ClientError('draft_unavailable');
    if (draft.state !== 'DRAFT') {
      await this.sync();
      return;
    }
    if (!draft.text.trim() && !draft.attachments.length) throw new ClientError('add_text_or_a_photo');
    const command: Envelope = {
      operationId: crypto.randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: {
        inboxId: draft.draftId,
        scopeId: draft.scopeId,
        category: categoryOf(draft),
        text: draft.text,
        capturedAt: draft.createdAt,
        source: { kind: draft.text.trim() ? 'typed' : 'photo' },
        attachments: draft.attachments,
      },
    };
    const frozenJson = JSON.stringify(command);
    const frozenHash = await digest(frozenJson);
    const tx = db.transaction('drafts', 'readwrite');
    const current = await tx.store.get(id);
    if (!current || current.state !== 'DRAFT' || current.revision !== draft.revision) {
      await tx.done;
      throw new ClientError('draft_changed_try_again');
    }
    Object.assign(current, { state: 'SUBMITTED', frozenJson, frozenHash });
    await tx.store.put(current, id);
    await tx.done;
    this.changed();
    void this.sync().catch(() => {});
  }
  async copyRejectedDraft(id: string): Promise<Draft> {
    const db = await localDatabase;
    const original = await db.get('drafts', id);
    if (!original || original.clientId !== this.requireSession().clientId || original.state !== 'REJECTED')
      throw new ClientError('draft_unavailable');
    const draft = await this.createDraft(original.scopeId, categoryOf(original));
    await this.saveDraft(draft.draftId, original.text, original.scopeId);
    for (const attachment of original.attachments) {
      const media = await db.get('media', localKey(original.clientId, attachment.mediaId));
      if (media) await this.addPhoto(draft.draftId, media.bytes);
    }
    original.settled = true;
    await db.put('drafts', original, id);
    return (await db.get('drafts', draft.draftId))!;
  }
  private async send(kind: CommandKind, frozenJson: string, clientId: string): Promise<CommandOutcome> {
    const outcome = await this.request<CommandOutcome>(
      `/commands/${kind}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: frozenJson },
      clientId,
    );
    this.validateOutcome(outcome, (JSON.parse(frozenJson) as Envelope).operationId);
    if (outcome.status === 'RecoveryRequired') this.recoveryRequired = true;
    return outcome;
  }
  private validateOutcome(outcome: unknown, operationId: string): asserts outcome is CommandOutcome {
    if (
      !isValid(OutcomeSchema, outcome) ||
      ('receipt' in outcome && outcome.receipt.operationId !== operationId)
    )
      throw new ClientError('invalid_server_response');
  }
  async sync(): Promise<void> {
    if (this.switchingProfile) return;
    if (this.syncing) return this.syncing;
    this.syncing = this.drain();
    try {
      await this.syncing;
    } finally {
      this.syncing = null;
      this.changed();
    }
  }
  private async drain(): Promise<void> {
    if (!navigator.onLine || !this.session) {
      this.online = false;
      return;
    }
    const session = this.requireSession();
    const db = await localDatabase;
    for (const draft of (await db.getAll('drafts')).filter(
      (d) => d.clientId === session.clientId && d.state === 'SUBMITTED',
    )) {
      if (!draft.frozenJson || (await digest(draft.frozenJson)) !== draft.frozenHash)
        throw new ClientError('local_capture_integrity_error');
      const command = JSON.parse(draft.frozenJson) as Envelope;
      // Resolve first: accepted/deleted content must not republish media on a lost reply.
      const resolved = await this.request<CommandOutcome | { status: 'Unresolved' }>(
        `/operations/${command.operationId}?epoch=${command.expectedServerEpoch}`,
        {},
        session.clientId,
      );
      let outcome: CommandOutcome;
      if (resolved.status === 'Unresolved') {
        await this.uploadPhotos(
          session.clientId,
          draft.scopeId,
          draft.attachments,
          command.expectedServerEpoch,
        );
        outcome = await this.send('CreateInboxEntry', draft.frozenJson, session.clientId);
      } else {
        this.validateOutcome(resolved, command.operationId);
        outcome = resolved;
      }
      if (outcome.status === 'Applied' || outcome.status === 'Rejected') {
        draft.outcome = outcome;
        draft.state = outcome.status === 'Applied' ? 'ACKNOWLEDGED' : 'REJECTED';
        const tx = db.transaction(['drafts', 'meta'], 'readwrite');
        const key = localKey(session.clientId, 'generation');
        await tx.objectStore('drafts').put(draft, draft.draftId);
        await tx.objectStore('meta').put(Number((await tx.objectStore('meta').get(key)) ?? 0) + 1, key);
        await tx.done;
      } else if (outcome.status === 'RecoveryRequired') {
        this.recoveryRequired = true;
        break;
      }
    }
    for (const attempt of (await db.getAll('attempts')).filter(
      (a) => a.clientId === session.clientId && !a.outcome,
    ))
      await this.resolveAttempt(attempt);
    await this.refresh();
  }
  private async bumpGeneration(clientId: string): Promise<void> {
    const db = await localDatabase;
    const tx = db.transaction('meta', 'readwrite');
    const key = localKey(clientId, 'generation');
    await tx.store.put(Number((await tx.store.get(key)) ?? 0) + 1, key);
    await tx.done;
  }
  private async resolveAttempt(attempt: Attempt): Promise<CommandOutcome> {
    const current = await (await localDatabase).get('attempts', attempt.key);
    if (current?.frozenJson === attempt.frozenJson && current.outcome) return current.outcome;
    const command = JSON.parse(attempt.frozenJson) as Envelope;
    let outcome: CommandOutcome;
    if (attempt.uploads) {
      const resolved = await this.request<CommandOutcome | { status: 'Unresolved' }>(
        `/operations/${command.operationId}?epoch=${command.expectedServerEpoch}`,
        {},
        attempt.clientId,
      );
      if (resolved.status === 'Unresolved') {
        await this.uploadPhotos(
          attempt.clientId,
          attempt.uploads.scopeId,
          attempt.uploads.attachments,
          command.expectedServerEpoch,
        );
        outcome = await this.send(attempt.kind, attempt.frozenJson, attempt.clientId);
      } else {
        this.validateOutcome(resolved, command.operationId);
        outcome = resolved;
      }
    } else outcome = await this.send(attempt.kind, attempt.frozenJson, attempt.clientId);
    if (outcome.status === 'RecoveryRequired') this.recoveryRequired = true;
    await this.finaliseAttempt(attempt, outcome);
    this.changed();
    return outcome;
  }
  private async finaliseAttempt(attempt: Attempt, outcome: CommandOutcome): Promise<void> {
    if (outcome.status === 'Applied' || outcome.status === 'Rejected') {
      const db = await localDatabase;
      const tx = db.transaction(['attempts', 'meta', 'attachmentDrafts'], 'readwrite');
      // A foreground retry and background drain may finish in either order. Never
      // overwrite a newer request or revisit a draft already settled by the UI.
      const current = await tx.objectStore('attempts').get(attempt.key);
      if (!current || current.frozenJson !== attempt.frozenJson || current.outcome) {
        await tx.done;
        return;
      }
      const key = localKey(attempt.clientId, 'generation');
      if (attempt.attachmentDraftId) {
        const draft = await tx.objectStore('attachmentDrafts').get(attempt.attachmentDraftId);
        if (
          !draft ||
          draft.clientId !== attempt.clientId ||
          draft.operationId !== (JSON.parse(attempt.frozenJson) as Envelope).operationId
        ) {
          tx.abort();
          await tx.done.catch(() => {});
          throw new Error('attachment_request_mismatch');
        }
        draft.state = outcome.status === 'Applied' ? 'ACKNOWLEDGED' : 'REJECTED';
        draft.outcome = outcome;
        await tx.objectStore('attachmentDrafts').put(draft, draft.draftId);
      }
      await tx.objectStore('attempts').put({ ...current, outcome }, attempt.key);
      await tx.objectStore('meta').put(Number((await tx.objectStore('meta').get(key)) ?? 0) + 1, key);
      await tx.done;
    }
  }
  private async uploadPhotos(
    clientId: string,
    scopeId: string,
    attachments: Attachment[],
    epoch: string,
  ): Promise<void> {
    const db = await localDatabase;
    for (const attachment of attachments) {
      const status = await this.post<{ state: string }>(
        `/media/${attachment.mediaId}/prepare`,
        {
          scopeId,
          expectedServerEpoch: epoch,
          digest: attachment.digest,
          byteLength: attachment.byteLength,
          mimeType: attachment.mimeType,
        },
        clientId,
      );
      if (status.state !== 'ready') {
        const local = await db.get('media', localKey(clientId, attachment.mediaId));
        if (
          !local ||
          local.bytes.size !== attachment.byteLength ||
          (await digest(await local.bytes.arrayBuffer())) !== attachment.digest
        )
          throw new ClientError('pending_photo_integrity_error');
        await this.request(
          `/media/${attachment.mediaId}/bytes`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream', 'x-server-epoch': epoch },
            body: local.bytes,
          },
          clientId,
        );
      }
    }
  }
  async openAttachmentDraft(recordId: string, scopeId: string, revision: number, attachments: Attachment[]) {
    return this.attachmentDrafts.open(this.requireSession(), recordId, scopeId, revision, attachments);
  }
  readAttachmentDraft(draftId: string) {
    return this.attachmentDrafts.read(this.requireSession().clientId, draftId);
  }
  async saveAttachmentDraft(draftId: string, revision: number, attachments: Attachment[]) {
    const result = await this.attachmentDrafts.save(
      this.requireSession().clientId,
      draftId,
      revision,
      attachments,
    );
    this.changed();
    return result;
  }
  async addAttachmentPhoto(draftId: string, file: Blob) {
    const result = await this.attachmentDrafts.addPhoto(this.requireSession().clientId, draftId, file);
    this.changed();
    return result;
  }
  async discardAttachmentDraft(draftId: string): Promise<void> {
    const clientId = this.requireSession().clientId,
      draft = await this.attachmentDrafts.read(clientId, draftId);
    await this.attachmentDrafts.discard(clientId, draftId);
    for (const id of draft.localMediaIds) {
      const key = localKey(clientId, id),
        url = this.urls.get(key);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(key);
    }
    this.changed();
  }
  async submitAttachmentDraft(draftId: string): Promise<CommandOutcome> {
    if (!navigator.onLine || !this.online) throw new ClientError('existing_entries_are_read_only_offline');
    const attempt = await this.attachmentDrafts.freeze(this.requireSession(), draftId);
    this.changed();
    const outcome = await this.resolveAttempt(attempt);
    await this.refresh();
    return outcome;
  }
  async command(
    recordId: string,
    kind: CommandKind,
    args: unknown,
    expectedServerEpoch: string,
  ): Promise<CommandOutcome> {
    if (!navigator.onLine || !this.online) throw new ClientError('existing_entries_are_read_only_offline');
    const session = this.requireSession();
    const db = await localDatabase;
    const tx = db.transaction('attempts', 'readwrite');
    const key = localKey(session.clientId, recordId);
    let attempt = await tx.store.get(key);
    if (attempt && !attempt.outcome) {
      await tx.done;
      throw new ClientError('previous_save_awaits_acknowledgement');
    }
    attempt = {
      key,
      clientId: session.clientId,
      recordId,
      kind,
      frozenJson: JSON.stringify({
        operationId: crypto.randomUUID(),
        contractVersion: 1,
        expectedServerEpoch,
        arguments: args,
      }),
    };
    await tx.store.put(attempt, key);
    await tx.done;
    this.changed();
    const outcome = await this.resolveAttempt(attempt);
    await this.refresh();
    return outcome;
  }
  async history(id: string): Promise<HistoryEntry[]> {
    return (await this.request<{ entries: HistoryEntry[] }>(`/inbox/${id}/history`)).entries;
  }
  async shoppingHistory(id: string): Promise<HistoryEntry<ShoppingRecord>[]> {
    return (await this.request<{ entries: HistoryEntry<ShoppingRecord>[] }>(`/shopping/${id}/history`))
      .entries;
  }
  async recordHistory<Version>(id: string): Promise<HistoryEntry<Version>[]> {
    return (await this.request<{ entries: HistoryEntry<Version>[] }>(`/records/${id}/history`)).entries;
  }
  async saveEditor(id: string, text: string, baseRevision: number, serverEpoch: string): Promise<void> {
    await (
      await localDatabase
    ).put('editors', { text, baseRevision, serverEpoch }, localKey(this.requireSession().clientId, id));
  }
  async readEditor(id: string) {
    return (await localDatabase).get('editors', localKey(this.requireSession().clientId, id));
  }
  async clearEditor(id: string): Promise<void> {
    await (await localDatabase).delete('editors', localKey(this.requireSession().clientId, id));
  }
  storage(): Promise<StorageUsage> {
    return this.request('/storage');
  }
  backups(): Promise<BackupStatus> {
    return this.request('/backups');
  }
  async createBackup(): Promise<void> {
    await this.post('/backups', {});
  }
  async recoverDraft(id: string): Promise<Draft | null> {
    const db = await localDatabase;
    const session = this.requireSession();
    const draft = await db.get('drafts', id);
    if (
      !draft ||
      draft.clientId !== session.clientId ||
      draft.state !== 'SUBMITTED' ||
      !draft.frozenJson ||
      (await digest(draft.frozenJson)) !== draft.frozenHash
    )
      throw new ClientError('draft_unavailable');
    const command = JSON.parse(draft.frozenJson) as Envelope;
    const outcome = await this.post<CommandOutcome>(
      '/recovery/abandon',
      { kind: 'CreateInboxEntry', command },
      session.clientId,
    );
    this.validateOutcome(outcome, command.operationId);
    if (outcome.status !== 'Applied' && outcome.status !== 'Rejected')
      throw new ClientError('recovery_not_final');
    draft.state = outcome.status === 'Applied' ? 'ACKNOWLEDGED' : 'REJECTED';
    draft.outcome = outcome;
    const tx = db.transaction(['drafts', 'meta'], 'readwrite');
    await tx.objectStore('drafts').put(draft, id);
    const key = localKey(session.clientId, 'generation');
    await tx.objectStore('meta').put(Number((await tx.objectStore('meta').get(key)) ?? 0) + 1, key);
    await tx.done;
    await this.refresh();
    this.changed();
    return outcome.status === 'Rejected' ? this.copyRejectedDraft(id) : null;
  }
  async reconcileEdits(): Promise<void> {
    const db = await localDatabase;
    const session = this.requireSession();
    for (const attempt of (await db.getAll('attempts')).filter(
      (item) => item.clientId === session.clientId && !item.outcome,
    )) {
      const command = JSON.parse(attempt.frozenJson) as Envelope;
      if (command.expectedServerEpoch === session.serverEpoch) continue;
      const outcome = await this.post<CommandOutcome>(
        '/recovery/abandon',
        { kind: attempt.kind, command },
        session.clientId,
      );
      this.validateOutcome(outcome, command.operationId);
      await this.finaliseAttempt(attempt, outcome);
    }
    await this.bumpGeneration(session.clientId);
    await this.refresh();
    this.changed();
  }
}
