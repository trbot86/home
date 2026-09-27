import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { emptyRecipeFields, type Recipe, type RecipeFields } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';

function lines(text: string, old: { text: string; id: string }[], split: RegExp) {
  const available = [...old];
  return text
    .split(split)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((text) => {
      const index = available.findIndex((row) => row.text === text),
        previous = index < 0 ? undefined : available.splice(index, 1)[0];
      return { id: previous?.id ?? crypto.randomUUID(), text };
    });
}
export function RecipeEditor({
  client,
  state,
  recipe,
  run,
  close,
  onSaved,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  recipe?: Recipe;
  run: RunRecordCommand;
  close: () => void;
  onSaved: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const session = state.session!;
  const initial = () => ({
    recordId: recipe?.recordId ?? crypto.randomUUID(),
    importId: crypto.randomUUID(),
    wantToTryId: crypto.randomUUID(),
    favouritesId: crypto.randomUUID(),
    scopeId: recipe?.scopeId ?? session.scopes.find((s) => s.kind === 'shared')!.scopeId,
    mode: recipe ? 'manual' : 'link',
    title: recipe?.title ?? '',
    sourceUrl: recipe?.sourceUrl ?? '',
    description: recipe?.description ?? '',
    author: recipe?.author ?? '',
    yieldText: recipe?.yieldText ?? '',
    prepMinutes: String(recipe?.prepTime.minutes ?? ''),
    cookMinutes: String(recipe?.cookTime.minutes ?? ''),
    totalMinutes: String(recipe?.totalTime.minutes ?? ''),
    ingredients: recipe?.ingredients.map((row) => row.text).join('\n') ?? '',
    steps: recipe?.steps.map((row) => row.text).join('\n\n') ?? '',
  });
  const buffer = useSavedForm(
    client,
    recipe?.recordId ?? 'food:recipe:new',
    initial,
    recipe?.revision ?? 1,
    session.serverEpoch,
    onError,
  );
  const form = buffer.values,
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [existing, setExisting] = useState<string | null>(null);
  const lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(form.recordId),
    stale = (recipe && recipe.revision !== buffer.baseRevision) || buffer.epoch !== session.serverEpoch;
  const finish = async (id = form.recordId) => {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      onSaved(id);
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  };
  useEffect(() => {
    if (!recipe && buffer.ready && state.recipes.recipes.some((r) => r.recordId === form.recordId))
      void finish();
  }, [recipe, buffer.ready, state.recipes, form.recordId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || pending || stale || !buffer.ready || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setExisting(null);
    try {
      await buffer.save();
      let url: string | null = null;
      if (form.sourceUrl.trim()) {
        const parsed = new URL(form.sourceUrl.trim());
        if (!['https:', 'http:'].includes(parsed.protocol))
          throw new Error('Use a web link beginning with https:// or http://.');
        parsed.hash = '';
        url = parsed.href;
      }
      if (!recipe && url) {
        const duplicate = state.recipes.recipes.find(
          (r) =>
            r.scopeId === form.scopeId &&
            r.deletedAt === null &&
            (r.sourceUrl === url ||
              state.recipeImports.some((job) => job.recipeId === r.recordId && job.sourceUrl === url)),
        );
        if (duplicate) {
          setExisting(duplicate.recordId);
          return;
        }
      }
      let collectionIds: string[] = [];
      if (!recipe) {
        const ensured = await run(
          { recordId: form.recordId },
          'EnsureRecipeCollections',
          { scopeId: form.scopeId, wantToTryId: form.wantToTryId, favouritesId: form.favouritesId },
          'Recipe collections ready',
          buffer.epoch,
        );
        if (ensured?.status !== 'Applied')
          throw new Error('Waiting for the recipe collections. Your form is saved.');
        const latest = await client.state();
        const collection = latest.recipes.collections.find(
          (c) => c.scopeId === form.scopeId && c.role === 'want_to_try' && c.deletedAt === null,
        );
        if (!collection) throw new Error('Refresh the collections and try again. Your form is saved.');
        collectionIds = [collection.recordId];
      }
      const duration = (value: string, old: RecipeFields['prepTime'] | undefined) =>
        value === String(old?.minutes ?? '')
          ? (old ?? { text: '', minutes: null })
          : value
            ? { text: `${value} min`, minutes: Number(value) }
            : { text: '', minutes: null };
      const fields: RecipeFields = {
        ...emptyRecipeFields(),
        title: form.title.trim(),
        description: form.description,
        sourceUrl: url,
        author: form.author,
        yieldText: form.yieldText,
        prepTime: duration(form.prepMinutes, recipe?.prepTime),
        cookTime: duration(form.cookMinutes, recipe?.cookTime),
        totalTime: duration(form.totalMinutes, recipe?.totalTime),
        ingredients: lines(
          form.ingredients,
          recipe?.ingredients.map((r) => ({ id: r.ingredientId, text: r.text })) ?? [],
          /\r?\n/,
        ).map(({ id, text }) => ({ ingredientId: id, text })),
        steps: lines(
          form.steps,
          recipe?.steps.map((r) => ({ id: r.stepId, text: r.text })) ?? [],
          /\r?\n\s*\r?\n/,
        ).map(({ id, text }) => ({ stepId: id, text })),
      };
      const kind = recipe ? 'UpdateRecipe' : form.mode === 'link' ? 'ImportRecipe' : 'CreateRecipe';
      if (kind === 'ImportRecipe' && !url) throw new Error('Paste a recipe link first.');
      const args =
        kind === 'ImportRecipe'
          ? { recordId: form.recordId, importId: form.importId, scopeId: form.scopeId, url, collectionIds }
          : {
              ...fields,
              recordId: form.recordId,
              ...(recipe
                ? { expectedRevision: buffer.baseRevision }
                : { scopeId: form.scopeId, collectionIds }),
            };
      const outcome = await run(
        { recordId: form.recordId },
        kind,
        args,
        recipe ? 'Recipe updated' : 'Recipe saved',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') await finish();
      else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your form is saved.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not save recipe.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const input = (name: keyof typeof form, label: string, type = 'text', required = false) => (
    <label className="task-field">
      {label}
      <input
        aria-label={label}
        type={type}
        required={required}
        min={type === 'number' ? 0 : undefined}
        max={type === 'number' ? 5256000 : undefined}
        step={type === 'number' ? 'any' : undefined}
        maxLength={name === 'sourceUrl' ? 4096 : name === 'title' || name === 'yieldText' ? 300 : 500}
        value={form[name]}
        onChange={(e) => buffer.field(name, e.target.value)}
      />
    </label>
  );
  const textarea = (name: 'description' | 'ingredients' | 'steps', label: string, help?: string) => (
    <label className="task-field">
      {label}
      <textarea
        aria-label={label}
        rows={name === 'description' ? 3 : 6}
        value={form[name]}
        maxLength={name === 'description' ? 10000 : 100000}
        onChange={(e) => buffer.field(name, e.target.value)}
      />
      {help && <span className="fine">{help}</span>}
    </label>
  );
  return (
    <RecordDialog
      client={client}
      title={recipe ? 'Edit recipe' : 'Save a recipe'}
      subtitle="Food to look forward to"
      className="task-dialog food-dialog"
      close={() => {
        void buffer.flush().then(close).catch(onError);
      }}
    >
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
          {!recipe && (
            <div className="food-segment">
              <button
                type="button"
                aria-pressed={form.mode === 'link'}
                onClick={() => buffer.field('mode', 'link')}
              >
                Paste a link
              </button>
              <button
                type="button"
                aria-pressed={form.mode === 'manual'}
                onClick={() => buffer.field('mode', 'manual')}
              >
                Write a recipe
              </button>
            </div>
          )}
          {input('sourceUrl', 'Recipe source link', 'url', form.mode === 'link')}
          {form.mode === 'link' ? (
            <p className="fine">
              Save to Want to try now. We’ll collect the recipe and its picture in the background. You can
              edit any missing details.
            </p>
          ) : (
            <>
              {input('title', 'Recipe name', 'text', true)}
              {textarea('description', 'Description')}
              <div className="task-form-row">
                {input('author', 'Author')}
                {input('yieldText', 'Makes / servings')}
              </div>
              <div className="food-times">
                {input('prepMinutes', 'Prep minutes', 'number')}
                {input('cookMinutes', 'Cook minutes', 'number')}
                {input('totalMinutes', 'Total minutes', 'number')}
              </div>
              {textarea('ingredients', 'Ingredients', 'One ingredient per line. Keep quantities as written.')}
              {textarea('steps', 'Directions', 'Separate steps with a blank line.')}
            </>
          )}
          {!recipe && (
            <label className="task-field">
              Who can see this
              <select
                aria-label="Who can see this"
                value={form.scopeId}
                onChange={(e) => buffer.field('scopeId', e.target.value)}
              >
                {session.scopes.map((s) => (
                  <option key={s.scopeId} value={s.scopeId}>
                    {s.kind === 'shared' ? 'Shared' : 'Just me'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </fieldset>
        {existing && (
          <p className="notice">
            This recipe is already saved.{' '}
            <button
              type="button"
              onClick={() => {
                void finish(existing);
              }}
            >
              Open existing recipe
            </button>
          </p>
        )}
        {stale && (
          <p className="notice">
            This recipe changed since you started. Your text is kept. Copy anything you need, then{' '}
            <button
              type="button"
              onClick={() => {
                void buffer.reset().catch(onError);
              }}
            >
              load the latest version
            </button>
            .
          </p>
        )}
        {!state.online && <p className="fine">You can keep writing. Reconnect to save to the household.</p>}
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
          <button className="primary" disabled={!buffer.ready || busy || pending || !!stale || !state.online}>
            {busy ? 'Saving…' : recipe ? 'Save changes' : 'Save to Want to try'}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
