import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { HistoryEntry, RecipeRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { dateWithYear } from '../format.js';
const details = (record: RecipeRecord) =>
  record.kind === 'recipe'
    ? [
        record.title,
        record.sourceUrl,
        record.description,
        record.yieldText,
        record.ingredients.map((x) => x.text).join('\n'),
        record.steps.map((x) => x.text).join('\n\n'),
        ...record.adjustments.map((x) => x.body),
      ]
        .filter(Boolean)
        .join('\n\n')
    : record.kind === 'recipe_collection'
      ? record.name
      : [dateWithYear(record.cookedAt), record.notes].join('\n\n');
export function RecipeHistory({
  client,
  state,
  record,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: RecipeRecord;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry<RecipeRecord>[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .recordHistory<RecipeRecord>(record.recordId)
        .then((value) => {
          if (alive) {
            setEntries(value);
            setError('');
          }
        })
        .catch((error) => {
          if (alive) setError(error instanceof Error ? error.message : 'Could not load history.');
        });
    return () => {
      alive = false;
    };
  }, [client, record.recordId, record.revision, state.online]);
  return (
    <RecordDialog
      client={client}
      title="Recipe history"
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
                {entry.kind === 'ApplyRecipeImport'
                  ? 'Recipe details imported'
                  : entry.kind === 'ImportRecipe'
                    ? 'Recipe link saved'
                    : entry.kind === 'UndoChangeSet'
                      ? 'Change undone'
                      : entry.kind === 'RedoChangeSet'
                        ? 'Change redone'
                        : `Version ${entry.afterRevision}`}
              </p>
              <p className="historical-text">
                <LinkedText client={client} text={details(entry.version)} />
              </p>
              {entry.version.kind !== 'recipe_collection' && (
                <AttachmentGallery
                  navigationKey={`RecipeHistory.${entry.version.revision}`}
                  client={client}
                  attachments={entry.version.attachments}
                />
              )}
              <div className="history-actions">
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(details(entry.version)).catch(onError);
                  }}
                >
                  Copy details
                </button>
                {(entry.canUndo || entry.canRedo) && (
                  <button
                    disabled={!state.online || state.pendingEdits.includes(record.recordId)}
                    onClick={() => {
                      void run(
                        record,
                        entry.canRedo ? 'RedoChangeSet' : 'UndoChangeSet',
                        { changeSetId: entry.changeSetId },
                        entry.canRedo ? 'Change redone' : 'Change undone',
                      );
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
