import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { HistoryEntry, HomeRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { dateWithYear as date } from '../format.js';

const details = (record: HomeRecord) =>
  record.kind === 'home_asset'
    ? [
        record.name,
        record.model,
        record.serial ? `Serial: ${record.serial}` : '',
        record.location,
        record.acquiredDate ? `Acquired: ${record.acquiredDate}` : '',
        record.archived ? 'Archived' : '',
        record.notes,
      ]
        .filter(Boolean)
        .join('\n')
    : [
        date(record.occurredAt),
        record.notes,
        record.costAmount !== null ? `${record.currency} ${record.costAmount}` : '',
      ]
        .filter(Boolean)
        .join('\n');
const labels: Record<string, string> = {
  CreateHomeAsset: 'Asset added',
  UpdateHomeAsset: 'Details updated',
  SetHomeAssetArchived: 'Archive status changed',
  DeleteHomeAsset: 'Asset removed',
  RestoreHomeAsset: 'Asset restored',
  CreateMaintenanceRecord: 'Service recorded',
  UpdateMaintenanceRecord: 'Service details updated',
  DeleteMaintenanceRecord: 'Service entry removed',
  RestoreMaintenanceRecord: 'Service entry restored',
  CompleteTaskOccurrence: 'Task completion and service recorded',
  SetRecordAttachments: 'Photos updated',
  ShareRecords: 'Shared with household',
  UndoChangeSet: 'Change undone',
  RedoChangeSet: 'Change redone',
};
export function HomeHistory({
  client,
  state,
  record,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: HomeRecord;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry<HomeRecord>[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .recordHistory<HomeRecord>(record.recordId)
        .then((value) => {
          if (alive) {
            setEntries(value);
            setError('');
          }
        })
        .catch((value: unknown) => {
          if (alive) setError(value instanceof Error ? value.message : 'Could not read history.');
        });
    return () => {
      alive = false;
    };
  }, [client, record.recordId, record.revision, state.online]);
  return (
    <RecordDialog
      client={client}
      title={record.kind === 'home_asset' ? 'Asset history' : 'Service history'}
      subtitle="Earlier versions, kept for you"
      className="task-dialog"
      close={close}
    >
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!state.online && <p className="fine">Connect to read history.</p>}
      <div className="history-list">
        {entries.map((item) => (
          <article key={item.changeSetId}>
            <div className="history-dot" />
            <div>
              <div className="history-meta">
                <strong>{item.actor.displayName}</strong>
                <span>{date(item.recordedAt)}</span>
              </div>
              <p className="fine">{labels[item.kind] ?? 'Changed'}</p>
              <p className="historical-text">
                <LinkedText client={client} text={details(item.version)} />
              </p>
              <AttachmentGallery
                navigationKey={`HomeHistory.${item.version.revision}`}
                client={client}
                attachments={item.version.attachments}
              />
              <div className="history-actions">
                <button
                  onClick={() => {
                    void navigator.clipboard.writeText(details(item.version)).catch(onError);
                  }}
                >
                  Copy details
                </button>
                {(item.canUndo || item.canRedo) && (
                  <button
                    disabled={!state.online || state.pendingEdits.includes(record.recordId)}
                    onClick={() => {
                      void run(
                        record,
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
    </RecordDialog>
  );
}
