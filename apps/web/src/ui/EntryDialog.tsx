import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { CommandKind, HistoryEntry, InboxEntry } from '@our-place/contracts';
import { Icon } from './Icon.js';
import { Photo } from './Photo.js';
import { date } from './format.js';

export function EntryDialog({
  client,
  serverEpoch,
  entry,
  startHistory,
  online,
  pending,
  close,
  run,
  onError,
}: {
  client: ClientPlatform;
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
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(entry.text);
  const [baseRevision, setBaseRevision] = useState(entry.revision);
  const [baseEpoch, setBaseEpoch] = useState(serverEpoch);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [tab, setTab] = useState(startHistory ? 'history' : 'edit');
  const [busy, setBusy] = useState(false);
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
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="dialog-header">
        <div>
          <p className="eyebrow">Saved {date(entry.createdAt)}</p>
          <h2 id="entry-title">A closer look</h2>
        </div>
        <button aria-label="Close entry" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="tabs dialog-tabs">
        <button className={tab === 'edit' ? 'active' : ''} onClick={() => setTab('edit')}>
          Entry
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <Icon name="clock" size={15} />
          History
        </button>
      </div>
      {tab === 'edit' ? (
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
          {entry.attachments.length > 0 && (
            <div className="detail-photos">
              {entry.attachments.map((a) => (
                <Photo key={a.mediaId} client={client} id={a.mediaId} />
              ))}
            </div>
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
                  {item.kind === 'CreateInboxEntry'
                    ? 'Saved this entry'
                    : item.kind === 'SetInboxEntryText'
                      ? 'Changed the text'
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
                <p className="historical-text">{item.version.text || 'Photo entry'}</p>
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
    </dialog>
  );
}
