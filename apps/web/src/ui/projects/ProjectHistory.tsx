import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { HistoryEntry, ProjectRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { dateWithYear } from '../format.js';

function text(record: ProjectRecord) {
  return [
    record.title,
    record.kind === 'project'
      ? record.description
      : record.blocks
          .map((b) =>
            b.kind === 'text'
              ? b.text
              : b.kind === 'web_link'
                ? [b.title, b.url, b.notes].filter(Boolean).join('\n')
                : b.kind === 'record_link'
                  ? b.caption
                  : '',
          )
          .filter(Boolean)
          .join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}
export function ProjectHistory({
  client,
  state,
  record,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: ProjectRecord;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry<ProjectRecord>[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .recordHistory<ProjectRecord>(record.recordId)
        .then((rows) => {
          if (alive) {
            setEntries(rows);
            setError('');
          }
        })
        .catch((error) => {
          if (alive) setError(error instanceof Error ? error.message : 'History unavailable');
        });
    return () => {
      alive = false;
    };
  }, [client, record.recordId, record.revision, state.online]);
  return (
    <RecordDialog
      client={client}
      title="Project history"
      subtitle="Earlier versions, kept for you"
      className="task-dialog"
      close={close}
    >
      {!state.online && <p className="fine">Connect to read history.</p>}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="history-list">
        {entries.map((entry) => (
          <article key={entry.changeSetId}>
            <div className="history-dot" />
            <div>
              <div className="history-meta">
                <strong>{entry.actor.displayName}</strong>
                <span>{dateWithYear(entry.recordedAt)}</span>
              </div>
              <p className="fine">
                Version {entry.afterRevision}
                {entry.version.deletedAt !== null ? ' · Removed' : ''}
              </p>
              <p className="historical-text">{text(entry.version)}</p>
              <AttachmentGallery client={client} attachments={entry.version.attachments} />
              <div className="history-actions">
                <button
                  onClick={() => void navigator.clipboard.writeText(text(entry.version)).catch(onError)}
                >
                  Copy details
                </button>
                {(entry.canUndo || entry.canRedo) && (
                  <button
                    disabled={busy || !state.online || state.pendingEdits.includes(record.recordId)}
                    onClick={() => {
                      setBusy(true);
                      void run(
                        record,
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
