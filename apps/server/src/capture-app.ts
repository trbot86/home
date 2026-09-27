import Fastify, { type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Type } from '@sinclair/typebox';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Id, isValid } from '@our-place/contracts';
import { installation, openDatabase, requireCurrentSchema, type Sqlite } from './infrastructure/database.js';
import { AccessService } from './features/access/access.js';
import { IntegrationAccessService } from './features/access/integrations.js';
import { createRecordFeatures } from './application/record-features.js';
import { HistoryService } from './features/history/history.js';
import { WriteCoordinator } from './application/write-coordinator.js';
import { ProtocolConflict, Rejection, Unauthenticated } from './application/errors.js';

const resolveShape = Type.Object(
  { operationId: Id, expectedServerEpoch: Id },
  { additionalProperties: false },
);
// Validate the authority/envelope here; argument errors go through durable receipt arbitration.
const captureShape = Type.Object(
  {
    operationId: Id,
    expectedServerEpoch: Id,
    destination: Type.Literal('inbox'),
    text: Type.Unknown(),
    capturedAt: Type.Unknown(),
  },
  { additionalProperties: false },
);

/** Independent listener: importing this module never starts it or provisions credentials. */
export async function buildCaptureApp(options: { dataRoot: string; db?: Sqlite; now?: () => number }) {
  const filename = join(options.dataRoot, 'db/household.sqlite');
  if (!options.db && !existsSync(filename))
    throw new Error('Capture requires an existing household database');
  const db = options.db ?? openDatabase(filename);
  try {
    requireCurrentSchema(db); // Only the backup-verifying upgrade command may change deployed schema.
    installation(db);
    const shared = db.prepare("SELECT scope_id FROM visibility_scopes WHERE kind='shared'").all() as {
      scope_id: string;
    }[];
    if (shared.length !== 1) throw new Error('Capture requires exactly one shared scope');
    const scopeId = shared[0]!.scope_id;
    const now = options.now ?? Date.now;
    const access = new AccessService(db, now),
      integrations = new IntegrationAccessService(db, now);
    // Include every record adapter for global integrity checks, without registering their commands/routes.
    const { inbox, records } = createRecordFeatures(db, access);
    const history = new HistoryService(db, records, access);
    const writes = new WriteCoordinator(db, inbox, history, now, records);
    const app = Fastify({
      logger: false,
      bodyLimit: 16 * 1024,
      requestTimeout: 10_000,
      connectionTimeout: 10_000,
      keepAliveTimeout: 5_000,
      ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
    });
    await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
    app.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
      if (request.headers.origin) return reply.code(403).send({ code: 'origin_rejected' });
    });
    function authenticate(request: FastifyRequest) {
      const secret = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (!secret) throw new Unauthenticated();
      const context = integrations.authenticate(secret);
      if (request.headers['x-client-id'] && request.headers['x-client-id'] !== context.clientId)
        throw new Unauthenticated();
      return context;
    }
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof Unauthenticated) return reply.code(401).send({ code: 'authentication_required' });
      if (error instanceof ProtocolConflict) return reply.code(409).send({ code: 'operation_id_conflict' });
      if (error instanceof Rejection) return reply.code(400).send({ code: error.code });
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status < 500) return reply.code(status).send({ code: 'invalid_request' });
      return reply.code(503).send({ status: 'Deferred', code: 'temporarily_unavailable' });
    });
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'unavailable' }));
    app.post('/capture/inbox', async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(captureShape, request.body)) return reply.code(400).send({ code: 'invalid_capture' });
      const body = request.body;
      const inboxId = createHash('sha256')
        .update(JSON.stringify(['integration-inbox-v1', context.clientId, body.operationId]))
        .digest('hex');
      return writes.execute(context, 'CreateInboxEntry', {
        operationId: body.operationId,
        expectedServerEpoch: body.expectedServerEpoch,
        contractVersion: 1,
        arguments: {
          inboxId,
          scopeId,
          text: body.text,
          capturedAt: body.capturedAt,
          category: 'inbox',
          source: { kind: 'voice' },
          attachments: [],
        },
      });
    });
    app.post('/capture/resolve', async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(resolveShape, request.body)) return reply.code(400).send({ code: 'invalid_request' });
      return writes.resolve(context, request.body.operationId, request.body.expectedServerEpoch);
    });
    app.addHook('onClose', async () => {
      if (!options.db) db.close();
    });
    return { app, db };
  } catch (error) {
    if (!options.db) db.close();
    throw error;
  }
}
