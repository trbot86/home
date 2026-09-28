import { ShareRecord } from './ShareRecord.js';
import { isDialogBackdropClick } from './dialog-backdrop.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { CommandKind, HistoryEntry, InboxEntry } from '@our-place/contracts';
import { Icon } from './Icon.js';
import { AttachmentGallery } from './AttachmentGallery.js';
import { AttachmentDialog, type AttachmentSaved } from './AttachmentDialog.js';
import { date } from './format.js';
import { LinkedText } from './LinkedText.js';
import { textLinks } from './text-links.js';
import { CopyNoteLink } from './NoteLinks.js';
import { SuggestionDiscussion } from './suggestions/SuggestionDiscussion.js';

export function EntryDialog({
  client,
  state,
  serverEpoch,
  entry,
  startHistory,
  online,
  pending,
  close,
  run,
  onError,
  onPhotosSaved,
}: {
  client: ClientPlatform;
  state: ClientState;
  serverEpoch: string;
  entry: InboxEntry;
  startHistory: boolean;
  online: boolean;
  pending: boolean;
  close: () => void;
  run: (
    entry: InboxEntry,
    kind: CommandKind,
    args: unknown,
    label: string,
    expectedServerEpoch?: string,
  ) => Promise<unknown>;
  onError: (error: unknown) => void;
  onPhotosSaved: AttachmentSaved;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(entry.text);
  const [baseRevision, setBaseRevision] = useState(entry.revision);
  const [baseEpoch, setBaseEpoch] = useState(serverEpoch);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const hasDiscussion =
    entry.category === 'app_suggestion' ||
    state.suggestions.workflows.some((w) => w.suggestionId === entry.inboxId);
  const [tab, setTab] = useState(startHistory ? 'history' : hasDiscussion ? 'discussion' : 'edit');
  const [busy, setBusy] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const links = [
    ...new Map(
      textLinks(text)
        .filter((part) => part.href)
        .map((part) => [part.href, part]),
    ).values(),
  ];
  useEffect(() => {
    dialog.current?.showModal();
    void client
      .readEditor(entry.inboxId)
      .then((saved) => {
        if (saved) {
          setText(saved.text);
          setBaseRevision(saved.baseRevision);
          setBaseEpoch(saved.serverEpoch);
        }
      })
      .catch(onError);
  }, []);
  useEffect(() => {
    if (tab === 'history') void client.history(entry.inboxId).then(setHistory).catch(onError);
  }, [client, entry.inboxId, entry.revision, tab]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || pending || baseEpoch !== serverEpoch) return;
    setBusy(true);
    try {
      await client.saveEditor(entry.inboxId, text, baseRevision, baseEpoch);
      const outcome = (await run(
        entry,
        'SetInboxEntryText',
        { inboxId: entry.inboxId, expectedRevision: baseRevision, text },
        'Entry updated',
        baseEpoch,
      )) as { status?: string } | null;
      if (outcome?.status === 'Applied') {
        await client.clearEditor(entry.inboxId);
        close();
      }
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="entry-dialog"
      aria-labelledby="entry-title"
      onCancel={close}
      onClick={(e) => {
        if (isDialogBackdropClick(e)) close();
      }}
    >
      <ShareRecord
        client={client}
        state={state}
        recordId={entry.inboxId}
        scopeId={entry.scopeId}
        close={close}
      />
      <div className="dialog-header">
        <div>
          <p className="eyebrow">Saved {date(entry.createdAt)}</p>
          <h2 id="entry-title">{hasDiscussion ? 'App suggestion' : 'A closer look'}</h2>
        </div>
        <button aria-label="Close entry" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <CopyNoteLink id={entry.inboxId} />
      <div className="tabs dialog-tabs">
        {hasDiscussion && (
          <button className={tab === 'discussion' ? 'active' : ''} onClick={() => setTab('discussion')}>
            Discussion
          </button>
        )}
        <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
          Entry
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <Icon name="clock" size={15} />
          History
        </button>
      </div>
      {tab === 'discussion' ? (
        <SuggestionDiscussion client={client} state={state} entry={entry} onError={onError} />
      ) : tab === 'edit' ? (
        <form
          onSubmit={(e) => {
            void submit(e);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (online && !pending && !entry.deletedAt) e.currentTarget.requestSubmit();
            }
          }}
        >
          <label className="sr-only" htmlFor="entry-text">
            Entry text
          </label>
          <textarea
            id="entry-text"
            value={text}
            readOnly={!online || pending || entry.deletedAt !== null}
            onChange={(e) => {
              setText(e.target.value);
              void client.saveEditor(entry.inboxId, e.target.value, baseRevision, baseEpoch).catch(onError);
            }}
            rows={8}
            maxLength={20000}
          />
          {(baseRevision !== entry.revision || baseEpoch !== serverEpoch) && (
            <div className="notice">
              <p>This entry changed since your draft began. Your text is kept.</p>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(text).catch(onError);
                }}
              >
                Copy my text
              </button>
              <button
                type="button"
                onClick={() => {
                  setText(entry.text);
                  setBaseRevision(entry.revision);
                  setBaseEpoch(serverEpoch);
                  void client.clearEditor(entry.inboxId).catch(onError);
                }}
              >
                Reload latest
              </button>
            </div>
          )}
          {!!links.length && (
            <div className="entry-links" aria-label="Links in this note">
              <p className="fine">Links in this note</p>
              <ul>
                {links.map((part) => (
                  <li key={part.href}>
                    <LinkedText client={client} text={part.text} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AttachmentGallery client={client} attachments={entry.attachments} />
          {!entry.deletedAt && (
            <button type="button" disabled={busy} onClick={() => setPhotosOpen(true)}>
              Photos & receipts
            </button>
          )}
          <div className="dialog-footer">
            <span className="fine">
              {!online
                ? 'Read-only while offline'
                : pending
                  ? 'Waiting for the previous save to be confirmed'
                  : 'Unfinished text is saved on this device'}
            </span>
            <button
              className="primary"
              disabled={busy || !online || pending || entry.deletedAt !== null || baseEpoch !== serverEpoch}
            >
              {busy ? 'Saving…' : 'Save changes'}
              <Icon name="check" size={17} />
            </button>
          </div>
        </form>
      ) : (
        <div className="history-list">
          {!history.length && (
            <p className="fine">{online ? 'Loading history…' : 'Connect to load history.'}</p>
          )}
          {history.map((item, index) => (
            <article key={item.changeSetId}>
              <div className="history-dot" />
              <div>
                <div className="history-meta">
                  <strong>{item.actor.displayName}</strong>
                  <span>{date(item.recordedAt)}</span>
                  {index === 0 && <span className="scope-badge">Current</span>}
                </div>
                <p className="fine">
                  {item.kind === 'ShareRecords'
                    ? 'Shared with household'
                    : item.kind === 'CreateInboxEntry'
                      ? 'Saved this entry'
                      : item.kind === 'SetInboxEntryText'
                        ? 'Changed the text'
                        : item.kind === 'SetRecordAttachments'
                          ? 'Updated photos'
                          : item.kind === 'SetInboxEntryCategory'
                            ? `Moved to ${item.version.category === 'app_suggestion' ? 'app suggestions' : 'inbox'}`
                            : item.kind === 'DeleteInboxEntry'
                              ? 'Moved to recently deleted'
                              : item.kind === 'UndoChangeSet'
                                ? 'Undid a change'
                                : item.kind === 'RedoChangeSet'
                                  ? 'Redid a change'
                                  : 'Restored this entry'}
                </p>
                <p className="historical-text">
                  <LinkedText client={client} text={item.version.text || 'Photo entry'} />
                </p>
                <AttachmentGallery client={client} attachments={item.version.attachments} />
                <div className="history-actions">
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(item.version.text).catch(onError);
                    }}
                  >
                    Copy text
                  </button>
                  {(item.canUndo || item.canRedo) && (
                    <button
                      disabled={!online || pending}
                      onClick={() => {
                        void run(
                          entry,
                          item.canRedo ? 'RedoChangeSet' : 'UndoChangeSet',
                          { changeSetId: item.changeSetId },
                          item.canRedo ? 'Change redone' : 'Change undone',
                        );
                      }}
                    >
                      {item.canRedo ? 'Redo' : 'Undo this change'}
                    </button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {photosOpen && (
        <AttachmentDialog
          client={client}
          target={{ ...entry, recordId: entry.inboxId }}
          title="Inbox entry"
          serverEpoch={serverEpoch}
          online={online}
          pending={pending}
          close={() => setPhotosOpen(false)}
          onSaved={onPhotosSaved}
        />
      )}
    </dialog>
  );
}
