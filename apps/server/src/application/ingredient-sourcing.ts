import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  isValid,
  type IngredientSourcingReview,
  type RecipeIngredient,
  type ShoppingPreferences,
} from '@our-place/contracts';
import { installation, type Sqlite } from '../infrastructure/database.js';
import type { HumanRequestContext } from '../features/access/access.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import type { FilingAdviceProvider } from './inbox-filing-suggestions.js';
import { boundedInput, choiceKeys } from '../infrastructure/filing-codex-provider.js';
import { isSecure } from './record-security.js';
import { Rejection } from './errors.js';

const requestSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 1 }),
    expectedPreferencesRevision: Type.Integer({ minimum: 0 }),
    expectedAttempt: Type.Integer({ minimum: 0 }),
    ingredientIds: Type.Array(Type.String({ minLength: 8, maxLength: 80 }), {
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);
type Row = {
  attempt: number;
  recipe_revision: number;
  preferences_revision: number;
  ingredient_ids: string;
  exception_ids: string;
  state: IngredientSourcingReview['state'];
};

export function registerIngredientSourcingRoutes(
  app: FastifyInstance,
  db: Sqlite,
  records: RecordRegistry,
  authenticate: (request: FastifyRequest) => HumanRequestContext,
  provider?: FilingAdviceProvider,
) {
  const active = new Map<string, AbortController>();
  const pending = new Set<Promise<unknown>>();
  function source(context: HumanRequestContext, id: string) {
    const record = records.get(context, id);
    if (record.kind !== 'recipe' || record.content.deletedAt !== null)
      throw new Rejection('recipe_unavailable');
    if (isSecure(db, id)) throw new Rejection('secure_record_excluded');
    return record;
  }
  function preferences(personId: string) {
    const row = db
      .prepare('SELECT revision,preferences_json FROM shopping_preferences WHERE person_id=?')
      .get(personId) as { revision: number; preferences_json: string } | undefined;
    return {
      revision: row?.revision ?? 0,
      value: row ? (JSON.parse(row.preferences_json) as ShoppingPreferences) : undefined,
    };
  }
  function read(context: HumanRequestContext, id: string): IngredientSourcingReview | null {
    const recipe = source(context, id);
    const row = db
      .prepare('SELECT * FROM ingredient_sourcing WHERE person_id=? AND recipe_id=?')
      .get(context.personId, id) as Row | undefined;
    if (!row) return null;
    const state =
      recipe.revision !== row.recipe_revision ||
      preferences(context.personId).revision !== row.preferences_revision
        ? 'stale'
        : row.state === 'working' && !active.has(context.personId + ':' + id)
          ? 'failed'
          : row.state;
    return {
      attempt: row.attempt,
      recipeRevision: row.recipe_revision,
      preferencesRevision: row.preferences_revision,
      ingredientIds: JSON.parse(row.ingredient_ids),
      exceptionIds: state === 'complete' ? JSON.parse(row.exception_ids) : [],
      state,
    };
  }
  app.get<{ Params: { id: string } }>('/api/recipes/:id/sourcing', async (request) => ({
    review: read(authenticate(request), request.params.id),
    configured: !!provider,
  }));
  app.addHook('onClose', async () => {
    for (const controller of active.values()) controller.abort();
    await Promise.allSettled(pending);
  });
  app.post<{ Params: { id: string } }>(
    '/api/recipes/:id/sourcing',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request) => {
      const context = authenticate(request),
        id = request.params.id;
      if (!isValid(requestSchema, request.body)) throw new Rejection('invalid_sourcing_request');
      const args = request.body,
        recipe = source(context, id),
        prefs = preferences(context.personId);
      if (!provider) throw new Rejection('sourcing_provider_unavailable');
      if (!prefs.value?.defaultStore?.trim()) throw new Rejection('choose_default_store_in_settings');
      if (recipe.revision !== args.expectedRevision || prefs.revision !== args.expectedPreferencesRevision)
        throw new Rejection('revision_conflict');
      const ids = [...args.ingredientIds].sort();
      const ingredients = ids.map((key) =>
        (recipe.content.ingredients as RecipeIngredient[]).find((i) => i.ingredientId === key),
      );
      if (ingredients.some((i) => !i)) throw new Rejection('ingredient_unavailable');
      const input = boundedInput({
        purpose: 'ingredient_sources',
        instruction: '',
        text: JSON.stringify({ defaultStore: prefs.value.defaultStore, location: prefs.value.location }),
        choices: ingredients.map((i, index) => ({ key: String(index), label: i!.text })),
      });
      const current = read(context, id);
      if ((current?.attempt ?? 0) !== args.expectedAttempt) {
        if (
          current &&
          current.attempt === args.expectedAttempt + 1 &&
          current.recipeRevision === recipe.revision &&
          current.preferencesRevision === prefs.revision &&
          JSON.stringify(ids) === JSON.stringify(current.ingredientIds)
        )
          return { review: current, configured: true };
        throw new Rejection('revision_conflict');
      }
      const key = context.personId + ':' + id;
      if (active.has(key)) throw new Rejection('sourcing_already_running');
      const epoch = installation(db).recovery_epoch;
      if (installation(db).recovery_mode !== 'normal') throw new Rejection('recovery_required');
      const attempt = args.expectedAttempt + 1;
      // Durable before dispatch: retries and server restarts cannot silently repeat a model request.
      db.prepare(
        `INSERT INTO ingredient_sourcing VALUES (?,?,?,?,?,?,'[]','working')
      ON CONFLICT(person_id,recipe_id) DO UPDATE SET attempt=excluded.attempt,recipe_revision=excluded.recipe_revision,
      preferences_revision=excluded.preferences_revision,ingredient_ids=excluded.ingredient_ids,exception_ids='[]',state='working'`,
      ).run(context.personId, id, attempt, recipe.revision, prefs.revision, JSON.stringify(ids));
      const controller = new AbortController();
      active.set(key, controller);
      const timer = setTimeout(() => controller.abort(), 28000);
      const work = (async () => {
        let state: Row['state'] = 'failed',
          exceptions: string[] = [];
        try {
          const raw = await Promise.race([
            provider(input, controller.signal),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
            ),
          ]);
          const keys = choiceKeys({ keys: raw }, input);
          authenticate(request);
          const latest = source(context, id);
          if (
            latest.revision !== recipe.revision ||
            preferences(context.personId).revision !== prefs.revision ||
            installation(db).recovery_epoch !== epoch
          )
            state = 'stale';
          else {
            state = 'complete';
            exceptions = keys.map((k) => ids[Number(k)]!);
          }
        } catch {
          /* Deliberately keep failures separate from a successful empty exception list. */
        } finally {
          clearTimeout(timer);
          active.delete(key);
          db.prepare(
            'UPDATE ingredient_sourcing SET state=?,exception_ids=? WHERE person_id=? AND recipe_id=? AND attempt=?',
          ).run(state, JSON.stringify(exceptions), context.personId, id, attempt);
        }
      })();
      pending.add(work);
      try {
        await work;
        return { review: read(authenticate(request), id), configured: true };
      } finally {
        pending.delete(work);
      }
    },
  );
}
