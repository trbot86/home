import { useEffect, useRef, useState } from 'react';
import type { AttachmentDraft, ClientPlatform } from '@our-place/client';
import type { Attachment, CommandOutcome } from '@our-place/contracts';
import { AttachmentGallery } from './AttachmentGallery.js';
import { RecordDialog } from './RecordDialog.js';
import { Icon } from './Icon.js';

export type AttachmentSaved = (recordId: string, outcome: CommandOutcome, label: string) => void;
export type AttachmentTarget = {
  recordId: string;
  scopeId: string;
  revision: number;
  attachments?: Attachment[];
  deletedAt: number | null;
};

function Caption({
  photo,
  index,
  disabled,
  change,
}: {
  photo: Attachment;
  index: number;
  disabled: boolean;
  change: (text: string) => void;
}) {
  const [text, setText] = useState(photo.caption ?? '');
  return (
    <label className="attachment-caption">
      Caption
      <textarea
        aria-label={`Caption for photo ${index + 1}`}
        value={text}
        rows={2}
        maxLength={1000}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          change(event.target.value);
        }}
      />
    </label>
  );
}

/** A durable device draft is frozen before uploads. Closing never discards it. */
export function AttachmentDialog({
  client,
  target,
  title,
  online,
  serverEpoch,
  pending,
  close,
  onSaved,
}: {
  client: ClientPlatform;
  target: AttachmentTarget;
  title: string;
  online: boolean;
  serverEpoch: string;
  pending: boolean;
  close: () => void;
  onSaved: AttachmentSaved;
}) {
  const [draft, setDraft] = useState<AttachmentDraft | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const current = useRef<AttachmentDraft | null>(null),
    queue = useRef(Promise.resolve()),
    failed = useRef(false),
    lock = useRef(false),
    alive = useRef(true);
  const input = useRef<HTMLInputElement>(null),
    writes = useRef(0);
  const accept = (next: AttachmentDraft) => {
    current.current = next;
    if (alive.current) setDraft(next);
  };
  const report = (reason: unknown) => {
    if (alive.current)
      setError((reason instanceof Error ? reason.message : String(reason)).replaceAll('_', ' '));
  };
  useEffect(() => {
    alive.current = true;
    void client
      .openAttachmentDraft(target.recordId, target.scopeId, target.revision, target.attachments ?? [])
      .then(accept)
      .catch(report);
    const unsubscribe = client.subscribe(() => {
      const before = current.current;
      if (!before || lock.current || writes.current) return;
      void client
        .readAttachmentDraft(before.draftId)
        .then((next) => {
          if (current.current === before && !lock.current && !writes.current) accept(next);
        })
        .catch(report);
    });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [client, target.recordId]);
  const changed =
    !!draft &&
    (draft.baseRevision !== target.revision ||
      draft.serverEpoch !== serverEpoch ||
      target.deletedAt !== null);
  const editable = !!draft && draft.state === 'DRAFT' && online && !changed && !pending && !busy;
  function edit(transform: (photos: Attachment[]) => Attachment[]) {
    if (!editable || lock.current) return;
    writes.current++;
    queue.current = queue.current
      .then(async () => {
        const value = current.current!;
        accept(await client.saveAttachmentDraft(value.draftId, value.revision, transform(value.attachments)));
        failed.current = false;
      })
      .catch((reason) => {
        failed.current = true;
        report(reason);
      })
      .finally(() => {
        writes.current--;
      });
  }
  async function work(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await queue.current;
      if (failed.current)
        throw new Error('A local edit could not be saved. Please retry that edit before continuing.');
      await action();
    } catch (reason) {
      report(reason);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function finish(value: AttachmentDraft) {
    // Keep the originals until the server's current state has been fetched.
    await client.refresh();
    if (value.outcome) onSaved(target.recordId, value.outcome, 'Photos updated');
    await client.discardAttachmentDraft(value.draftId);
    close();
  }
  async function submit() {
    await work(async () => {
      const value = current.current!;
      if (value.state === 'ACKNOWLEDGED') {
        await finish(value);
        return;
      }
      if (!online || value.state === 'REJECTED' || (value.state === 'DRAFT' && (changed || pending))) return;
      try {
        await client.submitAttachmentDraft(value.draftId);
      } finally {
        accept(await client.readAttachmentDraft(value.draftId));
      }
      const next = current.current!;
      if (next.state === 'ACKNOWLEDGED') await finish(next);
      else if (next.outcome?.status === 'Rejected') report(next.outcome.code);
    });
  }
  async function acquire(mode: 'camera' | 'gallery') {
    await work(async () => {
      await client.acquireAttachmentPhoto!(current.current!.draftId, mode);
      accept(await client.readAttachmentDraft(current.current!.draftId));
    });
  }
  const canSave =
    !!draft &&
    online &&
    (draft.state === 'ACKNOWLEDGED' ||
      draft.state === 'SUBMITTED' ||
      (draft.state === 'DRAFT' && !changed && !pending));
  return (
    <RecordDialog
      client={client}
      title="Photos & receipts"
      subtitle={title}
      className="attachment-dialog"
      close={() => {
        if (!lock.current) void work(async () => close());
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) void submit();
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (canSave && !busy) event.currentTarget.requestSubmit();
          }
        }}
      >
        {error && (
          <p className="notice attachment-error" role="alert">
            {error}
          </p>
        )}
        {!draft ? (
          <p className="fine">Opening your saved photos…</p>
        ) : (
          <>
            <p className="fine">
              {!online
                ? 'Read-only while offline. Your unfinished edits stay on this device.'
                : draft.state === 'SUBMITTED'
                  ? 'Waiting for confirmation. Retry checks the same save; your photos are kept.'
                  : draft.state === 'ACKNOWLEDGED'
                    ? 'The server confirmed this save. Finish to refresh your view.'
                    : draft.state === 'REJECTED'
                      ? 'This save was not applied. Your photos are still here to review.'
                      : 'Add a photo, give it a caption, or arrange it. Unfinished edits stay on this device.'}
            </p>
            {changed && draft.state === 'DRAFT' && (
              <p className="notice">
                This record changed since you started. Your photo edits are kept. Review them before
                discarding and reopening the latest version.
              </p>
            )}
            {draft.outcome?.status === 'Rejected' && (
              <p className="notice">{draft.outcome.code.replaceAll('_', ' ')}</p>
            )}
            <div className="attachment-edits">
              {draft.attachments.map((photo, index) => (
                <article key={photo.attachmentId} className="attachment-edit">
                  <AttachmentGallery client={client} attachments={[photo]} />
                  <div>
                    <Caption
                      key={`${draft.draftId}:${photo.attachmentId}`}
                      photo={photo}
                      index={index}
                      disabled={!editable}
                      change={(text) =>
                        edit((photos) =>
                          photos.map((item) =>
                            item.attachmentId === photo.attachmentId ? { ...item, caption: text } : item,
                          ),
                        )
                      }
                    />
                    <div className="attachment-actions">
                      <button
                        type="button"
                        disabled={!editable || index === 0}
                        aria-label={`Move photo ${index + 1} earlier`}
                        onClick={() =>
                          edit((photos) => {
                            const next = [...photos],
                              at = next.findIndex((item) => item.attachmentId === photo.attachmentId);
                            if (at > 0) [next[at - 1], next[at]] = [next[at]!, next[at - 1]!];
                            return next;
                          })
                        }
                      >
                        Earlier
                      </button>
                      <button
                        type="button"
                        disabled={!editable || index === draft.attachments.length - 1}
                        aria-label={`Move photo ${index + 1} later`}
                        onClick={() =>
                          edit((photos) => {
                            const next = [...photos],
                              at = next.findIndex((item) => item.attachmentId === photo.attachmentId);
                            if (at >= 0 && at < next.length - 1)
                              [next[at], next[at + 1]] = [next[at + 1]!, next[at]!];
                            return next;
                          })
                        }
                      >
                        Later
                      </button>
                      <button
                        type="button"
                        disabled={!editable}
                        aria-label={`Remove photo ${index + 1}`}
                        onClick={() =>
                          edit((photos) => photos.filter((item) => item.attachmentId !== photo.attachmentId))
                        }
                      >
                        <Icon name="trash" size={16} />
                        Remove
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {!draft.attachments.length && (
              <p className="attachment-empty">
                A photo of the label, a receipt, or something worth remembering.
              </p>
            )}
            <div className="attachment-actions">
              {client.acquireAttachmentPhoto ? (
                <>
                  <button
                    type="button"
                    disabled={!editable || draft.attachments.length >= 20}
                    onClick={() => void acquire('camera')}
                  >
                    Take photo
                  </button>
                  <button
                    type="button"
                    disabled={!editable || draft.attachments.length >= 20}
                    onClick={() => void acquire('gallery')}
                  >
                    Choose photo
                  </button>
                </>
              ) : (
                <>
                  <input
                    ref={input}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    hidden
                    onChange={(event) => {
                      const files = [...(event.target.files ?? [])];
                      event.target.value = '';
                      if (editable)
                        void work(async () => {
                          for (const file of files)
                            accept(await client.addAttachmentPhoto(current.current!.draftId, file));
                        });
                    }}
                  />
                  <button
                    type="button"
                    disabled={!editable || draft.attachments.length >= 20}
                    onClick={() => input.current?.click()}
                  >
                    <Icon name="plus" size={16} />
                    Add photos
                  </button>
                </>
              )}
              <span className="fine">{draft.attachments.length}/20 · up to 25 MB each</span>
            </div>
            <div className="dialog-footer">
              {draft.state !== 'SUBMITTED' && draft.state !== 'ACKNOWLEDGED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await client.discardAttachmentDraft(current.current!.draftId);
                      close();
                    })
                  }
                >
                  Discard photo edits
                </button>
              )}
              <button className="primary" disabled={busy || !canSave}>
                {busy
                  ? 'Saving…'
                  : draft.state === 'ACKNOWLEDGED'
                    ? 'Finish'
                    : draft.state === 'SUBMITTED'
                      ? 'Retry save'
                      : 'Save photos'}
              </button>
            </div>
          </>
        )}
      </form>
    </RecordDialog>
  );
}
