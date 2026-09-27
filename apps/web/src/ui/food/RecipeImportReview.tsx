import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { Recipe, RecipeImportDetails, RecipeImportField } from '@our-place/contracts';
import { RecordDialog } from '../RecordDialog.js';
import { useSavedForm } from '../useSavedForm.js';
import { Photo } from '../Photo.js';
import { recipeDuration } from './format.js';
const labels: Record<RecipeImportField, string> = {
  title: 'Name',
  description: 'Description',
  author: 'Author',
  yieldText: 'Servings',
  times: 'Times',
  ingredients: 'Ingredients',
  steps: 'Directions',
  photo: 'Source picture',
};
const defaults = (candidate: RecipeImportDetails['candidates'][number] | undefined) =>
  candidate
    ? [
        ...(candidate.kind === 'bookmark'
          ? ['title', 'description']
          : ['title', 'description', 'author', 'yieldText', 'times', 'ingredients', 'steps']),
        ...(candidate.image ? ['photo'] : []),
      ]
    : [];
export function RecipeImportReview(props: {
  client: ClientPlatform;
  state: ClientState;
  recipe: Recipe;
  importId: string;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const [detail, setDetail] = useState<RecipeImportDetails | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void props.client
      .recipeImport(props.importId)
      .then((value) => {
        if (alive) setDetail(value);
      })
      .catch((error) => {
        if (alive) setError(error instanceof Error ? error.message : 'Could not read the saved import.');
      });
    return () => {
      alive = false;
    };
  }, [props.client, props.importId]);
  if (detail) return <Review {...props} detail={detail} />;
  return (
    <RecordDialog
      client={props.client}
      title="Review recipe import"
      subtitle={props.recipe.title}
      close={props.close}
    >
      <p className="notice">{error || 'Loading saved recipe details…'}</p>
    </RecordDialog>
  );
}
function Review({
  client,
  state,
  recipe,
  detail,
  run,
  close,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  recipe: Recipe;
  detail: RecipeImportDetails;
  run: RunRecordCommand;
  close: () => void;
  onError: (error: unknown) => void;
}) {
  const buffer = useSavedForm(
    client,
    `food:import:${detail.importId}`,
    () => ({
      candidateId: detail.candidates[0]?.candidateId ?? '',
      fields: JSON.stringify(defaults(detail.candidates[0])),
    }),
    recipe.revision,
    state.session!.serverEpoch,
    onError,
  );
  const candidate = detail.candidates.find((c) => c.candidateId === buffer.values.candidateId),
    selected = JSON.parse(buffer.values.fields) as RecipeImportField[];
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    lock = useRef(false),
    stale = recipe.revision !== buffer.baseRevision || state.session!.serverEpoch !== buffer.epoch;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !candidate ||
      lock.current ||
      stale ||
      !state.online ||
      state.pendingEdits.includes(recipe.recordId) ||
      !buffer.ready
    )
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await buffer.save();
      const fields = selected.filter((field) => field !== 'photo' || candidate.image);
      if (!fields.length) throw new Error('Choose at least one part to apply.');
      const outcome = await run(
        recipe,
        'ApplyRecipeImport',
        {
          recordId: recipe.recordId,
          expectedRevision: buffer.baseRevision,
          importId: detail.importId,
          candidateId: candidate.candidateId,
          fields,
        },
        'Recipe import applied',
        buffer.epoch,
      );
      if (outcome?.status === 'Applied') {
        await buffer.clear();
        close();
      } else
        setError(
          outcome?.status === 'Rejected'
            ? outcome.code.replaceAll('_', ' ')
            : 'Waiting for confirmation. Your choices are kept.',
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not apply import.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <RecordDialog
      client={client}
      title="Review recipe import"
      subtitle={recipe.title}
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
        <p className="fine">
          Choose a recipe and the details to use. Your adjustments, collections and personal photos stay with
          it.
        </p>
        <fieldset disabled={!buffer.ready || busy || state.pendingEdits.includes(recipe.recordId)}>
          <label className="task-field">
            Recipe found on page
            <select
              aria-label="Recipe found on page"
              value={buffer.values.candidateId}
              onChange={(e) => {
                buffer.field('candidateId', e.target.value);
                buffer.field(
                  'fields',
                  JSON.stringify(defaults(detail.candidates.find((c) => c.candidateId === e.target.value))),
                );
              }}
            >
              {detail.candidates.map((c) => (
                <option key={c.candidateId} value={c.candidateId}>
                  {c.title}
                </option>
              ))}
            </select>
          </label>
          {candidate && (
            <>
              <div className="food-import-photo">
                {candidate.image && (
                  <Photo client={client} id={candidate.image.mediaId} descriptor={candidate.image} />
                )}
              </div>
              <h3>{candidate.title}</h3>
              <p className="food-text">{candidate.description}</p>
              <div className="food-meta">
                {candidate.author && <span>By {candidate.author}</span>}
                {candidate.yieldText && <span>{candidate.yieldText}</span>}
                {recipeDuration(candidate.prepTime) && (
                  <span>Prep · {recipeDuration(candidate.prepTime)}</span>
                )}
                {recipeDuration(candidate.cookTime) && (
                  <span>Cook · {recipeDuration(candidate.cookTime)}</span>
                )}
                {recipeDuration(candidate.totalTime) && (
                  <span>Total · {recipeDuration(candidate.totalTime)}</span>
                )}
              </div>
              <div className="food-import-fields">
                {(Object.keys(labels) as RecipeImportField[])
                  .filter((field) => field !== 'photo' || candidate.image)
                  .map((field) => (
                    <label key={field}>
                      <input
                        type="checkbox"
                        checked={selected.includes(field)}
                        onChange={(e) =>
                          buffer.field(
                            'fields',
                            JSON.stringify(
                              e.target.checked ? [...selected, field] : selected.filter((x) => x !== field),
                            ),
                          )
                        }
                      />
                      {labels[field]}
                    </label>
                  ))}
              </div>
              {candidate.kind === 'bookmark' && (
                <p className="notice">
                  This page supplied a link preview. Leave Ingredients and Directions unchecked to keep your
                  current recipe.
                </p>
              )}
              <details>
                <summary>Preview ingredients and directions</summary>
                <ul>
                  {candidate.ingredients.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
                <ol>
                  {candidate.steps.map((text, i) => (
                    <li key={i} className="food-text">
                      {text}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </fieldset>
        {stale && (
          <p className="notice">
            The recipe changed while this review was open.{' '}
            <button
              type="button"
              onClick={() => {
                void buffer.reset().catch(onError);
              }}
            >
              Review against the latest version
            </button>
          </p>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="primary"
            disabled={
              busy || stale || !buffer.ready || !state.online || state.pendingEdits.includes(recipe.recordId)
            }
          >
            Apply selected details
          </button>
        </div>
      </form>
    </RecordDialog>
  );
}
