import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { Recipe, IngredientSourcingReview, ShoppingSettings } from '@our-place/contracts';
import { WebLink } from '../LinkedText.js';

export function IngredientSourcing({
  client,
  recipe,
  ingredientIds,
  online,
  onUse,
}: {
  client: ClientPlatform;
  recipe: Recipe;
  ingredientIds: string[];
  online: boolean;
  onUse: (text: string) => void;
}) {
  const [settings, setSettings] = useState<ShoppingSettings | null>(null);
  const [review, setReview] = useState<IngredientSourcingReview | null>(null);
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (online)
      void Promise.all([client.shoppingSettings(), client.ingredientSourcing(recipe.recordId)])
        .then(([prefs, result]) => {
          if (active) {
            setSettings(prefs);
            setReview(result.review);
            setConfigured(result.configured);
            setLoaded(true);
            setError('');
          }
        })
        .catch(() => {
          if (active)
            setError(
              'Sourcing is unavailable for this recipe. Secure recipes are excluded. Your default assumption is unchanged.',
            );
        });
    return () => {
      active = false;
    };
  }, [client, online, recipe.recordId, recipe.revision, reload]);
  useEffect(() => {
    if (!online || review?.state !== 'working' || busy) return;
    const timer = setTimeout(() => setReload((v) => v + 1), 2500);
    return () => clearTimeout(timer);
  }, [online, review, busy]);
  const current =
    review?.state === 'complete' &&
    review.recipeRevision === recipe.revision &&
    review.preferencesRevision === settings?.revision &&
    JSON.stringify([...ingredientIds].sort()) === JSON.stringify(review.ingredientIds);
  const exceptions = current
    ? recipe.ingredients.filter((i) => review.exceptionIds.includes(i.ingredientId))
    : [];
  const summary = settings?.defaultStore ? `Everything else is at ${settings.defaultStore}.` : '';
  const query = (text: string) =>
    `https://www.google.com/search?q=${encodeURIComponent(`${text} buy ${settings?.location ?? ''}`)}`;
  const notes = [
    summary + ' (Assumed; not stock-checked.)',
    ...exceptions.map((i) => `${i.text} — possible specialty-store exception\n${query(i.text)}`),
  ].join('\n\n');
  async function suggest() {
    if (lock.current || !settings || !online || !loaded) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await client.ingredientSourcing(recipe.recordId, {
        expectedRevision: recipe.revision,
        expectedPreferencesRevision: settings.revision,
        expectedAttempt: review?.attempt ?? 0,
        ingredientIds,
      });
      if (alive.current) setReview(result.review);
    } catch {
      if (alive.current)
        setError(
          'Could not confirm the result. Refresh sourcing to check the saved attempt before retrying. No exception has been inferred from this failure.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="ingredient-sourcing" aria-label="Ingredient sourcing">
      <h3>Where to buy</h3>
      {summary ? (
        <>
          <p>{summary}</p>
          <p className="fine">
            Default assumption. Only likely specialty-store exceptions are listed below; catalogue and stock
            are not checked.
          </p>
        </>
      ) : (
        <p className="fine">Choose a default store in Settings → Nearby shopping.</p>
      )}
      <button
        type="button"
        onClick={() => void suggest()}
        disabled={
          !online ||
          !loaded ||
          !configured ||
          !summary ||
          busy ||
          review?.state === 'working' ||
          ingredientIds.length === 0
        }
      >
        {busy || review?.state === 'working'
          ? 'Considering ingredients…'
          : review?.state === 'failed'
            ? 'Retry sourcing'
            : 'Suggest sourcing'}
      </button>{' '}
      <button type="button" disabled={!online || busy} onClick={() => setReload((v) => v + 1)}>
        Refresh sourcing
      </button>
      <p className="fine">
        Suggest sends only the selected ingredient text, default store and location to the isolated model.
      </p>
      {loaded && !configured && <p role="status">The sourcing worker is not connected.</p>}
      {error && <p role="alert">{error}</p>}
      {review?.state === 'failed' && (
        <p role="status">
          The last attempt did not finish successfully. The default assumption still applies; this is not a
          finding about availability.
        </p>
      )}
      {review && review.state !== 'failed' && review.state !== 'working' && !current && (
        <p role="status">Ingredients or settings changed. Suggest again for the current selection.</p>
      )}
      {current && (
        <>
          {exceptions.length === 0 ? (
            <p>No likely exceptions identified.</p>
          ) : (
            <ul>
              {exceptions.map((i) => (
                <li key={i.ingredientId}>
                  <span>{i.text}</span>{' '}
                  <WebLink client={client} href={query(i.text)}>
                    Search alternatives
                  </WebLink>
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={notes.length > 8000} onClick={() => onUse(notes)}>
            Use sourcing notes
          </button>
          {notes.length > 8000 && <p>Choose fewer ingredients to fit these sourcing notes.</p>}
        </>
      )}
    </section>
  );
}
