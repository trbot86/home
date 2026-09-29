import { SecureRecord } from '../SecureRecord.js';
import { ShareRecord } from '../ShareRecord.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type {
  CommandKind,
  TaskDefinition,
  TaskOccurrence,
  TaskRecurrence,
  HomeAsset,
  Recipe,
} from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { priorityNames, type TaskRun } from './shared.js';
import type { TaskTemplate } from './task-template.js';
import { RevisitDate } from './RevisitDate.js';
export function TaskEditor({
  client,
  state,
  mode,
  task,
  occurrence,
  run,
  close,
  onSaved,
  onError,
  asset,
  recipe,
  template,
}: {
  client: ClientPlatform;
  state: ClientState;
  mode: 'create' | 'definition' | 'occurrence';
  task?: TaskDefinition;
  occurrence?: TaskOccurrence;
  run: TaskRun;
  close: () => void;
  onSaved: () => void;
  onError: (error: unknown) => void;
  asset?: HomeAsset;
  recipe?: Recipe;
  template?: TaskTemplate;
}) {
  const session = state.session!,
    definition = mode !== 'occurrence',
    planning = mode !== 'definition';
  const initial = () => ({
    taskId: task?.recordId ?? crypto.randomUUID(),
    occurrenceId: occurrence?.recordId ?? crypto.randomUUID(),
    scopeId:
      task?.scopeId ??
      asset?.scopeId ??
      recipe?.scopeId ??
      session.scopes.find((scope) => scope.kind === 'private')!.scopeId,
    title: task?.title ?? template?.title ?? (recipe ? `Make ${recipe.title}`.slice(0, 300) : ''),
    instructions: task?.instructions ?? template?.instructions ?? '',
    context: task?.context ?? 'home',
    assigneeId: occurrence?.assigneeId ?? '',
    priority: String(occurrence?.priority ?? 1),
    defaultAssigneeId: task?.defaultAssigneeId ?? '',
    defaultPriority: String(task?.defaultPriority ?? 1),
    deadlineDate: occurrence?.deadlineDate ?? '',
    targetDate: occurrence?.targetDate ?? '',
    reviewDate: occurrence?.reviewDate ?? '',
    repeatUnit: task?.recurrence?.unit ?? 'off',
    repeatCount: String(task?.recurrence?.count ?? 1),
    timeZone: task?.recurrence?.timeZone ?? state.tasks.timeZone,
    maintenanceAssetId: task?.maintenance?.assetId ?? asset?.recordId ?? '',
    maintenanceReference: task?.maintenance?.reference ?? template?.maintenanceReference ?? '',
    cookingRecipeId: task?.cooking?.recipeId ?? recipe?.recordId ?? '',
  });
  const record = mode === 'occurrence' ? occurrence : task,
    key =
      record?.recordId ??
      (asset ? `task:new:${asset.recordId}` : recipe ? `task:recipe:${recipe.recordId}:new` : 'task:new') +
        (template ? `:template:${template.id}` : '');
  const buffer = useSavedForm(
      client,
      key,
      initial,
      record?.revision ?? 1,
      session.serverEpoch,
      onError,
      (saved) => ({
        maintenanceAssetId: task?.maintenance?.assetId ?? asset?.recordId ?? '',
        maintenanceReference: task?.maintenance?.reference ?? '',
        cookingRecipeId: task?.cooking?.recipeId ?? recipe?.recordId ?? '',
        ...saved,
      }),
    ),
    form = buffer.values;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    lock = useRef(false),
    finished = useRef(false);
  const targetId = mode === 'occurrence' ? form.occurrenceId : form.taskId,
    pending = state.pendingEdits.includes(targetId);
  const stale = (record && record.revision !== buffer.baseRevision) || session.serverEpoch !== buffer.epoch;
  const finish = async () => {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      onSaved();
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  };
  useEffect(() => {
    if (
      mode === 'create' &&
      buffer.ready &&
      state.tasks.definitions.some((item) => item.recordId === form.taskId)
    )
      void finish();
  }, [mode, buffer.ready, state.tasks.definitions, form.taskId]);
  const closeSaved = () => {
    void buffer.flush().then(close).catch(onError);
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!buffer.ready || busy || lock.current || pending || stale || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      const recurrence: TaskRecurrence | null =
        form.repeatUnit === 'off'
          ? null
          : {
              version: 1,
              mode: 'after_completion',
              count: Number(form.repeatCount),
              unit: form.repeatUnit as TaskRecurrence['unit'],
              timeZone: form.timeZone,
            };
      const details = {
        title: form.title,
        instructions: form.instructions,
        context: form.context,
        defaultAssigneeId: privateScope
          ? session.person.personId
          : (mode === 'create' ? form.assigneeId : form.defaultAssigneeId) || null,
        defaultPriority: Number(mode === 'create' ? form.priority : form.defaultPriority),
        recurrence,
        maintenance: form.maintenanceAssetId
          ? { assetId: form.maintenanceAssetId, reference: form.maintenanceReference }
          : null,
        cooking: form.cookingRecipeId ? { recipeId: form.cookingRecipeId } : null,
      };
      const plan = {
        assigneeId: privateScope ? session.person.personId : form.assigneeId || null,
        priority: Number(form.priority),
        deadlineDate: form.deadlineDate || null,
        targetDate: form.targetDate || null,
        reviewDate: form.reviewDate || null,
      };
      let kind: CommandKind, args: unknown;
      if (mode === 'create') {
        kind = 'CreateTask';
        args = {
          recordId: form.taskId,
          occurrenceId: form.occurrenceId,
          scopeId: form.scopeId,
          ...details,
          ...plan,
        };
      } else if (mode === 'definition') {
        kind = 'UpdateTaskDefinition';
        args = { recordId: form.taskId, expectedRevision: buffer.baseRevision, ...details };
      } else {
        kind = 'UpdateTaskOccurrence';
        args = { recordId: form.occurrenceId, expectedRevision: buffer.baseRevision, ...plan };
      }
      const result = await run(
        { recordId: targetId },
        kind,
        args,
        mode === 'create' ? 'Task added' : 'Task updated',
        buffer.epoch,
      );
      if (result?.status === 'Applied') await finish();
      else
        setError(
          result?.status === 'Rejected'
            ? result.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your form is kept.',
        );
    } catch (error) {
      onError(error);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const disabled = !buffer.ready || busy || pending || !state.online;
  const field = (key: keyof typeof form, label: string, type = 'text', required = false) => (
    <label className="task-field">
      {label}
      <input
        aria-label={label}
        type={type}
        value={form[key]}
        required={required}
        maxLength={300}
        onChange={(event) => buffer.field(key, event.target.value)}
      />
    </label>
  );
  const privateScope = session.scopes.find((scope) => scope.scopeId === form.scopeId)?.kind === 'private';
  const personField = (key: 'assigneeId' | 'defaultAssigneeId', label: string) => (
    <label className="task-field">
      {label}
      <select
        aria-label={label}
        value={privateScope ? session.person.personId : form[key]}
        disabled={privateScope}
        onChange={(event) => buffer.field(key, event.target.value)}
      >
        {!privateScope && <option value="">Unassigned</option>}
        {state.tasks.people
          .filter((person) => !privateScope || person.personId === session.person.personId)
          .map((person) => (
            <option key={person.personId} value={person.personId}>
              {person.displayName}
            </option>
          ))}
      </select>
    </label>
  );
  const priorityField = (key: 'priority' | 'defaultPriority', label: string) => (
    <label className="task-field">
      {label}
      <select
        aria-label={label}
        value={form[key]}
        onChange={(event) => buffer.field(key, event.target.value)}
      >
        {priorityNames.map((name, index) => (
          <option key={name} value={index}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <RecordDialog
      client={client}
      title={mode === 'create' ? 'New task' : mode === 'definition' ? 'Edit task' : 'Plan this occurrence'}
      subtitle={task?.title ?? 'A little room for what matters'}
      className="task-dialog"
      close={closeSaved}
    >
      {record && (
        <>
          <SecureRecord client={client} state={state} recordId={record.recordId} />
          <ShareRecord
            client={client}
            state={state}
            recordId={record.recordId}
            scopeId={record.scopeId}
            close={close}
          />
        </>
      )}
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
        <fieldset disabled={disabled}>
          {definition && (
            <>
              {field('title', 'Task title', 'text', true)}
              <label className="task-field">
                Instructions
                <textarea
                  aria-label="Instructions"
                  rows={3}
                  maxLength={20000}
                  value={form.instructions}
                  onChange={(event) => buffer.field('instructions', event.target.value)}
                />
              </label>
              <div className="task-form-row">
                <label className="task-field">
                  Home or work
                  <select
                    aria-label="Home or work"
                    value={form.context}
                    onChange={(event) => buffer.field('context', event.target.value)}
                  >
                    <option value="home">Home</option>
                    <option value="work">Work</option>
                  </select>
                </label>
                {mode === 'create' && (
                  <label className="task-field">
                    Who can see this
                    <select
                      aria-label="Who can see this"
                      value={form.scopeId}
                      onChange={(event) => {
                        buffer.field('scopeId', event.target.value);
                        buffer.field('maintenanceAssetId', '');
                        buffer.field('cookingRecipeId', '');
                        if (
                          session.scopes.find((scope) => scope.scopeId === event.target.value)?.kind ===
                          'private'
                        ) {
                          buffer.field('assigneeId', session.person.personId);
                          buffer.field('defaultAssigneeId', session.person.personId);
                        }
                      }}
                    >
                      {session.scopes.map((scope) => (
                        <option key={scope.scopeId} value={scope.scopeId}>
                          {scope.kind === 'shared' ? 'Shared' : 'Just me'}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <label className="task-field">
                Maintains (optional)
                <select
                  aria-label="Maintains (optional)"
                  value={form.maintenanceAssetId}
                  onChange={(event) => {
                    buffer.field('maintenanceAssetId', event.target.value);
                    if (event.target.value) buffer.field('cookingRecipeId', '');
                  }}
                >
                  <option value="">No linked appliance or system</option>
                  {state.home.assets
                    .filter(
                      (item) =>
                        item.scopeId === form.scopeId &&
                        item.deletedAt === null &&
                        (!item.archived || item.recordId === form.maintenanceAssetId),
                    )
                    .map((item) => (
                      <option key={item.recordId} value={item.recordId}>
                        {item.name}
                        {item.archived ? ' · archived' : ''}
                      </option>
                    ))}
                </select>
              </label>
              {form.maintenanceAssetId && (
                <>
                  <label className="task-field">
                    Maintenance reference
                    <textarea
                      aria-label="Maintenance reference"
                      rows={2}
                      maxLength={4096}
                      value={form.maintenanceReference}
                      onChange={(event) => buffer.field('maintenanceReference', event.target.value)}
                    />
                  </label>
                  <p className="fine">
                    Completing this task also records the work in the asset’s service log.
                  </p>
                </>
              )}
              <label className="task-field">
                Cooks (optional)
                <select
                  aria-label="Cooks (optional)"
                  value={form.cookingRecipeId}
                  onChange={(event) => {
                    buffer.field('cookingRecipeId', event.target.value);
                    if (event.target.value) buffer.field('maintenanceAssetId', '');
                  }}
                >
                  <option value="">No linked recipe</option>
                  {state.recipes.recipes
                    .filter(
                      (item) =>
                        item.scopeId === form.scopeId &&
                        item.deletedAt === null &&
                        (!item.archived || item.recordId === form.cookingRecipeId),
                    )
                    .map((item) => (
                      <option key={item.recordId} value={item.recordId}>
                        {item.title}
                        {item.archived ? ' · archived' : ''}
                      </option>
                    ))}
                </select>
              </label>
              {form.cookingRecipeId && (
                <p className="fine">
                  Completing this task also records when the recipe was cooked, who made it and your
                  completion note.
                </p>
              )}
            </>
          )}
          {planning && (
            <>
              <div className="task-form-row">
                {personField('assigneeId', 'Assigned to')}
                {priorityField('priority', 'Priority')}
              </div>
              <div className="task-form-row">
                {field('targetDate', 'Flexible target', 'date')}
                <RevisitDate
                  value={form.reviewDate}
                  targetDate={form.targetDate}
                  timeZone={state.tasks.timeZone}
                  onChange={(value) => buffer.field('reviewDate', value)}
                />
              </div>
              {field('deadlineDate', 'Actual deadline (optional)', 'date')}
              <p className="fine">
                Leave dates blank when priority is enough. Only an actual deadline can become overdue.
              </p>
            </>
          )}
          {definition && (
            <>
              <label className="task-field">
                Repeat after completion
                <select
                  aria-label="Repeat after completion"
                  value={form.repeatUnit}
                  onChange={(event) => buffer.field('repeatUnit', event.target.value)}
                >
                  <option value="off">Does not repeat</option>
                  <option value="days">Days after it is done</option>
                  <option value="weeks">Weeks after it is done</option>
                  <option value="months">Months after it is done</option>
                </select>
              </label>
              {form.repeatUnit !== 'off' && (
                <>
                  <label className="task-field">
                    Repeat every
                    <input
                      aria-label="Repeat every"
                      type="number"
                      required
                      min={1}
                      max={365}
                      step={1}
                      value={form.repeatCount}
                      onChange={(event) => buffer.field('repeatCount', event.target.value)}
                    />
                  </label>
                  <p className="fine">
                    The next target follows the actual completion date, in {form.timeZone}. Existing
                    completion history stays intact.
                  </p>
                  {mode === 'definition' && (
                    <div className="task-form-row">
                      {personField('defaultAssigneeId', 'Future assignee')}
                      {priorityField('defaultPriority', 'Future priority')}
                    </div>
                  )}
                </>
              )}
              {mode === 'definition' && (
                <p className="fine">Use Plan on the task to change its current dates, person or priority.</p>
              )}
            </>
          )}
        </fieldset>
        {stale && (
          <div className="notice">
            This task or server changed. Your form is kept.
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
          <span className="fine">
            {pending
              ? 'Waiting for confirmation'
              : !state.online
                ? 'Connect to save. Inbox can capture offline.'
                : 'Unfinished text stays on this device · Ctrl ↵ to save'}
          </span>
          <button className="primary" disabled={disabled || !!stale}>
            {busy ? 'Saving…' : mode === 'create' ? 'Add task' : 'Save changes'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
