import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import {
  Id,
  SuggestionAgentClaim,
  SuggestionAgentReport,
  SuggestionAgentTransition,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { authenticateSuggestionAgent } from './agent-access.js';
import type { SuggestionAgentWork } from './agent-work.js';
import type { FileMediaStore } from '../media/file-media-store.js';

export function registerSuggestionAgentRoutes(
  app: FastifyInstance,
  db: Sqlite,
  work: SuggestionAgentWork,
  files: FileMediaStore,
) {
  const authenticate = (request: FastifyRequest) =>
    authenticateSuggestionAgent(
      db,
      request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '',
    );
  const mediaRequest = Type.Object(
    { runId: Id, leaseToken: Id, expectedServerEpoch: Id, mediaId: Id },
    { additionalProperties: false },
  );
  app.post<{ Body: typeof mediaRequest.static }>(
    '/api/suggestion-agent/media',
    { schema: { body: mediaRequest } },
    async (request, reply) => {
      const a = authenticate(request),
        b = request.body,
        m = work.media(a, b.runId, b.leaseToken, b.expectedServerEpoch, b.mediaId);
      const bytes = await files.read(m.storage_key);
      work.media(a, b.runId, b.leaseToken, b.expectedServerEpoch, b.mediaId);
      return reply.type(m.mime_type).send(bytes);
    },
  );
  app.post<{ Body: typeof SuggestionAgentClaim.static }>(
    '/api/suggestion-agent/claim',
    { schema: { body: SuggestionAgentClaim } },
    async (request) =>
      work.claim(authenticate(request), request.body.operationId, request.body.expectedServerEpoch),
  );
  app.post<{ Body: { expectedServerEpoch: string; acceptingWork?: boolean } }>(
    '/api/suggestion-agent/status',
    {
      schema: {
        body: Type.Object(
          { expectedServerEpoch: Id, acceptingWork: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
      },
    },
    async (request) =>
      work.status(authenticate(request), request.body.expectedServerEpoch, request.body.acceptingWork),
  );
  app.post<{ Body: typeof SuggestionAgentTransition.static }>(
    '/api/suggestion-agent/transition',
    { schema: { body: SuggestionAgentTransition } },
    async (request) => work.transition(authenticate(request), request.body),
  );
  const heartbeat = Type.Object(
    { runId: Id, leaseToken: Id, expectedServerEpoch: Id },
    { additionalProperties: false },
  );
  app.post<{ Body: typeof heartbeat.static }>(
    '/api/suggestion-agent/heartbeat',
    { schema: { body: heartbeat } },
    async (request) =>
      work.heartbeat(
        authenticate(request),
        request.body.runId,
        request.body.leaseToken,
        request.body.expectedServerEpoch,
      ),
  );
  const report = Type.Object(
    { leaseToken: Id, report: SuggestionAgentReport },
    { additionalProperties: false },
  );
  app.post<{ Body: typeof report.static }>(
    '/api/suggestion-agent/report',
    { schema: { body: report } },
    async (request) => work.report(authenticate(request), request.body.leaseToken, request.body.report),
  );
}
