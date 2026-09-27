import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { Recipe } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
type Selection = {
  ingredientId: string;
  entryId: string;
  sourceId: string;
  text: string;
  selected: boolean;
  label: string;
  quantity: string;
};
function readSelection(text: string): Selection[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !Array.isArray(value) ||
      value.some(
        (row) =>
          !row ||
          typeof row !== 'object' ||
          typeof row.selected !== 'boolean' ||
          ['ingredientId', 'entryId', 'sourceId', 'text', 'label', 'quantity'].some(
            (key) => typeof row[key] !== 'string',
          ),
      )
    )
      return null;
    return value as Selection[];
  } catch {
    return null;
  }
}
export function RecipeShopping({
  client,
  state,
  recipe,
  run,
  close,
  onError,
  onOpenShopping,
}: {
  client: ClientPlatform;
  state: ClientState;
  recipe: Recipe;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
  onOpenShopping: () => void;
}) {
  const lists = state.shopping.lists.filter((l) => !l.deletedAt && l.scopeId === recipe.scopeId);
  const session = state.session!;
  const buffer = useSavedForm(
    client,
    `food:shopping:${recipe.recordId}`,
    () => ({
      recordId: crypto.randomUUID(),
      name: recipe.title,
      listId: lists[0]?.recordId ?? '',
      listRevision: String(lists[0]?.revision ?? 1),
      selection: JSON.stringify(
        recipe.ingredients.map((i) => ({
          ingredientId: i.ingredientId,
          entryId: crypto.randomUUID(),
          sourceId: crypto.randomUUID(),
          text: i.text,
          selected: true,
          label: i.text.length <= 300 ? i.text : '',
          quantity: '',
        })),
      ),
    }),
    recipe.revision,
    session.serverEpoch,
    onError,
  );
  const form = buffer.values,
    rows = readSelection(form.selection),
    chosen = rows?.filter((i) => i.selected) ?? [],
    list = lists.find((l) => l.recordId === form.listId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    lock = useRef(false),
    finished = useRef(false);
  const pending = state.pendingEdits.includes(form.recordId),
    stale =
      recipe.revision !== buffer.baseRevision ||
      recipe.deletedAt !== null ||
      session.serverEpoch !== buffer.epoch ||
      (list && list.revision !== Number(form.listRevision));
  const valid =
    !!list &&
    !!rows &&
    chosen.length > 0 &&
    chosen.length <= 100 &&
    !!form.name.trim() &&
    chosen.every((i) => i.label.trim() && i.label.length <= 300 && i.quantity.length <= 120);
  async function finish() {
    if (finished.current) return;
    finished.current = true;
    try {
      await buffer.clear();
      close();
    } catch (error) {
      finished.current = false;
      onError(error);
    }
  }
  useEffect(() => {
    if (buffer.ready && (state.shopping.groups ?? []).some((g) => g.recordId === form.recordId))
      void finish();
  }, [buffer.ready, state.shopping.groups, form.recordId]);
  function edit(id: string, fields: Partial<Selection>) {
    buffer.field(
      'selection',
      JSON.stringify(rows!.map((row) => (row.ingredientId === id ? { ...row, ...fields } : row))),
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || !buffer.ready || !state.online || pending || stale || !valid) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      const outcome = await run(
        { recordId: form.recordId },
        'AddRecipeIngredients',
        {
          recordId: form.recordId,
          recipeId: recipe.recordId,
          expectedRecipeRevision: buffer.baseRevision,
          listId: form.listId,
          expectedListRevision: Number(form.listRevision),
          name: form.name,
          ingredients: chosen.map(({ ingredientId, entryId, sourceId, label, quantity }) => ({
            ingredientId,
            entryId,
            sourceId,
            label,
            quantity,
            notes: '',
          })),
        },
        'Recipe ingredients added to shopping',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') await finish();
      else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your selection is saved here.',
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
      title="Shop for this recipe"
      subtitle={recipe.title}
      className="task-dialog food-dialog"
      close={() => void buffer.flush().then(close).catch(onError)}
    >
      <form
        className="task-form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
          }
        }}
      >
        <p className="fine">
          Choose what you need; uncheck anything already at home. Each selection becomes a new item in a named
          group.
        </p>
        <fieldset disabled={!buffer.ready || busy || pending}>
          <label className="task-field">
            Shopping list
            <select
              aria-label="Ingredient shopping list"
              value={form.listId}
              onChange={(e) => {
                buffer.field('listId', e.target.value);
                buffer.field(
                  'listRevision',
                  String(lists.find((l) => l.recordId === e.target.value)!.revision),
                );
              }}
            >
              {!list && <option value={form.listId}>Choose a list</option>}
              {lists.map((l) => (
                <option key={l.recordId} value={l.recordId}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          {!lists.length && (
            <p className="notice">
              Create a{' '}
              {session.scopes.find((s) => s.scopeId === recipe.scopeId)?.kind === 'private'
                ? 'private'
                : 'shared'}{' '}
              shopping list first.{' '}
              <button type="button" onClick={() => void buffer.flush().then(onOpenShopping).catch(onError)}>
                Open shopping
              </button>
            </p>
          )}
          <label className="task-field">
            Group name
            <input
              aria-label="Ingredient group name"
              value={form.name}
              maxLength={300}
              required
              onChange={(e) => buffer.field('name', e.target.value)}
            />
          </label>
          <div className="recipe-shopping-choices">
            {rows?.map((row) => (
              <div className="recipe-shopping-choice" key={row.ingredientId}>
                <label className="recipe-shopping-check">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    aria-label={`Include ${row.text}`}
                    onChange={(e) => edit(row.ingredientId, { selected: e.target.checked })}
                  />
                  <span>{row.text}</span>
                </label>
                {row.selected && (
                  <div className="recipe-shopping-fields">
                    <label className="task-field">
                      Shopping item
                      <input
                        aria-label={`Shopping item for ${row.text}`}
                        required
                        maxLength={300}
                        value={row.label}
                        placeholder="Short name for the list"
                        onChange={(e) => edit(row.ingredientId, { label: e.target.value })}
                      />
                    </label>
                    <label className="task-field">
                      Quantity (optional)
                      <input
                        aria-label={`Quantity for ${row.text}`}
                        maxLength={120}
                        value={row.quantity}
                        onChange={(e) => edit(row.ingredientId, { quantity: e.target.value })}
                      />
                    </label>
                  </div>
                )}
                {row.selected && row.text.length > 300 && (
                  <p className="fine">
                    Give this long ingredient a short name. Its full text stays with the shopping item.
                  </p>
                )}
              </div>
            ))}
          </div>
        </fieldset>
        <p className="fine">
          Original ingredient text is kept. Quantities aren’t guessed, combined or scaled.
        </p>
        {chosen.length > 100 && (
          <p role="alert" className="notice">
            Choose up to 100 ingredients at a time.
          </p>
        )}
        {(stale || !rows) && (
          <div className="notice">
            <p>
              The recipe, list or server changed, or this saved selection needs recovery. Your draft is kept.
            </p>
            <button
              type="button"
              disabled={pending || busy || !state.online}
              onClick={() => void buffer.reset().catch(onError)}
            >
              Reload latest recipe and lists
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
                ? 'Connect to add ingredients'
                : 'Selection saved on this device · Ctrl ↵ to add'}
          </span>
          <button
            className="primary"
            disabled={!buffer.ready || !state.online || pending || busy || !!stale || !valid}
          >
            {busy ? 'Adding…' : `Add ${chosen.length} ${chosen.length === 1 ? 'item' : 'items'} to shopping`}
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
