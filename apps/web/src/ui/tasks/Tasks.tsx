import { useNavigationState } from '../NavigationHistory.js';
import { usePagePreference } from '../usePagePreference.js';
import { useEffect, useRef, useState } from 'react';
import { CaptureSources } from '../inbox/FilingLinks.js';
import {
  openTasks,
  taskAttention,
  compareOpenTasks,
  type ClientPlatform,
  type ClientState,
  type TaskAttention,
} from '@our-place/client';
import {
  calendarDateAt,
  type CommandKind,
  type TaskDefinition,
  type TaskOccurrence,
  type TaskRecord,
} from '@our-place/contracts';
import { Icon } from '../Icon.js';
import { date } from '../format.js';
import { TaskEditor } from './TaskEditor.js';
import { PostponeTask } from './PostponeTask.js';
import { CompletionDialog } from './CompletionDialog.js';
import { TaskHistory } from './TaskHistory.js';
import { taskRecords, displayDate, priorityNames, type TaskRun } from './shared.js';
import './tasks.css';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
type View = 'focus' | 'all' | 'completed' | 'deleted';
type Editor = { mode: 'create' | 'definition' | 'occurrence'; taskId?: string; occurrenceId?: string };
const groupNames: Record<TaskAttention, string> = {
  overdue: 'Past a real deadline',
  today: 'Due today',
  priority: 'Chosen priorities',
  ready: 'Ready when you are',
  review: 'Time to revisit',
  upcoming: 'Coming up',
  anytime: 'Without a date',
};
const groupOrder: TaskAttention[] = [
  'overdue',
  'today',
  'priority',
  'ready',
  'review',
  'upcoming',
  'anytime',
];
export function Tasks({
  client,
  state,
  run,
  onError,
  onPhotosSaved,
  onOpenRecipe,
  initialRecordId,
  initialAction = 'show',
}: {
  client: ClientPlatform;
  state: ClientState;
  run: TaskRun;
  onError: (error: unknown) => void;
  onPhotosSaved: AttachmentSaved;
  onOpenRecipe: (id: string) => void;
  initialRecordId?: string | null;
  initialAction?: 'show' | 'complete' | 'postpone';
}) {
  const initial = taskRecords(state.tasks).find((r) => r.recordId === initialRecordId);
  const initialOccurrence =
    initial?.kind === 'task_occurrence'
      ? initial
      : initial?.kind === 'task_completion'
        ? state.tasks.occurrences.find((o) => o.recordId === initial.occurrenceId)
        : undefined;
  const initialTask =
    initial?.kind === 'task'
      ? initial
      : state.tasks.definitions.find((t) => t.recordId === initialOccurrence?.taskId);
  const [focusId, setFocusId] = useNavigationState(
    `Tasks.${initialRecordId ?? ''}.focusId`,
    initialTask?.recordId ?? null,
  );
  const [savedView, saveView] = usePagePreference<View>(state, 'tasks.view', 'focus', (v): v is View =>
    ['focus', 'all', 'completed', 'deleted'].includes(String(v)),
  );
  const [expanded, setExpanded] = useNavigationState<string[]>(
    `Tasks.${initialRecordId ?? ''}.expanded`,
    initialTask
      ? state.tasks.occurrences.filter((o) => o.taskId === initialTask.recordId).map((o) => o.recordId)
      : [],
  );
  const [view, setNavigationView] = useNavigationState<View>(
      `Tasks.${initialRecordId ?? ''}.view`,
      initialTask?.deletedAt != null
        ? 'deleted'
        : initial?.kind === 'task_completion'
          ? 'completed'
          : initial
            ? 'all'
            : savedView,
    ),
    [person, setPerson] = usePagePreference<string>(
      state,
      'tasks.person',
      initial ? 'everyone' : 'mine',
      (v): v is string =>
        typeof v === 'string' &&
        (['everyone', 'mine', 'unassigned'].includes(v) || state.tasks.people.some((p) => p.personId === v)),
      Boolean(initial),
    ),
    [context, setContext] = usePagePreference<string>(
      state,
      'tasks.context',
      'both',
      (v): v is string => ['both', 'home', 'work'].includes(String(v)),
      Boolean(initial),
    ),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(30);
  const [editor, setEditor] = useNavigationState<Editor | null>(
      `Tasks.${initialRecordId ?? ''}.editor`,
      null,
    ),
    [photosId, setPhotosId] = useNavigationState<string | null>(
      `Tasks.${initialRecordId ?? ''}.photosId`,
      null,
    ),
    [completionId, setCompletionId] = useNavigationState<string | null>(
      `Tasks.${initialRecordId ?? ''}.completionId`,
      initialAction === 'complete' && initialOccurrence?.state === 'open' ? initialOccurrence.recordId : null,
    ),
    [historyId, setHistoryId] = useNavigationState<string | null>(
      `Tasks.${initialRecordId ?? ''}.historyId`,
      initial && (initial.kind === 'task_completion' || initialOccurrence?.state === 'completed')
        ? initial.recordId
        : null,
    ),
    [working, setWorking] = useState<string[]>([]),
    locks = useRef(new Set<string>());
  function setView(next: View) {
    if (!initialRecordId) saveView(next);
    setNavigationView(next);
  }
  useEffect(() => {
    if (!initialRecordId) saveView(view);
  }, [view, initialRecordId]);
  const snapshot = state.tasks,
    session = state.session!,
    today = calendarDateAt(Date.now(), snapshot.timeZone),
    records = taskRecords(snapshot);
  const history = records.find((record) => record.recordId === historyId),
    photos = records.find((record) => record.recordId === photosId && record.kind !== 'task_occurrence'),
    editedTask = snapshot.definitions.find((task) => task.recordId === editor?.taskId),
    editedOccurrence = snapshot.occurrences.find((item) => item.recordId === editor?.occurrenceId);
  const completion = snapshot.occurrences.find((item) => item.recordId === completionId),
    completionTask = snapshot.definitions.find((task) => task.recordId === completion?.taskId);
  const matchPerson = (id: string | null) =>
    person === 'everyone' ||
    (person === 'mine' && (id === session.person.personId || id === null)) ||
    (person === 'unassigned' && id === null) ||
    id === person;
  const matches = (task: TaskDefinition) =>
    (!focusId || task.recordId === focusId) &&
    (context === 'both' || task.context === context) &&
    `${task.title} ${task.instructions}`.toLowerCase().includes(search.toLowerCase());
  const effectiveAssignee = (task: TaskDefinition, item: TaskOccurrence) =>
    item.assigneeId ??
    (session.scopes.find((s) => s.scopeId === task.scopeId)?.kind === 'private'
      ? session.person.personId
      : null);
  const open = openTasks(snapshot)
    .filter(({ task, occurrence }) => matches(task) && matchPerson(effectiveAssignee(task, occurrence)))
    .sort(compareOpenTasks);
  const completed = snapshot.completions
    .filter(
      (item) =>
        !item.deletedAt &&
        matchPerson(item.performedByPersonId) &&
        snapshot.definitions.some(
          (task) =>
            matches(task) &&
            snapshot.occurrences.some(
              (occ) => occ.recordId === item.occurrenceId && occ.taskId === task.recordId,
            ),
        ),
    )
    .sort((a, b) => b.completedAt - a.completedAt || b.recordId.localeCompare(a.recordId));
  const deleted = snapshot.definitions.filter((task) => task.deletedAt !== null && matches(task));
  const focused = open.filter(
      ({ occurrence }) => !['upcoming', 'anytime'].includes(taskAttention(occurrence, today)),
    ),
    visible = [...(view === 'focus' ? focused : open)].sort(
      (a, b) =>
        groupOrder.indexOf(taskAttention(a.occurrence, today)) -
          groupOrder.indexOf(taskAttention(b.occurrence, today)) || compareOpenTasks(a, b),
    );
  const disabled = (...ids: string[]) =>
    !state.online || ids.some((id) => state.pendingEdits.includes(id) || working.includes(id));
  async function action(key: string, target: TaskRecord, kind: CommandKind, args: unknown, label: string) {
    if (disabled(key, target.recordId) || locks.current.has(key)) return;
    locks.current.add(key);
    setWorking([...locks.current]);
    try {
      await run(target, kind, args, label);
    } finally {
      locks.current.delete(key);
      setWorking([...locks.current]);
    }
  }
  const personName = (id: string | null) =>
    snapshot.people.find((p) => p.personId === id)?.displayName ?? 'Unassigned';
  const historyButton = (record: TaskRecord) => (
    <button onClick={() => setHistoryId(record.recordId)}>History</button>
  );
  function taskRow(task: TaskDefinition, item: TaskOccurrence) {
    const blocked = disabled(task.recordId, item.recordId),
      last = snapshot.completions
        .filter(
          (c) =>
            !c.deletedAt &&
            snapshot.occurrences.some((o) => o.recordId === c.occurrenceId && o.taskId === task.recordId),
        )
        .sort((a, b) => b.completedAt - a.completedAt)[0];
    return (
      <article className="task-card" key={item.recordId} aria-label={task.title}>
        <button
          className="task-check"
          aria-label={`Complete ${task.title}`}
          disabled={blocked}
          onClick={() => {
            void action(
              task.recordId,
              item,
              'CompleteTaskOccurrence',
              {
                recordId: item.recordId,
                expectedRevision: item.revision,
                expectedTaskRevision: task.revision,
                completionId: crypto.randomUUID(),
                nextOccurrenceId: task.recurrence ? crypto.randomUUID() : null,
                completedAt: Date.now(),
                performedByPersonId: session.person.personId,
                note: '',
              },
              'Done · completion recorded',
            );
          }}
        >
          <Icon name="check" size={22} />
        </button>
        <details
          className="task-card-body"
          open={expanded.includes(item.recordId)}
          onToggle={(e) => {
            const open = e.currentTarget.open;
            setExpanded((ids) =>
              open
                ? ids.includes(item.recordId)
                  ? ids
                  : [...ids, item.recordId]
                : ids.filter((id) => id !== item.recordId),
            );
          }}
        >
          <summary className="task-summary" aria-label={`Task details: ${task.title}`}>
            <div className="task-title">
              <h3>{task.title}</h3>
              {item.priority >= 2 && <span className="task-priority">{priorityNames[item.priority]}</span>}
            </div>
            <p className="task-meta">
              {personName(effectiveAssignee(task, item))} · {task.context === 'home' ? 'Home' : 'Work'}
              {session.scopes.find((scope) => scope.scopeId === task.scopeId)?.kind === 'private'
                ? ' · Just me'
                : ''}
              {item.deadlineDate
                ? ` · Deadline ${displayDate(item.deadlineDate)}`
                : item.targetDate
                  ? ` · Target ${displayDate(item.targetDate)}`
                  : item.reviewDate
                    ? ` · Revisit ${displayDate(item.reviewDate)}`
                    : ''}
            </p>
          </summary>
          <div className="task-expanded">
            {task.recurrence && (
              <p className="fine">
                Repeats every {task.recurrence.count} {task.recurrence.unit} after completion.
              </p>
            )}
            {task.instructions && task.instructions.trim() !== task.title.trim() && (
              <p className="task-instructions">
                <LinkedText client={client} text={task.instructions} />
              </p>
            )}
            {task.maintenance && (
              <p className="fine">
                Maintains{' '}
                {state.home.assets.find((asset) => asset.recordId === task.maintenance!.assetId)?.name ??
                  'linked asset'}
              </p>
            )}
            {task.cooking && (
              <p className="fine">
                <button className="task-recipe-link" onClick={() => onOpenRecipe(task.cooking!.recipeId)}>
                  Recipe:{' '}
                  {state.recipes.recipes.find((recipe) => recipe.recordId === task.cooking!.recipeId)
                    ?.title ?? 'Open recipe'}
                </button>
              </p>
            )}
            <AttachmentGallery client={client} attachments={task.attachments ?? []} />
            <div className="task-dates">
              {item.deadlineDate && (
                <span className={item.deadlineDate < today ? 'task-late' : ''}>
                  Deadline · {displayDate(item.deadlineDate)}
                </span>
              )}
              {item.targetDate && <span>Target · {displayDate(item.targetDate)}</span>}
              {item.reviewDate && <span>Revisit · {displayDate(item.reviewDate)}</span>}
            </div>
            {last && (
              <p className="fine">
                Last done {date(last.completedAt)} by {last.performerName}
              </p>
            )}
            {state.pendingEdits.some((id) => id === item.recordId || id === task.recordId) && (
              <p className="fine" role="status">
                Waiting for confirmation…
              </p>
            )}
            <CaptureSources recordId={task.recordId} state={state} />
            <div className="task-actions">
              <button
                disabled={blocked}
                onClick={() => setEditor({ mode: 'definition', taskId: task.recordId })}
              >
                Edit
              </button>
              <button
                disabled={blocked}
                onClick={() =>
                  setEditor({ mode: 'occurrence', taskId: task.recordId, occurrenceId: item.recordId })
                }
              >
                Plan
              </button>
              <button disabled={blocked} onClick={() => setCompletionId(item.recordId)}>
                Done earlier…
              </button>
              {historyButton(task)}
              <button onClick={() => setPhotosId(task.recordId)}>Photos & receipts</button>
              <button
                disabled={blocked}
                onClick={() => {
                  void action(
                    task.recordId,
                    item,
                    'UpdateTaskOccurrence',
                    {
                      recordId: item.recordId,
                      expectedRevision: item.revision,
                      assigneeId: item.assigneeId,
                      priority: item.priority >= 2 ? 1 : 2,
                      deadlineDate: item.deadlineDate,
                      targetDate: item.targetDate,
                      reviewDate: item.reviewDate,
                    },
                    item.priority >= 2 ? 'Priority cleared' : 'Pinned as important',
                  );
                }}
              >
                {item.priority >= 2 ? 'Unpin' : 'Pin'}
              </button>
              <button
                aria-label={`Delete ${task.title}`}
                disabled={blocked}
                onClick={() => {
                  void action(
                    task.recordId,
                    task,
                    'DeleteTask',
                    {
                      recordId: task.recordId,
                      expectedRevision: task.revision,
                      occurrence: { recordId: item.recordId, expectedRevision: item.revision },
                    },
                    'Task moved to deleted',
                  );
                }}
              >
                <Icon name="trash" size={16} />
              </button>
            </div>
            <PostponeTask
              initialOpen={initialAction === 'postpone' && initialOccurrence?.recordId === item.recordId}
              item={item}
              today={today}
              disabled={blocked}
              move={(field, value) => {
                void action(
                  task.recordId,
                  item,
                  'PostponeTaskOccurrence',
                  { recordId: item.recordId, expectedRevision: item.revision, field, date: value },
                  field === 'targetDate' ? 'Target moved' : 'Review date moved',
                );
              }}
            />
          </div>
        </details>
      </article>
    );
  }
  const count =
    view === 'completed' ? completed.length : view === 'deleted' ? deleted.length : visible.length;
  return (
    <section className="tasks" aria-label="Tasks and personal overview">
      {focusId && (
        <p className="notice">
          Showing the linked task. <button onClick={() => setFocusId(null)}>Show all tasks</button>
        </p>
      )}
      <div className="collection-toolbar">
        <div className="task-views" role="group" aria-label="Task views">
          {(['focus', 'all', 'completed', 'deleted'] as const).map((tab) => (
            <button
              key={tab}
              aria-pressed={view === tab}
              onClick={() => {
                setView(tab);
                setLimit(30);
              }}
            >
              {{ focus: 'Focus', all: 'All tasks', completed: 'Completed', deleted: 'Deleted' }[tab]}
            </button>
          ))}
        </div>
        <button className="primary" disabled={!state.online} onClick={() => setEditor({ mode: 'create' })}>
          <Icon name="plus" size={17} /> New task
        </button>
      </div>
      <div className="task-filters">
        <label>
          <span className="sr-only">Task person</span>
          <select
            aria-label="Task person"
            value={person}
            onChange={(event) => {
              setPerson(event.target.value);
              setLimit(30);
            }}
          >
            <option value="mine">Mine & unassigned</option>
            <option value="everyone">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {snapshot.people.map((p) => (
              <option value={p.personId} key={p.personId}>
                {p.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Task context</span>
          <select
            aria-label="Task context"
            value={context}
            onChange={(event) => {
              setContext(event.target.value);
              setLimit(30);
            }}
          >
            <option value="both">Home & work</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
          </select>
        </label>
        <label className="search">
          <Icon name="search" size={17} />
          <input
            aria-label="Search tasks"
            placeholder="Find a task…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(30);
            }}
          />
        </label>
      </div>
      {!count && (
        <div className="task-empty">
          <Icon name="check" size={34} />
          <h3>
            {search
              ? 'No matching tasks.'
              : view === 'focus'
                ? 'Nothing pressing here.'
                : view === 'completed'
                  ? 'A place to see your progress.'
                  : view === 'deleted'
                    ? 'Nothing deleted.'
                    : 'Start with something small.'}
          </h3>
          <p>
            {view === 'focus'
              ? `${open.length} open task${open.length === 1 ? '' : 's'} in this view. Dates and priorities will bring things into focus.`
              : view === 'completed'
                ? 'Completions keep who did the work and when it actually happened.'
                : 'A chore, a thing to fix, or something to revisit.'}
          </p>
          {view === 'focus' && <button onClick={() => setView('all')}>Browse all tasks</button>}
        </div>
      )}
      {(view === 'focus' || view === 'all') &&
        groupOrder.map((group) => {
          const items = visible
            .slice(0, limit)
            .filter(({ occurrence }) => taskAttention(occurrence, today) === group);
          return items.length ? (
            <div className="task-group" key={group}>
              <h2>
                {groupNames[group]}
                <span>{items.length}</span>
              </h2>
              {items.map(({ task, occurrence }) => taskRow(task, occurrence))}
            </div>
          ) : null;
        })}
      {view === 'completed' && (
        <div className="completion-feed">
          {completed.slice(0, limit).map((item) => {
            const occurrence = snapshot.occurrences.find((o) => o.recordId === item.occurrenceId)!,
              task = snapshot.definitions.find((t) => t.recordId === occurrence.taskId)!;
            return (
              <article className="completion-card" key={item.recordId}>
                <div className="completion-mark">
                  <Icon name="check" />
                </div>
                <div>
                  <h3>{task.title}</h3>
                  <p className="task-meta">
                    Done by {item.performerName} · {date(item.completedAt)}
                  </p>
                  {item.note && (
                    <p className="task-instructions">
                      <LinkedText client={client} text={item.note} />
                    </p>
                  )}
                  <AttachmentGallery client={client} attachments={item.attachments ?? []} />
                  {task.deletedAt !== null && (
                    <p className="fine">Task deleted · completion kept in history</p>
                  )}
                  <div className="task-actions">
                    {historyButton(item)}
                    <button onClick={() => setPhotosId(item.recordId)}>Photos & receipts</button>
                    {!task.deletedAt && (
                      <button
                        disabled={disabled(task.recordId)}
                        onClick={() => setEditor({ mode: 'definition', taskId: task.recordId })}
                      >
                        Task details
                      </button>
                    )}
                    {task.deletedAt === null && (
                      <button
                        aria-label={`Delete task ${task.title}`}
                        disabled={disabled(task.recordId)}
                        onClick={() => {
                          const open = snapshot.occurrences.find(
                            (o) => o.taskId === task.recordId && o.state === 'open' && o.deletedAt === null,
                          );
                          if (open && disabled(open.recordId)) return;
                          void action(
                            task.recordId,
                            task,
                            'DeleteTask',
                            {
                              recordId: task.recordId,
                              expectedRevision: task.revision,
                              occurrence: open
                                ? { recordId: open.recordId, expectedRevision: open.revision }
                                : null,
                            },
                            'Task moved to deleted',
                          );
                        }}
                      >
                        Delete task
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {view === 'deleted' && (
        <div>
          {deleted.slice(0, limit).map((task) => {
            const retired = snapshot.occurrences.find(
              (o) => o.taskId === task.recordId && o.deletedAt === task.deletedAt && o.state === 'cancelled',
            );
            return (
              <article className="task-card" key={task.recordId}>
                <div className="task-card-body">
                  <h3>{task.title}</h3>
                  <p className="task-meta">{task.context === 'home' ? 'Home' : 'Work'}</p>
                  <div className="task-actions">
                    <button
                      disabled={disabled(task.recordId, ...(retired ? [retired.recordId] : []))}
                      onClick={() => {
                        void action(
                          task.recordId,
                          task,
                          'RestoreTask',
                          {
                            recordId: task.recordId,
                            expectedRevision: task.revision,
                            occurrence: retired
                              ? { recordId: retired.recordId, expectedRevision: retired.revision }
                              : null,
                          },
                          'Task restored',
                        );
                      }}
                    >
                      Restore
                    </button>
                    {historyButton(task)}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {count > limit && (
        <button className="load-more" onClick={() => setLimit((value) => value + 30)}>
          Show more · {count - limit} remaining
        </button>
      )}
      <p className="fine task-footnote">
        {state.online
          ? 'Changes refresh across your devices.'
          : 'Offline · showing the last saved tasks. Use Inbox for new captures.'}
      </p>
      {editor && (
        <TaskEditor
          client={client}
          state={state}
          mode={editor.mode}
          {...(editedTask ? { task: editedTask } : {})}
          {...(editedOccurrence ? { occurrence: editedOccurrence } : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={() => {
            if (editor.mode === 'create') {
              setView('all');
              setPerson('everyone');
              setContext('both');
              setSearch('');
            }
          }}
          onError={onError}
        />
      )}
      {completion && completionTask && (
        <CompletionDialog
          client={client}
          state={state}
          task={completionTask}
          occurrence={completion}
          run={run}
          close={() => setCompletionId(null)}
          onError={onError}
        />
      )}
      {history && (
        <TaskHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
          onRecord={setHistoryId}
        />
      )}
      {photos && (
        <AttachmentDialog
          client={client}
          target={photos}
          title={photos.kind === 'task' ? photos.title : 'Completion photos'}
          online={state.online}
          serverEpoch={session.serverEpoch}
          pending={state.pendingEdits.includes(photos.recordId)}
          close={() => setPhotosId(null)}
          onSaved={onPhotosSaved}
        />
      )}
    </section>
  );
}
