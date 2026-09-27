import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { TaskDefinition, TaskOccurrence } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { localDateTime, type TaskRun } from './shared.js';
export function CompletionDialog({
  client,
  state,
  task,
  occurrence,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  task: TaskDefinition;
  occurrence: TaskOccurrence;
  run: TaskRun;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const buffer = useSavedForm(
    client,
    `task:complete:${occurrence.recordId}`,
    () => ({
      completionId: crypto.randomUUID(),
      nextOccurrenceId: crypto.randomUUID(),
      taskRevision: String(task.revision),
      completedAt: localDateTime(Date.now()),
      personId: state.session!.person.personId,
      note: '',
    }),
    occurrence.revision,
    state.session!.serverEpoch,
    onError,
  );
  const form = buffer.values,
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(occurrence.recordId),
    stale =
      buffer.baseRevision !== occurrence.revision ||
      Number(form.taskRevision) !== task.revision ||
      buffer.epoch !== state.session!.serverEpoch;
  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  };
  useEffect(() => {
    if (buffer.ready && state.tasks.completions.some((item) => item.recordId === form.completionId))
      void finish();
  }, [buffer.ready, state.tasks.completions, form.completionId]);
  const privateTask =
    state.session!.scopes.find((scope) => scope.scopeId === task.scopeId)?.kind === 'private';
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !buffer.ready || pending || stale || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const completedAt = new Date(form.completedAt).getTime();
      if (!Number.isFinite(completedAt) || localDateTime(completedAt) !== form.completedAt) {
        setError('Choose a valid local date and time.');
        return;
      }
      await buffer.save();
      const result = await run(
        occurrence,
        'CompleteTaskOccurrence',
        {
          recordId: occurrence.recordId,
          expectedRevision: buffer.baseRevision,
          expectedTaskRevision: Number(form.taskRevision),
          completionId: form.completionId,
          nextOccurrenceId: task.recurrence ? form.nextOccurrenceId : null,
          completedAt,
          performedByPersonId: form.personId,
          note: form.note,
        },
        'Completion recorded',
        buffer.epoch,
      );
      if (result?.status === 'Applied') await finish();
      else
        setError(
          result?.status === 'Rejected'
            ? result.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your details are kept.',
        );
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <RecordDialog
      client={client}
      title="Record completion"
      subtitle={task.title}
      className="task-dialog"
      close={() => {
        void buffer.flush().then(close).catch(onError);
      }}
    >
      <form
        className="task-form"
        onSubmit={(event) => {
          void submit(event);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset disabled={!buffer.ready || busy || pending || !state.online}>
          <label className="task-field">
            Actually completed at
            <input
              aria-label="Actually completed at"
              type="datetime-local"
              required
              value={form.completedAt}
              onChange={(event) => buffer.field('completedAt', event.target.value)}
            />
          </label>
          <p className="fine">
            This device’s time zone. Recurring work follows when it happened, even when recorded later.
          </p>
          {task.cooking && (
            <p className="fine">
              This also saves a cooking record with the recipe. Your favourites and Make soon pin stay as you
              chose them.
            </p>
          )}
          <label className="task-field">
            Done by
            <select
              aria-label="Done by"
              value={form.personId}
              onChange={(event) => buffer.field('personId', event.target.value)}
            >
              {state.tasks.people
                .filter((person) => !privateTask || person.personId === state.session!.person.personId)
                .map((person) => (
                  <option key={person.personId} value={person.personId}>
                    {person.displayName}
                  </option>
                ))}
            </select>
          </label>
          <label className="task-field">
            Completion note
            <textarea
              aria-label="Completion note"
              rows={3}
              value={form.note}
              maxLength={20000}
              onChange={(event) => buffer.field('note', event.target.value)}
            />
          </label>
        </fieldset>
        {stale && (
          <div className="notice">
            This task changed. Your details are kept.
            <button
              type="button"
              disabled={pending || !state.online}
              onClick={() => {
                void buffer.reset().catch(onError);
              }}
            >
              Reload latest
            </button>
          </div>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <span className="fine">{pending ? 'Waiting for confirmation' : 'Ctrl ↵ to save'}</span>
          <button className="primary" disabled={!buffer.ready || busy || pending || stale || !state.online}>
            Record completion
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
