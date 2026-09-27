import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createRequestVerifier } from './verify-request.js';
import { createAlexaHandler, type SkillOptions } from './skill.js';

export async function buildAlexaReceiver(
  options: SkillOptions & {
    /** Test seam only; the executable always uses real Amazon signature verification. */
    verifyRequest?: ReturnType<typeof createRequestVerifier>;
  },
) {
  const verifyRequest = options.verifyRequest ?? createRequestVerifier();
  const handle = createAlexaHandler(options);
  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    requestTimeout: 7000,
    connectionTimeout: 7000,
    keepAliveTimeout: 3000,
    trustProxy: false,
  });
  await app.register(rateLimit, { max: 60, timeWindow: '1 minute' });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    if (request.headers.origin || request.headers['content-encoding'])
      return reply.code(403).send({ code: 'unavailable' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 503).send({ code: 'unavailable' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'unavailable' }));
  let active = 0;
  app.post('/alexa', async (request, reply) => {
    if (active >= 8) return reply.code(503).send({ code: 'unavailable' });
    active++;
    try {
      let event: unknown;
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error();
        event = await verifyRequest(request.body, request.headers);
      } catch {
        return reply.code(400).send({ code: 'invalid_request' });
      }
      return await handle(event);
    } finally {
      active--;
    }
  });
  return app;
}
