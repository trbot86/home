import type { AttachmentDraft } from '@our-place/client';
import type { Attachment, Session } from '@our-place/contracts';
import { digest, localDatabase, localKey, type Attempt } from './database.js';

/** Durable local editing; command receipts remain owned by the shared attempt queue. */
export class AttachmentDraftStore {
  async read(clientId: string, draftId: string): Promise<AttachmentDraft> {
    const draft = await (await localDatabase).get('attachmentDrafts', draftId);
    if (!draft || draft.clientId !== clientId) throw new Error('attachment_draft_unavailable');
    return draft;
  }
  async open(session: Session, recordId: string, scopeId: string, baseRevision: number, attachments: Attachment[]): Promise<AttachmentDraft> {
    const db = await localDatabase;
    const tx = db.transaction('attachmentDrafts', 'readwrite');
    const old = (await tx.store.getAll()).find(d => d.clientId === session.clientId && d.recordId === recordId);
    if (old) { await tx.done; return old; }
    if (!session.scopes.some(scope => scope.scopeId === scopeId)) { await tx.done; throw new Error('scope_unavailable'); }
    const draft: AttachmentDraft = { draftId: crypto.randomUUID(), clientId: session.clientId, recordId, scopeId, baseRevision,
      serverEpoch: session.serverEpoch, revision: 1, attachments: structuredClone(attachments), localMediaIds: [], state: 'DRAFT' };
    await tx.store.put(draft, draft.draftId); await tx.done; return draft;
  }
  async save(clientId: string, id: string, revision: number, attachments: Attachment[]): Promise<AttachmentDraft> {
    const db = await localDatabase, tx = db.transaction('attachmentDrafts', 'readwrite');
    const draft = await tx.store.get(id);
    if (!draft || draft.clientId !== clientId || draft.state !== 'DRAFT' || draft.revision !== revision) {
      await tx.done; throw new Error('draft_changed_try_again');
    }
    // Editing never invents or retargets a placement; acquisition owns new media identities.
    if (attachments.length > 20 || new Set(attachments.map(a => a.attachmentId)).size !== attachments.length ||
      attachments.some(a => !draft.attachments.some(old => old.attachmentId === a.attachmentId && old.mediaId === a.mediaId &&
        old.digest === a.digest && old.byteLength === a.byteLength && old.mimeType === a.mimeType) || (a.caption?.length ?? 0) > 1000)) {
      await tx.done; throw new Error('invalid_attachment_edit');
    }
    draft.attachments = attachments.map((a, position) => ({ ...a, position })); draft.revision++;
    // Removed originals remain pinned to this draft until discard or a final receipt.
    await tx.store.put(draft, id); await tx.done; return draft;
  }
  async addPhoto(clientId: string, id: string, file: Blob): Promise<AttachmentDraft> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 25 * 1024 * 1024)
      throw new Error('choose_a_jpeg_png_or_webp_under_25_mb');
    const hash = await digest(await file.arrayBuffer()), mediaId = crypto.randomUUID();
    const db = await localDatabase, tx = db.transaction(['attachmentDrafts', 'media'], 'readwrite');
    const draft = await tx.objectStore('attachmentDrafts').get(id);
    if (!draft || draft.clientId !== clientId || draft.state !== 'DRAFT' || draft.attachments.length >= 20) {
      await tx.done; throw new Error('draft_locked_or_full');
    }
    draft.attachments.push({ attachmentId: crypto.randomUUID(), mediaId, digest: hash, byteLength: file.size,
      mimeType: file.type as Attachment['mimeType'], position: draft.attachments.length });
    draft.localMediaIds.push(mediaId); draft.revision++;
    await tx.objectStore('media').put({ clientId, mediaId, bytes: file }, localKey(clientId, mediaId));
    await tx.objectStore('attachmentDrafts').put(draft, id); await tx.done; return draft;
  }
  async discard(clientId: string, id: string): Promise<void> {
    const db = await localDatabase, tx = db.transaction(['attachmentDrafts', 'media'], 'readwrite');
    const draft = await tx.objectStore('attachmentDrafts').get(id);
    if (!draft || draft.clientId !== clientId || draft.state === 'SUBMITTED') { await tx.done; throw new Error('draft_locked'); }
    for (const mediaId of draft.localMediaIds) await tx.objectStore('media').delete(localKey(clientId, mediaId));
    await tx.objectStore('attachmentDrafts').delete(id); await tx.done;
  }
  async freeze(session: Session, id: string): Promise<Attempt> {
    const db = await localDatabase, tx = db.transaction(['attachmentDrafts', 'attempts'], 'readwrite');
    const draft = await tx.objectStore('attachmentDrafts').get(id);
    if (!draft || draft.clientId !== session.clientId) { await tx.done; throw new Error('attachment_draft_unavailable'); }
    const key = localKey(session.clientId, draft.recordId), existing = await tx.objectStore('attempts').get(key);
    if (draft.state === 'SUBMITTED' && existing?.attachmentDraftId === id && JSON.parse(existing.frozenJson).operationId === draft.operationId) {
      await tx.done; return existing;
    }
    if (draft.state !== 'DRAFT' || (existing && !existing.outcome)) { await tx.done; throw new Error('previous_save_awaits_acknowledgement'); }
    if (draft.serverEpoch !== session.serverEpoch) { await tx.done; throw new Error('recovery_required'); }
    const operationId = crypto.randomUUID();
    const attempt: Attempt = { key, clientId: session.clientId, recordId: draft.recordId, kind: 'SetRecordAttachments', attachmentDraftId: id,
      uploads: { scopeId: draft.scopeId, attachments: draft.attachments.filter(a => draft.localMediaIds.includes(a.mediaId)) },
      frozenJson: JSON.stringify({ operationId, contractVersion: 1, expectedServerEpoch: draft.serverEpoch,
        arguments: { recordId: draft.recordId, expectedRevision: draft.baseRevision, attachments: draft.attachments } }) };
    draft.state = 'SUBMITTED'; draft.operationId = operationId;
    await tx.objectStore('attempts').put(attempt, key); await tx.objectStore('attachmentDrafts').put(draft, id); await tx.done; return attempt;
  }
}
