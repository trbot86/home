import { useNavigationState } from '../NavigationHistory.js';
import { useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { calendarDateAt, type Recipe } from '@our-place/contracts';
import { TaskEditor } from '../tasks/TaskEditor.js';
import { CompletionDialog } from '../tasks/CompletionDialog.js';
import { PostponeTask } from '../tasks/PostponeTask.js';
import { TaskHistory } from '../tasks/TaskHistory.js';
import { displayDate, priorityNames, taskRecords } from '../tasks/shared.js';
import { dateWithYear } from '../format.js';

export function RecipeTasks({
  client,
  state,
  recipe,
  run,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  recipe: Recipe;
  run: RunRecordCommand;
  onError: (error: unknown) => void;
}) {
  const [editor, setEditor] = useNavigationState<{
      mode: 'create' | 'definition' | 'occurrence';
      taskId?: string;
      occurrenceId?: string;
    } | null>(`recipeTasks.${recipe.recordId}.editor`, null),
    [completionId, setCompletionId] = useNavigationState<string | null>(
      `recipeTasks.${recipe.recordId}.completionId`,
      null,
    ),
    [historyId, setHistoryId] = useNavigationState<string | null>(
      `recipeTasks.${recipe.recordId}.historyId`,
      null,
    ),
    [working, setWorking] = useState<string[]>([]),
    [limit, setLimit] = useState(10),
    locks = useRef(new Set<string>());
  const tasks = state.tasks.definitions.filter(
      (t) => t.cooking?.recipeId === recipe.recordId && t.deletedAt === null,
    ),
    editedTask = state.tasks.definitions.find((t) => t.recordId === editor?.taskId),
    editedOccurrence = state.tasks.occurrences.find((o) => o.recordId === editor?.occurrenceId),
    completion = state.tasks.occurrences.find((o) => o.recordId === completionId),
    completionTask = tasks.find((t) => t.recordId === completion?.taskId),
    history = taskRecords(state.tasks).find((r) => r.recordId === historyId),
    today = calendarDateAt(Date.now(), state.tasks.timeZone);
  const disabled = (...ids: string[]) =>
    !state.online || ids.some((id) => state.pendingEdits.includes(id) || working.includes(id));
  return (
    <section className="food-plans" aria-label="Cooking plans">
      <div className="food-subheading">
        <h3>Plan a meal</h3>
        <button
          disabled={recipe.deletedAt !== null || recipe.archived || disabled(recipe.recordId)}
          onClick={() => setEditor({ mode: 'create' })}
        >
          Create a to-do
        </button>
      </div>
      {!tasks.length && (
        <p className="fine">
          Choose a person, a priority or a flexible date. Checking off a cooking task also records the meal
          below.
        </p>
      )}
      {tasks.slice(0, limit).map((task) => {
        const occurrence = state.tasks.occurrences.find(
            (o) => o.taskId === task.recordId && o.state === 'open' && o.deletedAt === null,
          ),
          last = state.tasks.completions
            .filter(
              (c) =>
                c.deletedAt === null &&
                state.tasks.occurrences.some(
                  (o) => o.recordId === c.occurrenceId && o.taskId === task.recordId,
                ),
            )
            .sort((a, b) => b.completedAt - a.completedAt)[0];
        return (
          <article className="food-cooking-task" key={task.recordId}>
            <strong>{task.title}</strong>
            {occurrence && (
              <p className="fine">
                {priorityNames[occurrence.priority]}
                {occurrence.assigneeId
                  ? ` · ${state.tasks.people.find((p) => p.personId === occurrence.assigneeId)?.displayName ?? 'Assigned'}`
                  : ' · Unassigned'}
                {occurrence.targetDate ? ` · Target ${displayDate(occurrence.targetDate)}` : ''}
                {occurrence.reviewDate ? ` · Revisit ${displayDate(occurrence.reviewDate)}` : ''}
                {occurrence.deadlineDate ? ` · Deadline ${displayDate(occurrence.deadlineDate)}` : ''}
              </p>
            )}
            {last && (
              <p className="fine">
                Last cooked {dateWithYear(last.completedAt)} by {last.performerName}
              </p>
            )}
            <div className="food-actions">
              {occurrence && (
                <>
                  <button
                    disabled={disabled(task.recordId, occurrence.recordId)}
                    onClick={() => setCompletionId(occurrence.recordId)}
                  >
                    Record completion
                  </button>
                  <button
                    disabled={disabled(occurrence.recordId)}
                    onClick={() =>
                      setEditor({
                        mode: 'occurrence',
                        taskId: task.recordId,
                        occurrenceId: occurrence.recordId,
                      })
                    }
                  >
                    Plan
                  </button>
                </>
              )}
              <button
                disabled={disabled(task.recordId)}
                onClick={() => setEditor({ mode: 'definition', taskId: task.recordId })}
              >
                Edit task
              </button>
              <button onClick={() => setHistoryId(task.recordId)}>Task history</button>
            </div>
            {occurrence && (
              <PostponeTask
                item={occurrence}
                today={today}
                disabled={disabled(occurrence.recordId)}
                move={(field, date) => {
                  if (disabled(occurrence.recordId) || locks.current.has(occurrence.recordId)) return;
                  locks.current.add(occurrence.recordId);
                  setWorking([...locks.current]);
                  void run(
                    occurrence,
                    'PostponeTaskOccurrence',
                    { recordId: occurrence.recordId, expectedRevision: occurrence.revision, field, date },
                    'Cooking date moved',
                  )
                    .catch(onError)
                    .finally(() => {
                      locks.current.delete(occurrence.recordId);
                      setWorking([...locks.current]);
                    });
                }}
              />
            )}
          </article>
        );
      })}
      {tasks.length > limit && (
        <button onClick={() => setLimit(limit + 10)}>
          Show more cooking tasks ({tasks.length - limit} more)
        </button>
      )}
      {editor && (
        <TaskEditor
          key={`${editor.mode}:${editor.taskId ?? 'new'}`}
          client={client}
          state={state}
          mode={editor.mode}
          recipe={recipe}
          {...(editedTask ? { task: editedTask } : {})}
          {...(editedOccurrence ? { occurrence: editedOccurrence } : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={() => {}}
          onError={onError}
        />
      )}
      {completion && completionTask && (
        <CompletionDialog
          key={completion.recordId}
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
    </section>
  );
}
