import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { HistoryEntry, TaskRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { date } from '../format.js';
import { displayDate, type TaskRun } from './shared.js';
function details(record: TaskRecord): string {
  if (record.kind === 'task')
    return [
      record.title,
      record.instructions,
      record.recurrence
        ? `Repeat ${record.recurrence.count} ${record.recurrence.unit} after completion`
        : 'Does not repeat',
    ]
      .filter(Boolean)
      .join('\n');
  if (record.kind === 'task_completion')
    return [`Done by ${record.performerName} · ${date(record.completedAt)}`, record.note]
      .filter(Boolean)
      .join('\n');
  return [
    record.state === 'open' ? 'Open' : record.state === 'completed' ? 'Completed' : 'Cancelled',
    record.targetDate ? `Target: ${displayDate(record.targetDate)}` : '',
    record.deadlineDate ? `Deadline: ${displayDate(record.deadlineDate)}` : '',
    record.reviewDate ? `Revisit: ${displayDate(record.reviewDate)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
export function TaskHistory({
  client,
  state,
  record,
  run,
  close,
  onError,
  onRecord,
}: {
  client: ClientPlatform;
  state: ClientState;
  record: TaskRecord;
  run: TaskRun;
  close: () => void;
  onError: (error: unknown) => void;
  onRecord: (id: string) => void;
}) {
  const [entries, setEntries] = useState<HistoryEntry<TaskRecord>[]>([]);
  useEffect(() => {
    let alive = true;
    if (state.online)
      void client
        .recordHistory<TaskRecord>(record.recordId)
        .then((value) => {
          if (alive) setEntries(value);
        })
        .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, record.recordId, record.revision, state.online]);
  const action = (kind: string) =>
    ({
      CreateTask: 'Task added',
      UpdateTaskDefinition: 'Details updated',
      UpdateTaskOccurrence: 'Plan updated',
      PostponeTaskOccurrence: 'Date moved',
      CompleteTaskOccurrence: 'Completion recorded',
      DeleteTask: 'Task deleted',
      RestoreTask: 'Task restored',
      SetRecordAttachments: 'Photos updated',
      UndoChangeSet: 'Change undone',
      RedoChangeSet: 'Change redone',
    })[kind] ?? 'Changed';
  const taskId =
    record.kind === 'task'
      ? record.recordId
      : record.kind === 'task_occurrence'
        ? record.taskId
        : state.tasks.occurrences.find((o) => o.recordId === record.occurrenceId)?.taskId;
  const occurrences = state.tasks.occurrences
    .filter((o) => o.taskId === taskId)
    .sort((a, b) => b.ordinal - a.ordinal);
  const completions = state.tasks.completions.filter((c) =>
    occurrences.some((o) => o.recordId === c.occurrenceId),
  );
  return (
    <RecordDialog
      client={client}
      title="Task history"
      subtitle="Earlier versions, kept for you"
      className="task-dialog"
      close={close}
    >
      <label className="task-history-select">
        History for
        <select
          aria-label="History for"
          value={record.recordId}
          onChange={(event) => {
            setEntries([]);
            onRecord(event.target.value);
          }}
        >
          <option value={taskId}>Task details</option>
          {occurrences.map((o) => (
            <option key={o.recordId} value={o.recordId}>
              Occurrence {o.ordinal} · {o.state}
            </option>
          ))}
          {completions.map((c) => (
            <option key={c.recordId} value={c.recordId}>
              Completion · {date(c.completedAt)} · {c.performerName}
              {c.deletedAt ? ' · undone' : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="history-list">
        {!entries.length && (
          <p className="fine">{state.online ? 'Loading history…' : 'Connect to read history.'}</p>
        )}
        {entries.map((item) => (
          <article key={item.changeSetId}>
            <div className="history-dot" />
            <div>
              <div className="history-meta">
                <strong>{item.actor.displayName}</strong>
                <span>{date(item.recordedAt)}</span>
              </div>
              <p className="fine">{action(item.kind)}</p>
              <p className="historical-text">
                <LinkedText client={client} text={details(item.version)} />
              </p>
              {item.version.kind !== 'task_occurrence' && (
                <AttachmentGallery client={client} attachments={item.version.attachments ?? []} />
              )}
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
