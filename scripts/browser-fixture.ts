import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { openDatabase, migrate, installation } from '../apps/server/src/infrastructure/database.js';
import { provisionHousehold } from '../apps/server/src/features/access/access.js';
import { buildApp } from '../apps/server/src/app.js';
import { buildCaptureApp } from '../apps/server/src/capture-app.js';
import { IntegrationAccessService } from '../apps/server/src/features/access/integrations.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { CalendarSecretBox } from '../apps/server/src/features/calendars/secret-box.js';
import { calendarReadScopes } from '../apps/server/src/features/calendars/authorization-provider.js';
import { normalizeGoogleEvent } from '../apps/server/src/features/calendars/google-events.js';
import { calendarDateAt, addCalendarDate } from '../packages/contracts/src/index.js';
import { RecipeImportWorker } from '../apps/server/src/features/recipes/import-worker.js';
import { extractRecipeMetadata } from '../apps/server/src/features/recipes/extractor.js';
import { sha256 } from '../apps/server/src/features/media/file-media-store.js';
import {
  provisionSuggestionAgent,
  authenticateSuggestionAgent,
} from '../apps/server/src/features/suggestions/agent-access.js';

const dataRoot = await mkdtemp(join(tmpdir(), 'our-place-browser-'));
const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
migrate(db);
await provisionHousehold(db, [
  { username: 'alex', displayName: 'Alex', password: 'local-demo-alex-2026' },
  { username: 'sam', displayName: 'Sam', password: 'local-demo-sam-2026' },
]);
// UI flows intentionally run much faster than household traffic; rate limits have separate HTTP tests.
const { app, access, recipeImports, media, writes, suggestionWork } = await buildApp({
  db,
  dataRoot,
  development: true,
  publicOrigin:
    process.env['OUR_PLACE_ANDROID_BROWSER_TEST'] === '1' ? 'http://10.0.2.2:4173' : 'http://127.0.0.1:4173',
  webRoot: resolve('apps/web/dist'),
  authenticationMode: 'trusted-network',
  requestLimit: 10000,
  calendars: {
    secrets: new CalendarSecretBox('fixture', new Map([['fixture', randomBytes(32)]])),
    authorization: {
      clientId: 'synthetic-browser-client',
      authorizationUrl: (state, challenge) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&code_challenge=${challenge}`,
      exchange: async (code) => ({
        clientId: 'synthetic-browser-client',
        subject: `fixture-${code}`,
        accessToken: 'synthetic-browser-access',
        refreshToken: 'synthetic-browser-refresh',
        expiresAt: Date.now() + 3600000,
        scopes: [...calendarReadScopes],
      }),
      refresh: async (previous) => ({ ...previous, expiresAt: Date.now() + 3600000 }),
    },
    events: {
      listCalendars: async () => [
        {
          providerId: 'fixture-private-source@example.com',
          title: 'Personal calendar',
          timeZone: 'America/Toronto',
          primary: true,
          accessRole: 'owner',
        },
        {
          providerId: 'fixture-availability@example.com',
          title: 'Availability only',
          timeZone: 'America/Toronto',
          primary: false,
          accessRole: 'freeBusyReader',
        },
      ],
      readEvents: async (_token, _id, window) => {
        const today = calendarDateAt(Date.now(), 'America/Toronto');
        return {
          window,
          timeZone: 'America/Toronto',
          events: ['default', 'private'].map((visibility) =>
            normalizeGoogleEvent(
              {
                id: `fixture-${visibility}`,
                status: 'confirmed',
                visibility,
                summary: visibility === 'private' ? 'Private calendar detail' : 'Household appointment',
                description: 'Synthetic calendar details for isolated tests.',
                location: 'Fixture kitchen',
                start: { date: today },
                end: { date: addCalendarDate(today, 1, 'days') },
                htmlLink: 'https://calendar.google.com/calendar/event?eid=fixture',
              },
              'America/Toronto',
            )!,
          ),
        };
      },
    },
  },
});
const capture = await buildCaptureApp({ db, dataRoot });
const recipeWorker = new RecipeImportWorker(recipeImports, media, {
  reader: {
    read: async (url) => {
      if (new URL(url).hostname !== 'example.com') throw new Error('Fixture imports only example.com');
      const names = url.includes('multiple') ? ['Synthetic soup', 'Synthetic stew'] : ['Synthetic soup'];
      const html = `<script type="application/ld+json">${JSON.stringify(names.map((name) => ({ '@type': 'Recipe', name, recipeIngredient: ['2 carrots', '1 onion'], recipeInstructions: ['Chop the vegetables.', 'Simmer until tender.'], image: 'https://example.com/fixture.png', totalTime: 'PT30M', recipeYield: '2 servings' })))}</script>`;
      return {
        extraction: extractRecipeMetadata(html, url),
        page: {
          mediaType: 'text/html',
          encoding: 'UTF-8',
          byteLength: Buffer.byteLength(html),
          sha256: sha256(Buffer.from(html)),
        },
      };
    },
  },
  web: {
    get: async () => ({
      url: 'https://example.com/fixture.png',
      mediaType: 'image/png',
      contentType: 'image/png',
      bytes: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
        'base64',
      ),
    }),
  },
});
let simulatedOutage = false;
app.server.on('connection', (socket) => {
  if (simulatedOutage) socket.destroy();
});
await app.listen({ port: 4173, host: '127.0.0.1' });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await recipeWorker.stop();
  app.server.closeAllConnections();
  await capture.app.close();
  await app.close();
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
  control.close();
}
// Test-only control listener, separate from the application; avoids Windows process-tree termination.
const control = createServer((request, response) => {
  const token = process.env['OUR_PLACE_TEST_TOKEN'];
  if (!token || request.method !== 'POST' || request.headers['x-test-token'] !== token) {
    response.writeHead(404).end();
    return;
  }
  if (request.url === '/voice-fixture') {
    void (async () => {
      const person = access.profiles().find((p) => p.username === 'alex')!;
      const login = access.selectProfile(person.username, 'browser');
      const credentials = new IntegrationAccessService(db, Date.now).provision(
        access.authenticate(login.secret),
        'Alexa',
        Date.now() + 3600000,
      );
      const result = await capture.app.inject({
        method: 'POST',
        url: '/capture/inbox',
        headers: { authorization: `Bearer ${credentials.secret}` },
        payload: {
          operationId: randomUUID(),
          expectedServerEpoch: installation(db).recovery_epoch,
          destination: 'inbox',
          text: 'Voice fixture: remember the filter size',
          capturedAt: Date.now(),
        },
      });
      response.writeHead(result.statusCode, { 'content-type': 'application/json' }).end(result.body);
    })().catch(() => response.writeHead(500).end());
    return;
  }
  if (request.url === '/offline' || request.url === '/online') {
    simulatedOutage = request.url === '/offline';
    if (simulatedOutage) app.server.closeAllConnections();
    response.writeHead(200).end('ok');
    return;
  }
  if (request.url === '/suggestion-question') {
    try {
      const login = access.selectProfile('alex', 'browser'),
        actor = access.authenticate(login.secret);
      const suggestionId = randomUUID(),
        questionId = randomUUID(),
        epoch = installation(db).recovery_epoch;
      const scopeId = access.scopes(actor).find((s) => s.kind === 'shared')!.scopeId;
      const execute = (kind: 'CreateInboxEntry' | 'RequestSuggestionWork', args: unknown) => {
        const result = writes.execute(actor, kind, {
          operationId: randomUUID(),
          contractVersion: 1,
          expectedServerEpoch: epoch,
          arguments: args,
        });
        if (result.status !== 'Applied') throw new Error('Fixture command failed');
      };
      const text = 'Obsolete question trial ' + suggestionId;
      execute('CreateInboxEntry', {
        inboxId: suggestionId,
        scopeId,
        category: 'app_suggestion',
        text,
        capturedAt: Date.now(),
        source: { kind: 'typed' },
        attachments: [],
      });
      execute('RequestSuggestionWork', { recordId: randomUUID(), suggestionId });
      const credentials = provisionSuggestionAgent(db, 'Synthetic question agent', Date.now());
      const agent = authenticateSuggestionAgent(db, credentials.secret),
        run = suggestionWork.claim(agent, randomUUID(), epoch).run!;
      suggestionWork.report(agent, run.leaseToken, {
        reportId: randomUUID(),
        expectedServerEpoch: epoch,
        runId: run.runId,
        status: 'needs_input',
        summary: 'An earlier step asked a question.',
        messages: [
          {
            messageId: questionId,
            text: 'Do we still need the old environment?',
            kind: 'question',
            choices: [],
          },
        ],
        resolvedQuestionIds: [],
      });
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ text, questionId }));
    } catch {
      response.writeHead(500).end();
    }
    return;
  }
  if (request.url === '/run-recipe-import') {
    void recipeWorker
      .tick()
      .then(() => response.writeHead(200).end('ok'))
      .catch(() => response.writeHead(500).end());
    return;
  }
  if (request.url !== '/stop') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200).end();
  setImmediate(() => {
    void close();
  });
});
control.listen(4174, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    void close();
  });
