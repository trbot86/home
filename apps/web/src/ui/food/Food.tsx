import { useNavigationState } from '../NavigationHistory.js';
import { CaptureSources } from '../inbox/FilingLinks.js';
import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type { CommandKind, Recipe, RecipeRecord } from '@our-place/contracts';
import { RecipeEditor } from './RecipeEditor.js';
import { RecipeJournalEditor } from './RecipeJournalEditor.js';
import { RecipeImportReview } from './RecipeImportReview.js';
import { RecipeHistory } from './RecipeHistory.js';
import { RecipeTasks } from './RecipeTasks.js';
import { RecipeShopping } from './RecipeShopping.js';
import { recipeDuration } from './format.js';
import { AttachmentDialog, type AttachmentSaved } from '../AttachmentDialog.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { Photo } from '../Photo.js';
import { Icon } from '../Icon.js';
import { dateWithYear } from '../format.js';
import '../tasks/tasks.css';
import './food.css';
const importLabels: Record<string, string> = {
  queued: 'Waiting to collect recipe',
  running: 'Collecting recipe details…',
  ready: 'Preparing recipe details…',
  review: 'Ready for your review',
  failed: 'Import needs attention',
  paused: 'Import paused after recovery',
  abandoned: 'Import cancelled',
  complete: 'Recipe details saved',
};
export function Food({
  client,
  state,
  run,
  onError,
  onPhotosSaved,
  initialRecipeId,
  initialRecordId,
  onOpenShopping,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
  onError: (error: unknown) => void;
  onPhotosSaved: AttachmentSaved;
  initialRecipeId?: string | null;
  initialRecordId?: string | null;
  onOpenShopping: () => void;
}) {
  const initialCollection = state.recipes.collections.find((c) => c.recordId === initialRecordId);
  const initialCooking = state.recipes.cookingRecords.find((c) => c.recordId === initialRecordId);
  const initialRecipe = state.recipes.recipes.find(
    (r) => r.recordId === (initialRecipeId ?? initialCooking?.recipeId ?? initialRecordId),
  );
  const [view, setView] = useNavigationState(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.view`,
      initialCollection ? `collection:${initialCollection.recordId}` : initialRecipe ? 'all' : 'want_to_try',
    ),
    [scope, setScope] = useState('all'),
    [search, setSearch] = useState(''),
    [limit, setLimit] = useState(24),
    [cookingLimit, setCookingLimit] = useState(20),
    [selected, setSelected] = useNavigationState<string | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.selected`,
      initialRecipe?.recordId ?? null,
    );
  const [editor, setEditor] = useNavigationState<'new' | 'edit' | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.editor`,
      null,
    ),
    [journal, setJournal] = useNavigationState<{ mode: 'adjustment' | 'cooking'; id?: string } | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.journal`,
      null,
    ),
    [photosId, setPhotosId] = useNavigationState<string | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.photosId`,
      null,
    ),
    [historyId, setHistoryId] = useNavigationState<string | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.historyId`,
      initialCooking?.recordId ?? null,
    ),
    [review, setReview] = useNavigationState<string | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.review`,
      null,
    ),
    [shopping, setShopping] = useNavigationState(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.shopping`,
      false,
    ),
    [removing, setRemoving] = useNavigationState<string | null>(
      `Food.${initialRecipeId ?? initialRecordId ?? ''}.removing`,
      null,
    );
  const [working, setWorking] = useState<string[]>([]),
    locks = useRef(new Set<string>()),
    detailRef = useRef<HTMLElement>(null);
  const snapshot = state.recipes,
    records: RecipeRecord[] = [...snapshot.recipes, ...snapshot.collections, ...snapshot.cookingRecords];
  const recipe = snapshot.recipes.find((r) => r.recordId === selected),
    photos = records.find((r) => r.recordId === photosId),
    history = records.find((r) => r.recordId === historyId);
  const pins = new Set(
    state.views.filter((v) => v.kind === 'food_soon').flatMap((v) => v.pins.map((p) => p.recordId)),
  );
  const collections = snapshot.collections.filter((c) => c.deletedAt === null);
  const visible = snapshot.recipes
    .filter((r) => {
      if (scope !== 'all' && r.scopeId !== scope) return false;
      if (view === 'deleted' ? r.deletedAt === null : r.deletedAt !== null) return false;
      if (view !== 'deleted' && r.archived !== (view === 'archived')) return false;
      if (
        ['want_to_try', 'favourites'].includes(view) &&
        !collections.some((c) => c.role === view && r.collectionIds.includes(c.recordId))
      )
        return false;
      if (view === 'soon' && !pins.has(r.recordId)) return false;
      if (view.startsWith('collection:') && !r.collectionIds.includes(view.slice(11))) return false;
      return `${r.title} ${r.description} ${r.author} ${r.ingredients.map((i) => i.text).join(' ')}`
        .toLowerCase()
        .includes(search.toLowerCase());
    })
    .sort((a, b) => b.createdAt - a.createdAt || a.title.localeCompare(b.title));
  const imports = state.recipeImports,
    currentImport = imports.find((row) => row.recipeId === selected);
  const cooking = snapshot.cookingRecords
    .filter((c) => c.recipeId === selected && c.deletedAt === null)
    .sort((a, b) => b.cookedAt - a.cookedAt);
  const hasCookingTasks = state.tasks.definitions.some(
    (t) => t.cooking?.recipeId === selected && t.deletedAt === null,
  );
  const editingAdjustment =
    journal?.mode === 'adjustment'
      ? recipe?.adjustments.find((a) => a.adjustmentId === journal.id)
      : undefined;
  const editingCooking =
    journal?.mode === 'cooking' ? snapshot.cookingRecords.find((c) => c.recordId === journal.id) : undefined;
  const pending = (id: string) => state.pendingEdits.includes(id) || working.includes(id);
  const disabled = (id: string) => !state.online || pending(id);
  const choose = (id: string) => {
    setSelected(id);
    setRemoving(null);
    setCookingLimit(20);
  };
  useEffect(() => {
    if (selected) detailRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [selected]);
  async function withRecordLock<T>(record: { recordId: string }, perform: () => Promise<T>) {
    if (disabled(record.recordId) || locks.current.has(record.recordId)) return;
    locks.current.add(record.recordId);
    setWorking([...locks.current]);
    try {
      return await perform();
    } finally {
      locks.current.delete(record.recordId);
      setWorking([...locks.current]);
    }
  }
  function action(record: { recordId: string }, kind: CommandKind, args: unknown, label: string) {
    return withRecordLock(record, () => run(record, kind, args, label));
  }
  async function move(target: Recipe, role: 'want_to_try' | 'favourites') {
    try {
      await withRecordLock(target, async () => {
        const ensured = await run(
          target,
          'EnsureRecipeCollections',
          { scopeId: target.scopeId, wantToTryId: crypto.randomUUID(), favouritesId: crypto.randomUUID() },
          'Recipe collections ready',
        );
        if (ensured?.status !== 'Applied') return;
        const latest = await client.state(),
          found = latest.recipes.collections.find(
            (c) => c.scopeId === target.scopeId && c.role === role && c.deletedAt === null,
          );
        if (!found) throw new Error('Recipe collection unavailable. Refresh and try again.');
        const custom = target.collectionIds.filter(
          (id) => !latest.recipes.collections.some((c) => c.recordId === id && c.role !== null),
        );
        const outcome = await run(
          target,
          'SetRecipeCollections',
          {
            recordId: target.recordId,
            expectedRevision: target.revision,
            collectionIds: [...custom, found.recordId],
          },
          role === 'favourites' ? 'Moved to favourites' : 'Moved to Want to try',
        );
        if (outcome?.status === 'Applied') setView(role);
      });
    } catch (error) {
      onError(error);
    }
  }
  const pin = (target: Recipe) => {
    const saved = state.views.find((v) => v.kind === 'food_soon' && v.scopeId === target.scopeId);
    void action(
      target,
      'SetRecordPin',
      {
        recordId: target.recordId,
        scopeId: target.scopeId,
        viewKind: 'food_soon',
        expectedViewRevision: saved?.revision ?? 0,
        pinned: !pins.has(target.recordId),
      },
      pins.has(target.recordId) ? 'Removed from Soon' : 'Pinned for soon',
    );
  };
  return (
    <section className="food-section" aria-label="Food and recipes">
      <div className="section-heading">
        <button className="primary" onClick={() => setEditor('new')}>
          <Icon name="plus" size={18} />
          Add a recipe
        </button>
      </div>
      <div className="food-toolbar">
        <div className="food-segment" role="group" aria-label="Recipe collection">
          {[
            { id: 'want_to_try', name: 'Want to try' },
            { id: 'favourites', name: 'Favourites' },
            { id: 'soon', name: 'Make soon' },
            { id: 'all', name: 'All recipes' },
          ].map((item) => (
            <button
              key={item.id}
              aria-pressed={view === item.id}
              onClick={() => {
                setView(item.id);
                setLimit(24);
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
        <label className="food-search">
          <Icon name="search" size={18} />
          <input
            aria-label="Search recipes"
            placeholder="Find a recipe or ingredient"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="food-filter-row">
          <label>
            Visibility
            <select aria-label="Recipe visibility" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">Shared + mine</option>
              {state.session!.scopes.map((s) => (
                <option key={s.scopeId} value={s.scopeId}>
                  {s.kind === 'shared' ? 'Shared' : 'Just me'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Show
            <select aria-label="Recipe view" value={view} onChange={(e) => setView(e.target.value)}>
              <option value="want_to_try">Want to try</option>
              <option value="favourites">Favourites</option>
              <option value="soon">Make soon</option>
              <option value="all">All recipes</option>
              {collections
                .filter((c) => c.role === null)
                .map((c) => (
                  <option key={c.recordId} value={`collection:${c.recordId}`}>
                    {c.name}
                  </option>
                ))}
              <option value="archived">Archived</option>
              <option value="deleted">Removed</option>
            </select>
          </label>
          <label>
            Cards
            <select
              aria-label="Recipes per page"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            >
              {[...new Set([12, 24, 48, limit])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>
      {!state.online && (
        <p className="notice">
          Your saved recipes are available here. Reconnect to update them or collect a new link.
        </p>
      )}
      <div className={`food-layout ${recipe ? 'has-detail' : ''}`}>
        <div className="food-library">
          <div className="food-grid">
            {visible.slice(0, limit).map((r) => {
              const photo = r.attachments[0],
                job = imports.find((j) => j.recipeId === r.recordId);
              return (
                <button
                  className="food-card"
                  key={r.recordId}
                  aria-pressed={selected === r.recordId}
                  onClick={() => choose(r.recordId)}
                >
                  <span className="food-card-photo">
                    {photo ? (
                      <Photo client={client} id={photo.mediaId} descriptor={photo} />
                    ) : (
                      <span className="food-placeholder">
                        <Icon name="food" size={34} />
                        <span>
                          {job && ['queued', 'running', 'ready'].includes(job.state)
                            ? 'Collecting the recipe…'
                            : 'A recipe worth keeping'}
                        </span>
                      </span>
                    )}
                    {pins.has(r.recordId) && <span className="food-soon-badge">Make soon</span>}
                  </span>
                  <span className="food-card-copy">
                    <strong>{r.title}</strong>
                    <span>
                      {recipeDuration(r.totalTime) ||
                        recipeDuration(r.cookTime) ||
                        r.yieldText ||
                        'Saved for another day'}
                    </span>
                    <small>
                      {r.sourceUrl ? new URL(r.sourceUrl).hostname : r.author || 'Our own recipe'}
                      {state.session!.scopes.find((s) => s.scopeId === r.scopeId)?.kind === 'private'
                        ? ' · Just me'
                        : ''}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
          {!visible.length && (
            <div className="food-empty">
              <Icon name="food" size={34} />
              <h3>{view === 'soon' ? 'What shall we make next?' : 'Room for a new favourite.'}</h3>
              <p>
                {view === 'soon'
                  ? 'Pin a recipe with “Make soon” to bring it here. No date needed.'
                  : search
                    ? 'Try another name or ingredient.'
                    : 'Paste a recipe link or write one of your own. Its picture and your adjustments will stay together.'}
              </p>
            </div>
          )}
          {visible.length > limit && (
            <button className="food-more" onClick={() => setLimit(limit + 24)}>
              Show more recipes ({visible.length - limit} more)
            </button>
          )}
        </div>
        {recipe && (
          <aside ref={detailRef} className="food-detail" aria-label="Recipe details" tabIndex={-1}>
            <div className="food-detail-heading">
              <div>
                <p className="eyebrow">
                  {recipe.archived
                    ? 'Archived recipe'
                    : pins.has(recipe.recordId)
                      ? 'Let’s make this soon'
                      : 'From our recipe book'}
                </p>
                <h2>{recipe.title}</h2>
              </div>
              <button aria-label="Close recipe" onClick={() => setSelected(null)}>
                <Icon name="close" />
              </button>
            </div>
            {recipe.attachments.length > 0 && (
              <div className="food-recipe-photos">
                <AttachmentGallery client={client} attachments={recipe.attachments} />
              </div>
            )}
            <CaptureSources recordId={recipe.recordId} state={state} />
            {recipe.sourceUrl && (
              <p className="food-source">
                <LinkedText client={client} text={recipe.sourceUrl} />
              </p>
            )}
            <p className="food-text">{recipe.description}</p>
            <div className="food-meta">
              {recipe.yieldText && <span>{recipe.yieldText}</span>}
              {recipeDuration(recipe.prepTime) && <span>Prep · {recipeDuration(recipe.prepTime)}</span>}
              {recipeDuration(recipe.cookTime) && <span>Cook · {recipeDuration(recipe.cookTime)}</span>}
              {recipeDuration(recipe.totalTime) && <span>Total · {recipeDuration(recipe.totalTime)}</span>}
              {recipe.author && <span>By {recipe.author}</span>}
            </div>
            {recipe.deletedAt === null ? (
              <div className="food-actions">
                <button
                  disabled={disabled(recipe.recordId)}
                  aria-pressed={pins.has(recipe.recordId)}
                  onClick={() => pin(recipe)}
                >
                  {pins.has(recipe.recordId) ? 'Pinned for soon' : 'Make soon'}
                </button>
                <button
                  disabled={disabled(recipe.recordId)}
                  onClick={() => {
                    void move(recipe, 'favourites');
                  }}
                >
                  Move to favourites
                </button>
                <button
                  disabled={disabled(recipe.recordId)}
                  onClick={() => {
                    void move(recipe, 'want_to_try');
                  }}
                >
                  Move to Want to try
                </button>
                <button disabled={pending(recipe.recordId)} onClick={() => setEditor('edit')}>
                  Edit recipe
                </button>
                <button disabled={disabled(recipe.recordId)} onClick={() => setPhotosId(recipe.recordId)}>
                  Photos
                </button>
                <button disabled={pending(recipe.recordId)} onClick={() => setJournal({ mode: 'cooking' })}>
                  Record cooking
                </button>
              </div>
            ) : (
              <p className="notice">
                This recipe was removed.{' '}
                <button
                  disabled={disabled(recipe.recordId)}
                  onClick={() => {
                    void action(
                      recipe,
                      'RestoreRecipe',
                      { recordId: recipe.recordId, expectedRevision: recipe.revision },
                      'Recipe restored',
                    );
                  }}
                >
                  Restore recipe
                </button>
              </p>
            )}
            {currentImport && currentImport.state !== 'complete' && (
              <div className="food-import-status">
                <strong>{importLabels[currentImport.state]}</strong>
                {currentImport.errorCode && (
                  <p className="fine">
                    {currentImport.errorCode.replaceAll('_', ' ')}. Your recipe and notes are kept.
                  </p>
                )}
                <div className="food-actions">
                  {['review', 'paused', 'failed'].includes(currentImport.state) &&
                    currentImport.candidateCount > 0 && (
                      <button
                        disabled={disabled(recipe.recordId)}
                        onClick={() => setReview(currentImport.importId)}
                      >
                        Review import
                      </button>
                    )}
                  {['queued', 'running', 'ready'].includes(currentImport.state) && (
                    <button
                      disabled={disabled(recipe.recordId)}
                      onClick={() => {
                        void action(
                          recipe,
                          'CancelRecipeImport',
                          { importId: currentImport.importId },
                          'Import cancelled',
                        );
                      }}
                    >
                      Cancel import
                    </button>
                  )}
                </div>
              </div>
            )}
            <div className="food-recipe-body">
              <RecipeTasks
                key={recipe.recordId}
                client={client}
                state={state}
                recipe={recipe}
                run={run}
                onError={onError}
              />
              <section>
                <h3>Ingredients</h3>
                {!!recipe.ingredients.length && (
                  <button
                    disabled={!state.online || recipe.deletedAt !== null}
                    onClick={() => setShopping(true)}
                  >
                    Shop for this recipe
                  </button>
                )}
                {recipe.ingredients.length ? (
                  <ul>
                    {recipe.ingredients.map((i) => (
                      <li key={i.ingredientId}>{i.text}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="fine">No ingredients saved yet. You can add them in Edit recipe.</p>
                )}
              </section>
              <section>
                <h3>Directions</h3>
                {recipe.steps.length ? (
                  <ol>
                    {recipe.steps.map((s) => (
                      <li key={s.stepId} className="food-text">
                        {s.text}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="fine">Follow the source link, or save directions in Edit recipe.</p>
                )}
              </section>
            </div>
            <section className="food-adjustments">
              <div className="food-subheading">
                <h3>Our adjustments</h3>
                <button
                  disabled={recipe.deletedAt !== null || pending(recipe.recordId)}
                  onClick={() => setJournal({ mode: 'adjustment' })}
                >
                  Add a note
                </button>
              </div>
              {recipe.adjustments.map((a) => (
                <article key={a.adjustmentId}>
                  <p className="food-text">
                    <LinkedText client={client} text={a.body} />
                  </p>
                  <p className="fine">
                    {state.tasks.people.find((p) => p.personId === a.personId)?.displayName ?? 'Household'} ·{' '}
                    {dateWithYear(a.updatedAt)}
                  </p>
                  <div className="food-actions">
                    <button
                      disabled={recipe.deletedAt !== null || pending(recipe.recordId)}
                      onClick={() => setJournal({ mode: 'adjustment', id: a.adjustmentId })}
                    >
                      Edit adjustment
                    </button>
                    <button
                      disabled={disabled(recipe.recordId) || recipe.deletedAt !== null}
                      onClick={() => {
                        void action(
                          recipe,
                          'RemoveRecipeAdjustment',
                          {
                            recordId: recipe.recordId,
                            expectedRevision: recipe.revision,
                            adjustmentId: a.adjustmentId,
                          },
                          'Adjustment removed',
                        );
                      }}
                    >
                      Remove adjustment
                    </button>
                  </div>
                </article>
              ))}
              {!recipe.adjustments.length && (
                <p className="fine">
                  Less chilli, a different pan, something that made it yours. These notes stay when you
                  refresh the source recipe.
                </p>
              )}
            </section>
            <section className="food-cooking">
              <h3>Made at our place</h3>
              {cooking.slice(0, cookingLimit).map((c) => (
                <article key={c.recordId}>
                  <strong>{dateWithYear(c.cookedAt)}</strong>
                  <p className="food-text">
                    <LinkedText client={client} text={c.notes} />
                  </p>
                  <AttachmentGallery client={client} attachments={c.attachments} />
                  <div className="food-actions">
                    <button
                      disabled={pending(c.recordId)}
                      onClick={() => setJournal({ mode: 'cooking', id: c.recordId })}
                    >
                      Edit cooking notes
                    </button>
                    <button disabled={disabled(c.recordId)} onClick={() => setPhotosId(c.recordId)}>
                      Cooking photos
                    </button>
                    <button onClick={() => setHistoryId(c.recordId)}>History</button>
                    {!c.completionId && (
                      <button
                        disabled={disabled(c.recordId)}
                        onClick={() => {
                          void action(
                            c,
                            'DeleteRecipeCookingRecord',
                            { recordId: c.recordId, expectedRevision: c.revision },
                            'Cooking record removed',
                          );
                        }}
                      >
                        Remove cooking record
                      </button>
                    )}
                  </div>
                </article>
              ))}
              {cooking.length > cookingLimit && (
                <button onClick={() => setCookingLimit(cookingLimit + 20)}>
                  Show earlier cooking records ({cooking.length - cookingLimit} more)
                </button>
              )}
              {!cooking.length && <p className="fine">A little history of what we cooked and how it went.</p>}
            </section>
            <details className="food-manage">
              <summary>Recipe options</summary>
              <div className="food-actions">
                <button onClick={() => setHistoryId(recipe.recordId)}>Recipe history</button>
                {recipe.deletedAt === null && (
                  <>
                    <button
                      disabled={disabled(recipe.recordId)}
                      onClick={() => {
                        void action(
                          recipe,
                          'SetRecipeArchived',
                          {
                            recordId: recipe.recordId,
                            expectedRevision: recipe.revision,
                            archived: !recipe.archived,
                          },
                          recipe.archived ? 'Recipe unarchived' : 'Recipe archived',
                        );
                      }}
                    >
                      {recipe.archived ? 'Unarchive recipe' : 'Archive recipe'}
                    </button>
                    {recipe.sourceUrl && (
                      <button
                        disabled={
                          disabled(recipe.recordId) ||
                          (!!currentImport && ['queued', 'running', 'ready'].includes(currentImport.state))
                        }
                        onClick={() => {
                          void action(
                            recipe,
                            'RequestRecipeImport',
                            {
                              recordId: recipe.recordId,
                              expectedRevision: recipe.revision,
                              importId: crypto.randomUUID(),
                              url: recipe.sourceUrl,
                            },
                            'Recipe refresh requested',
                          );
                        }}
                      >
                        Refresh from source
                      </button>
                    )}
                    <button disabled={disabled(recipe.recordId)} onClick={() => setRemoving(recipe.recordId)}>
                      Remove recipe…
                    </button>
                  </>
                )}
              </div>
              {removing === recipe.recordId && (
                <p className="notice">
                  {cooking.length || hasCookingTasks
                    ? 'This recipe has cooking history or linked tasks. Archive it to keep everything together.'
                    : 'Remove this recipe? Its text remains available in history.'}{' '}
                  {!cooking.length && !hasCookingTasks && (
                    <button
                      disabled={disabled(recipe.recordId)}
                      onClick={() => {
                        void action(
                          recipe,
                          'DeleteRecipe',
                          { recordId: recipe.recordId, expectedRevision: recipe.revision },
                          'Recipe removed',
                        );
                        setRemoving(null);
                      }}
                    >
                      Remove recipe
                    </button>
                  )}
                  <button onClick={() => setRemoving(null)}>Keep recipe</button>
                </p>
              )}
            </details>
          </aside>
        )}
      </div>
      {editor && (
        <RecipeEditor
          key={editor === 'edit' ? recipe?.recordId : 'new'}
          client={client}
          state={state}
          {...(editor === 'edit' && recipe ? { recipe } : {})}
          run={run}
          close={() => setEditor(null)}
          onSaved={(id) => {
            choose(id);
            if (editor === 'new') setView('want_to_try');
          }}
          onError={onError}
        />
      )}
      {journal && recipe && (!journal.id || editingAdjustment || editingCooking) && (
        <RecipeJournalEditor
          key={`${journal.mode}:${journal.id ?? 'new'}`}
          client={client}
          state={state}
          recipe={recipe}
          mode={journal.mode}
          {...(editingAdjustment ? { adjustment: editingAdjustment } : {})}
          {...(editingCooking ? { cooking: editingCooking } : {})}
          run={run}
          close={() => setJournal(null)}
          onError={onError}
        />
      )}
      {photos && photos.kind !== 'recipe_collection' && (
        <AttachmentDialog
          client={client}
          target={photos}
          title={photos.kind === 'recipe' ? photos.title : 'Cooking photos'}
          online={state.online}
          serverEpoch={state.session!.serverEpoch}
          pending={state.pendingEdits.includes(photos.recordId)}
          close={() => setPhotosId(null)}
          onSaved={onPhotosSaved}
        />
      )}
      {shopping && recipe && (
        <RecipeShopping
          key={recipe.recordId}
          client={client}
          state={state}
          recipe={recipe}
          run={run}
          close={() => setShopping(false)}
          onError={onError}
          onOpenShopping={onOpenShopping}
        />
      )}
      {history && (
        <RecipeHistory
          client={client}
          state={state}
          record={history}
          run={run}
          close={() => setHistoryId(null)}
          onError={onError}
        />
      )}
      {review && recipe && (
        <RecipeImportReview
          key={review}
          client={client}
          state={state}
          recipe={recipe}
          importId={review}
          run={run}
          close={() => setReview(null)}
          onError={onError}
        />
      )}
    </section>
  );
}
