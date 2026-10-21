import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { Note, HistoryEntry } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { dateWithYear } from '../format.js';

export function NoteHistory({
  client,
  state,
  note,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  note: Note;
  run: RunRecordCommand;
  close: () => void;
  onError: (e: unknown) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry<Note>[]>([]),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .recordHistory<Note>(note.recordId)
        .then((rows) => {
          if (alive) setEntries(rows);
        })
        .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, note.recordId, note.revision, state.online]);
  return (
    <RecordDialog client={client} title="Thought history" subtitle="" close={close} className="task-dialog">
      {!state.online && <p>Connect to read history.</p>}
      <div className="history-list">
        {entries.map((entry) => (
          <article key={entry.changeSetId}>
            <div>
              <p className="fine">
                {entry.actor.displayName} · {dateWithYear(entry.recordedAt)} · Version {entry.afterRevision}
              </p>
              <strong>{entry.version.title}</strong>
              <p className="historical-text">{entry.version.body}</p>
              {entry.version.category && <p>{entry.version.category}</p>}
              <AttachmentGallery client={client} attachments={entry.version.attachments} />
              <div className="history-actions">
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText([entry.version.title, entry.version.body].join('\n\n'))
                      .catch(onError)
                  }
                >
                  Copy text
                </button>
                {(entry.canUndo || entry.canRedo) && (
                  <button
                    disabled={busy || !state.online || state.pendingEdits.includes(note.recordId)}
                    onClick={() => {
                      setBusy(true);
                      void run(
                        note,
                        entry.canRedo ? 'RedoChangeSet' : 'UndoChangeSet',
                        { changeSetId: entry.changeSetId },
                        entry.canRedo ? 'Change redone' : 'Change undone',
                      ).finally(() => setBusy(false));
                    }}
                  >
                    {entry.canRedo ? 'Redo' : 'Undo this change'}
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </RecordDialog>
  );
}
