import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { ShoppingPreferences, isValid, type ShoppingSettings } from '@our-place/contracts';
import type { Sqlite } from '../infrastructure/database.js';
import type { HumanRequestContext } from '../features/access/access.js';
import { Rejection } from './errors.js';

const saveSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    preferences: ShoppingPreferences,
  },
  { additionalProperties: false },
);

export function registerShoppingPreferencesRoutes(
  app: FastifyInstance,
  db: Sqlite,
  authenticate: (request: FastifyRequest) => HumanRequestContext,
) {
  function settings(personId: string): ShoppingSettings {
    const row = db
      .prepare('SELECT revision,preferences_json FROM shopping_preferences WHERE person_id=?')
      .get(personId) as { revision: number; preferences_json: string } | undefined;
    return row
      ? { ...JSON.parse(row.preferences_json), revision: row.revision }
      : { location: '', stores: [], revision: 0 };
  }
  app.get('/api/shopping/settings', async (request) => settings(authenticate(request).personId));
  app.post('/api/shopping/settings', async (request) => {
    const { personId } = authenticate(request);
    if (!isValid(saveSchema, request.body)) throw new Rejection('invalid_shopping_settings');
    const { expectedRevision, preferences } = request.body;
    if (preferences.stores.some((store) => !store.name.trim())) throw new Rejection('store_name_required');
    return db.transaction(() => {
      const current = settings(personId);
      // A lost response can be retried without creating another revision.
      if (
        current.revision === expectedRevision + 1 &&
        JSON.stringify({ location: current.location, stores: current.stores }) === JSON.stringify(preferences)
      )
        return current;
      if (current.revision !== expectedRevision) throw new Rejection('revision_conflict');
      db.prepare(
        `INSERT INTO shopping_preferences VALUES (?,?,?) ON CONFLICT(person_id)
        DO UPDATE SET revision=excluded.revision,preferences_json=excluded.preferences_json`,
      ).run(personId, expectedRevision + 1, JSON.stringify(preferences));
      return settings(personId);
    })();
  });
}
