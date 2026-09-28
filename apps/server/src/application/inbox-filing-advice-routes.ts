import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  FilingAdvicePreferences,
  FilingAdviceRequest,
  isValid,
  type FilingAdviceSettings,
} from '@our-place/contracts';
import type { Sqlite } from '../infrastructure/database.js';
import type { AccessService, HumanRequestContext } from '../features/access/access.js';
import type { InboxRepository } from '../features/inbox/inbox.js';
import type { RecordRegistry } from '../features/records/record-registry.js';
import { InboxFilingSuggestions, type FilingAdviceProvider } from './inbox-filing-suggestions.js';
import { Rejection } from './errors.js';
import { FilingAdviceWorker } from './inbox-filing-advice-worker.js';

const saveSchema = Type.Object(
  {
    expectedRevision: Type.Integer({ minimum: 0 }),
    preferences: FilingAdvicePreferences,
  },
  { additionalProperties: false },
);

export function registerFilingAdviceRoutes(
  app: FastifyInstance,
  db: Sqlite,
  access: AccessService,
  inbox: InboxRepository,
  records: RecordRegistry,
  authenticate: (request: FastifyRequest) => HumanRequestContext,
  now: () => number,
  provider?: FilingAdviceProvider,
) {
  function settings(context: HumanRequestContext): FilingAdviceSettings {
    const row = db
      .prepare('SELECT * FROM inbox_filing_advice_preferences WHERE person_id=?')
      .get(context.personId) as { revision: number; preferences_json: string } | undefined;
    const preferences: FilingAdvicePreferences = row
      ? JSON.parse(row.preferences_json)
      : { enabled: false, automatic: false, scopeIds: [], destinationTitles: false };
    return { ...preferences, configured: !!provider, revision: row?.revision ?? 0 };
  }
  app.get('/api/filing-advice/settings', async (request) => settings(authenticate(request)));
  app.post('/api/filing-advice/settings', async (request) => {
    const context = authenticate(request);
    if (!isValid(saveSchema, request.body)) throw new Rejection('invalid_advice_settings');
    const { expectedRevision, preferences } = request.body;
    for (const scopeId of preferences.scopeIds) access.requireScope(context, scopeId);
    if (preferences.enabled && !preferences.scopeIds.length) throw new Rejection('choose_permitted_scopes');
    if (settings(context).revision !== expectedRevision) throw new Rejection('revision_conflict');
    db.prepare(
      `INSERT INTO inbox_filing_advice_preferences VALUES (?,?,?,?)
      ON CONFLICT(person_id) DO UPDATE SET credential_id=excluded.credential_id,revision=excluded.revision,preferences_json=excluded.preferences_json`,
    ).run(context.personId, context.credentialId, expectedRevision + 1, JSON.stringify(preferences));
    return settings(context);
  });
  app.get<{ Params: { id: string } }>('/api/inbox/:id/filing-advice', async (request) => {
    const context = authenticate(request);
    return { review: new InboxFilingSuggestions(db, inbox, records).review(context, request.params.id) };
  });
  const pending = new Set<Promise<unknown>>();
  const worker = new FilingAdviceWorker(db, inbox, records, settings, provider, now);
  app.addHook('onListen', async () => {
    worker.start();
  });
  app.addHook('onClose', async () => {
    await worker.stop();
    await Promise.allSettled([...pending]);
  });
  app.post<{ Params: { id: string } }>(
    '/api/inbox/:id/filing-advice',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const context = authenticate(request);
      if (!isValid(FilingAdviceRequest, request.body)) throw new Rejection('invalid_advice_request');
      const preferences = settings(context);
      if (!provider) throw new Rejection('filing_provider_not_configured');
      if (!preferences.enabled) throw new Rejection('filing_suggestions_disabled');
      if (request.body.search === 'all' && (!preferences.destinationTitles || request.body.destinationIds))
        throw new Rejection('broader_search_requires_destination_titles');
      const service = new InboxFilingSuggestions(db, inbox, records, provider, preferences, () => {
        // Reauthenticate before publishing an asynchronous result, including consent revocation.
        authenticate(request);
        return settings(context).revision === preferences.revision;
      });
      const discovery =
        request.body.destinationIds === undefined
          ? service.discover(context, request.params.id, request.body.search ?? 'recent')
          : undefined;
      const work = service.suggest(
        context,
        request.params.id,
        request.body.expectedRevision,
        request.body.destinationIds ?? discovery!.ids,
        now(),
        request.body.expectedAttempt,
        discovery,
      );
      pending.add(work);
      try {
        return { review: await work };
      } finally {
        pending.delete(work);
      }
    },
  );
  const reader = new InboxFilingSuggestions(db, inbox, records);
  return { worker, review: (context: HumanRequestContext, id: string) => reader.review(context, id) };
}
