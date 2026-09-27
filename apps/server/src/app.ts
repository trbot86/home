import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Type } from '@sinclair/typebox';
import {
  argumentSchemas,
  Envelope,
  Id,
  isValid,
  type AuthenticationOptions,
  type CommandKind,
  type ShoppingKind,
} from '@our-place/contracts';
import {
  installation,
  migrate,
  openDatabase,
  requireCurrentSchema,
  type Sqlite,
} from './infrastructure/database.js';
import { AccessService, type HumanRequestContext as RequestContext } from './features/access/access.js';
import { createRecordFeatures } from './application/record-features.js';
import { HistoryService } from './features/history/history.js';
import { WriteCoordinator } from './application/write-coordinator.js';
import { RecipeImports } from './features/recipes/imports.js';
import { Deferral, NotFound, ProtocolConflict, Rejection, Unauthenticated } from './application/errors.js';
import { FileMediaStore } from './features/media/file-media-store.js';
import { MediaRetentionGate } from './features/media/retention-gate.js';
import { MediaService, PrepareMedia } from './features/media/media.js';
import { BackupCoordinator } from './features/operations/backups.js';
import { registerClientDownloads } from './features/operations/client-downloads.js';
import { webRoot as defaultWebRoot } from './paths.js';

export type AppOptions = {
  dataRoot: string;
  publicOrigin: string;
  development?: boolean;
  db?: Sqlite;
  now?: () => number;
  webRoot?: string;
  logger?: boolean;
  backupRoot?: string;
  clientDownloadRoot?: string;
  authenticationMode?: 'password' | 'trusted-network';
  householdTimeZone?: string;
  /** Server construction option for isolated load/flow tests; deployed default stays bounded. */
  requestLimit?: number;
};
const loginSchema = Type.Object(
  {
    username: Type.String({ minLength: 1, maxLength: 80 }),
    password: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    clientKind: Type.Union([Type.Literal('browser'), Type.Literal('android')]),
    clientId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
const listSchema = Type.Object(
  {
    scopeId: Type.Optional(Id),
    deleted: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
    cursor: Type.Optional(Type.String({ maxLength: 400 })),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9]|[1-9][0-9]|100)$' })),
  },
  { additionalProperties: false },
);
export async function buildApp(options: AppOptions) {
  const origin = new URL(options.publicOrigin).origin;
  if (!options.development && !origin.startsWith('https://'))
    throw new Error('Production requires an HTTPS public origin');
  const now = options.now ?? Date.now;
  const db = options.db ?? openDatabase(join(options.dataRoot, 'db/household.sqlite'));
  try {
    if (options.development) migrate(db);
    else requireCurrentSchema(db);
    installation(db);
  } catch (error) {
    if (!options.db) db.close();
    throw error;
  }
  const access = new AccessService(db, now);
  const { inbox, shopping, home, tasks, recipes, records } = createRecordFeatures(
    db,
    access,
    options.householdTimeZone,
  );
  const history = new HistoryService(db, records, access);
  const recipeImports = new RecipeImports(db, recipes, history, records, now);
  const writes = new WriteCoordinator(db, inbox, history, now, records, undefined, [
    shopping.commands(),
    tasks.commands(),
    home.commands(),
    recipes.commands(),
    recipeImports.commands(),
  ]);
  const files = new FileMediaStore(join(options.dataRoot, 'media'), options.development === true);
  await files.initialise();
  const retention = new MediaRetentionGate();
  const media = new MediaService(db, access, files, retention, now);
  const backups = new BackupCoordinator(db, files, retention, {
    dataRoot: options.dataRoot,
    ...(options.backupRoot ? { outputRoot: options.backupRoot } : {}),
    development: !!options.development,
    now,
  });
  await backups.initialise();
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] }
      : false,
    bodyLimit: 128 * 1024,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: options.requestLimit ?? 300, timeWindow: '1 minute' });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 25 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    if (!options.development)
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin &&
      request.headers.origin !== origin
    )
      return reply.code(403).send({ code: 'origin_rejected' });
  });
  function authenticate(request: FastifyRequest): RequestContext {
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const secret = bearer ?? request.cookies['our_place_session'];
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Unauthenticated();
    const context = access.authenticate(secret);
    if (request.headers['x-client-id'] && request.headers['x-client-id'] !== context.clientId)
      throw new Unauthenticated();
    if (bearer && context.kind !== 'android') throw new Unauthenticated();
    if (!bearer && context.kind !== 'browser') throw new Unauthenticated();
    if (!bearer && !['GET', 'HEAD'].includes(request.method) && request.headers.origin !== origin)
      throw new Rejection('origin_required');
    return context;
  }
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Unauthenticated) return reply.code(401).send({ code: 'authentication_required' });
    if (error instanceof NotFound) return reply.code(404).send({ code: 'unavailable' });
    if (error instanceof ProtocolConflict) return reply.code(409).send({ code: 'operation_id_conflict' });
    if (error instanceof Rejection) return reply.code(400).send({ code: error.code });
    if (error instanceof Deferral) return reply.code(503).send({ status: 'Deferred', code: error.code });
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ code: 'too_many_requests_try_again_shortly' });
    if (status && status < 500) return reply.code(status).send({ code: 'invalid_request' });
    request.log.error({ err: error, requestId: request.id }, 'Request failed');
    return reply.code(503).send({ code: 'temporarily_unavailable' });
  });
  app.get('/health', async () => ({ status: 'ok', contractVersion: 1, development: !!options.development }));
  app.get('/api/auth/options', async (): Promise<AuthenticationOptions> =>
    options.authenticationMode === 'trusted-network'
      ? { mode: 'trusted-network', profiles: access.profiles() }
      : { mode: 'password' },
  );
  app.post(
    '/api/auth/login',
    // Profile selection has no password guessing or expensive password verification.
    {
      config: {
        rateLimit: {
          max: options.authenticationMode === 'trusted-network' ? 60 : 10,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      if (!isValid(loginSchema, request.body)) return reply.code(400).send({ code: 'invalid_login' });
      const body = request.body;
      const result =
        options.authenticationMode === 'trusted-network'
          ? access.selectProfile(body.username, body.clientKind, body.clientId)
          : await access.login(body.username, body.password ?? '', body.clientKind, body.clientId);
      if (body.clientKind === 'browser') {
        reply.setCookie('our_place_session', result.secret, {
          httpOnly: true,
          secure: origin.startsWith('https://'),
          sameSite: 'strict',
          path: '/',
          maxAge: 90 * 86400,
        });
        return result.session;
      }
      return { ...result.session, credential: result.secret };
    },
  );
  app.post('/api/auth/logout', async (request, reply) => {
    access.logout(authenticate(request));
    reply.clearCookie('our_place_session', { path: '/' });
    return { signedOut: true };
  });
  app.get('/api/session', async (request) => access.session(authenticate(request)));
  app.post('/api/recovery/abandon', async (request, reply) => {
    const context = authenticate(request);
    const body = request.body as { kind?: unknown; command?: unknown } | null;
    if (
      !body ||
      typeof body.kind !== 'string' ||
      !Object.hasOwn(argumentSchemas, body.kind) ||
      !isValid(Envelope, body.command)
    )
      return reply.code(400).send({ code: 'invalid_recovery_request' });
    return writes.abandonRestored(context, body.kind as CommandKind, body.command);
  });
  // Synchronous reads on the sole database owner produce one coherent authorised snapshot.
  // The old endpoint remains supported by already-installed phones.
  app.get('/api/cache/inbox', async (request) => {
    const context = authenticate(request);
    return {
      ...inbox.snapshot(context, now()),
      shopping: shopping.snapshot(context),
      tasks: tasks.snapshot(context),
      home: home.snapshot(context),
      recipes: recipes.snapshot(context),
      recipeImports: recipeImports.snapshot(context),
    };
  });
  app.get<{ Params: { id: string } }>('/api/recipe-imports/:id', async (request) =>
    recipeImports.detail(authenticate(request), request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/shopping/:id/history', async (request) => {
    const context = authenticate(request);
    const record = shopping.get(context, request.params.id);
    return { entries: history.list(context, request.params.id, record.kind as ShoppingKind) };
  });
  app.get<{ Params: { id: string } }>('/api/records/:id/history', async (request) => {
    const context = authenticate(request);
    const record = records.get(context, request.params.id);
    return { entries: history.list(context, request.params.id, record.kind) };
  });
  for (const kind of Object.keys(argumentSchemas) as CommandKind[]) {
    app.post(`/api/commands/${kind}`, async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(Envelope, request.body)) return reply.code(400).send({ code: 'invalid_envelope' });
      return writes.execute(context, kind, request.body);
    });
  }
  app.get<{ Params: { operationId: string }; Querystring: { epoch: string } }>(
    '/api/operations/:operationId',
    async (request, reply) => {
      const context = authenticate(request);
      if (!isValid(Id, request.params.operationId) || !isValid(Id, request.query.epoch))
        return reply.code(400).send({ code: 'invalid_request' });
      return writes.resolve(context, request.params.operationId, request.query.epoch);
    },
  );
  app.get('/api/inbox', async (request, reply) => {
    const context = authenticate(request);
    if (!isValid(listSchema, request.query)) return reply.code(400).send({ code: 'invalid_query' });
    const query = request.query;
    return inbox.list(context, now(), {
      ...(query.scopeId ? { scopeId: query.scopeId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      deleted: query.deleted === 'true',
      limit: Number(query.limit ?? 40),
    });
  });
  app.get<{ Params: { id: string } }>('/api/inbox/:id', async (request) =>
    inbox.get(authenticate(request), request.params.id),
  );
  app.get<{ Params: { id: string } }>('/api/inbox/:id/history', async (request) => ({
    entries: history.list(authenticate(request), request.params.id),
  }));
  app.post<{ Params: { id: string } }>('/api/media/:id/prepare', async (request, reply) => {
    const context = authenticate(request);
    if (!isValid(PrepareMedia, request.body)) return reply.code(400).send({ code: 'invalid_media' });
    return media.prepare(context, request.params.id, request.body);
  });
  app.put<{ Params: { id: string } }>(
    '/api/media/:id/bytes',
    { bodyLimit: 25 * 1024 * 1024 },
    async (request, reply) => {
      const context = authenticate(request);
      const epoch = request.headers['x-server-epoch'];
      if (!Buffer.isBuffer(request.body) || !isValid(Id, epoch))
        return reply.code(400).send({ code: 'invalid_upload' });
      return media.transfer(context, request.params.id, epoch, request.body);
    },
  );
  app.get<{ Params: { id: string } }>('/api/media/:id', async (request, reply) => {
    const result = await media.read(authenticate(request), request.params.id);
    return reply.type(result.mimeType).header('content-disposition', 'inline').send(result.bytes);
  });
  app.get('/api/storage', async (request) => {
    authenticate(request);
    const measure = async (directory: string): Promise<number> => {
      try {
        let bytes = 0;
        for (const entry of await readdir(directory, { withFileTypes: true }))
          if (entry.isFile()) {
            try {
              bytes += (await stat(join(directory, entry.name))).size;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
        return bytes;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw error;
      }
    };
    const [databaseBytes, mediaBytes, stagingBytes] = await Promise.all([
      measure(join(options.dataRoot, 'db')),
      measure(join(files.root, 'objects')),
      measure(join(files.root, 'staging')),
    ]);
    return { databaseBytes, mediaBytes, stagingBytes, sampledAt: now() };
  });
  app.get('/api/backups', async (request) => {
    access.requireAdministrator(authenticate(request));
    return backups.status();
  });
  app.post('/api/backups', async (request, reply) => {
    access.requireAdministrator(authenticate(request));
    void backups.create().catch((error) => {
      request.log.error({ err: error }, 'Backup export failed');
    });
    return reply.code(202).send({ accepted: true });
  });
  registerClientDownloads(app, options.clientDownloadRoot);
  const webRoot = options.webRoot ?? defaultWebRoot;
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  app.addHook('onClose', async () => {
    await backups.wait();
    if (!options.db) db.close();
  });
  await app.ready();
  return { app, db, access, inbox, history, writes, media, retention, backups, recipeImports };
}
