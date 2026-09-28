import { ShareRecord } from '../ShareRecord.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { Recipe, RecipeAdjustment, RecipeCookingRecord } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { localDateTime } from '../tasks/shared.js';
export function RecipeJournalEditor({
  client,
  state,
  recipe,
  mode,
  adjustment,
  cooking,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  recipe: Recipe;
  mode: 'adjustment' | 'cooking';
  adjustment?: RecipeAdjustment;
  cooking?: RecipeCookingRecord;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!,
    record = mode === 'adjustment' ? recipe : cooking;
  const buffer = useSavedForm(
    client,
    mode === 'adjustment'
      ? `food:adjustment:${recipe.recordId}:${adjustment?.adjustmentId ?? 'new'}`
      : (cooking?.recordId ?? `food:cooking:${recipe.recordId}:new`),
    () => ({
      id: adjustment?.adjustmentId ?? cooking?.recordId ?? crypto.randomUUID(),
      body: adjustment?.body ?? cooking?.notes ?? '',
      cookedAt: localDateTime(cooking?.cookedAt ?? Date.now()),
      cookedByPersonId: cooking?.cookedByPersonId ?? session.person.personId,
    }),
    record?.revision ?? 1,
    session.serverEpoch,
    onError,
  );
  const form = buffer.values,
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    lock = useRef(false),
    finished = useRef(false);
  const target = mode === 'adjustment' ? recipe.recordId : form.id,
    pending = state.pendingEdits.includes(target),
    stale = (record && record.revision !== buffer.baseRevision) || session.serverEpoch !== buffer.epoch;
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
    if (
      buffer.ready &&
      !cooking &&
      mode === 'cooking' &&
      state.recipes.cookingRecords.some((r) => r.recordId === form.id)
    )
      void finish();
  }, [buffer.ready, state.recipes, form.id]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || pending || stale || !state.online || !buffer.ready) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      const cookedAt =
        cooking && (cooking.completionId || form.cookedAt === localDateTime(cooking.cookedAt))
          ? cooking.cookedAt
          : new Date(form.cookedAt).getTime();
      if (mode === 'cooking' && (!Number.isFinite(cookedAt) || localDateTime(cookedAt) !== form.cookedAt))
        throw new Error('Choose a valid date and time.');
      const args =
        mode === 'adjustment'
          ? {
              recordId: recipe.recordId,
              expectedRevision: buffer.baseRevision,
              adjustmentId: form.id,
              body: form.body,
            }
          : {
              recordId: form.id,
              ...(cooking
                ? { expectedRevision: buffer.baseRevision }
                : { recipeId: recipe.recordId, scopeId: recipe.scopeId }),
              cookedAt,
              cookedByPersonId: form.cookedByPersonId || null,
              notes: form.body,
            };
      const outcome = await run(
        { recordId: target },
        mode === 'adjustment'
          ? 'SetRecipeAdjustment'
          : cooking
            ? 'UpdateRecipeCookingRecord'
            : 'CreateRecipeCookingRecord',
        args,
        mode === 'adjustment' ? 'Adjustment saved' : 'Cooking recorded',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') await finish();
      else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your note is saved here.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <RecordDialog
      client={client}
      title={mode === 'adjustment' ? 'Our adjustment' : cooking ? 'Edit cooking notes' : 'Record cooking'}
      subtitle={recipe.title}
      className="task-dialog food-dialog"
      close={() => {
        void buffer.flush().then(close).catch(onError);
      }}
    >
      {record && (
        <ShareRecord
          client={client}
          state={state}
          recordId={record.recordId}
          scopeId={record.scopeId}
          close={close}
        />
      )}
      <form
        className="task-form"
        onSubmit={(e) => {
          void submit(e);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        <fieldset disabled={!buffer.ready || busy || pending}>
          {mode === 'cooking' && (
            <>
              <label className="task-field">
                Cooked at
                <input
                  aria-label="Cooked at"
                  type="datetime-local"
                  required
                  readOnly={!!cooking?.completionId}
                  value={form.cookedAt}
                  onChange={(e) => buffer.field('cookedAt', e.target.value)}
                />
              </label>
              <label className="task-field">
                Cooked by
                <select
                  aria-label="Cooked by"
                  disabled={!!cooking?.completionId}
                  value={form.cookedByPersonId}
                  onChange={(e) => buffer.field('cookedByPersonId', e.target.value)}
                >
                  <option value="">Not recorded</option>
                  {state.tasks.people
                    .filter(
                      (p) =>
                        session.scopes.find((s) => s.scopeId === recipe.scopeId)?.kind === 'shared' ||
                        p.personId === session.person.personId,
                    )
                    .map((p) => (
                      <option key={p.personId} value={p.personId}>
                        {p.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <p className="fine">
                {cooking?.completionId
                  ? 'The cooking date and person come from the task completion. Use its history to undo that action; you can edit these meal notes and photos here.'
                  : 'Keep a record of this meal. This won’t complete an open task or change your favourites.'}
              </p>
            </>
          )}
          <label className="task-field">
            {mode === 'adjustment' ? 'Adjustment' : 'Cooking notes'}
            <textarea
              aria-label={mode === 'adjustment' ? 'Adjustment' : 'Cooking notes'}
              required={mode === 'adjustment'}
              maxLength={20000}
              rows={7}
              value={form.body}
              onChange={(e) => buffer.field('body', e.target.value)}
            />
          </label>
        </fieldset>
        {stale && (
          <p className="notice">
            This record changed. Your writing is kept. Copy it before{' '}
            <button
              type="button"
              onClick={() => {
                void buffer.reset().catch(onError);
              }}
            >
              loading the latest version
            </button>
            .
          </p>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            disabled={busy || pending}
            onClick={() => {
              void buffer.reset().catch(onError);
            }}
          >
            Reset form
          </button>
          <button className="primary" disabled={busy || pending || !buffer.ready || !state.online || !!stale}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
