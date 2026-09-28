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

let failedAdviceOnce = false;
const dataRoot = await mkdtemp(join(tmpdir(), 'our-place-browser-'));
const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
migrate(db);
await provisionHousehold(db, [
  { username: 'alex', displayName: 'Alex', password: 'local-demo-alex-2026' },
  { username: 'sam', displayName: 'Sam', password: 'local-demo-sam-2026' },
]);
// UI flows intentionally run much faster than household traffic; rate limits have separate HTTP tests.
const { app, access, recipeImports, media, writes, suggestionWork, suggestionRelease } = await buildApp({
  db,
  dataRoot,
  development: true,
  publicOrigin:
    process.env['OUR_PLACE_ANDROID_BROWSER_TEST'] === '1' ? 'http://10.0.2.2:4173' : 'http://127.0.0.1:4173',
  webRoot: resolve('apps/web/dist'),
  authenticationMode: 'trusted-network',
  requestLimit: 10000,
  // Synthetic provider: no network or real model account is used by browser tests.
  filingAdviceProvider: async (input) => {
    if (input.text === 'Buy synthetic retry supplies' && !failedAdviceOnce) {
      failedAdviceOnce = true;
      throw new Error('Synthetic temporary provider failure');
    }
    if (input.text === 'Synthetic broccoli cheddar soup') return ['1', '3', '0'];
    if (input.text.startsWith('Buy synthetic')) return ['1'];
    const page = input.choices.find((c) => c.label === 'Project page: Advice precise page');
    if (input.text.includes('precise advice') && page) return [page.key, '0'];
    return input.choices.length > 4 ? ['4', '0'] : ['0'];
  },
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
let releaseFixture:
  { agent: ReturnType<typeof authenticateSuggestionAgent>; suggestionId: string } | undefined;
let steeringFixture:
  | {
      agent: ReturnType<typeof authenticateSuggestionAgent>;
      runId: string;
      leaseToken: string;
      epoch: string;
    }
  | undefined;
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
  if (request.url === '/prepare-synthetic-release') {
    try {
      if (!releaseFixture) throw new Error();
      const epoch = installation(db).recovery_epoch,
        agent = releaseFixture.agent;
      let job = suggestionRelease.pending(agent, epoch)!;
      if (!job.members?.some((m) => m.suggestionId === releaseFixture!.suggestionId)) throw new Error();
      job = suggestionRelease.update(agent, {
        releaseId: job.releaseId,
        expectedServerEpoch: epoch,
        expectedRevision: job.revision,
        state: 'preparing',
        summary: 'Checking synthetic build',
      });
      suggestionRelease.update(agent, {
        releaseId: job.releaseId,
        expectedServerEpoch: epoch,
        expectedRevision: job.revision,
        state: 'prepared',
        summary: 'Synthetic checks passed. Ready to deploy.',
        manifest: {
          baseCommit: 'a'.repeat(40),
          sourceCommit: 'b'.repeat(40),
          sources: job.members!.map((m) => ({ ...m, sourceCommit: 'b'.repeat(40) })),
          candidateCommit: 'c'.repeat(40),
          imageId: 'sha256:' + 'd'.repeat(64),
          previousImageId: 'sha256:' + 'e'.repeat(64),
          apkSha256: 'f'.repeat(64),
          checks: ['Synthetic checks passed'],
          preparedAt: Date.now(),
        },
      });
      response.writeHead(200).end('ok');
    } catch {
      response.writeHead(500).end();
    }
    return;
  }
  if (request.url === '/deliver-synthetic-steering') {
    try {
      if (!steeringFixture) throw new Error();
      const { agent, runId, leaseToken, epoch } = steeringFixture;
      const feed = suggestionWork.steering(agent, runId, leaseToken, epoch);
      suggestionWork.steering(
        agent,
        runId,
        leaseToken,
        epoch,
        feed.messages.map((m) => ({ messageId: m.recordId, state: 'accepted' })),
      );
      response.writeHead(200).end('ok');
    } catch {
      response.writeHead(500).end();
    }
    return;
  }
  if (
    request.url === '/suggestion-working' ||
    request.url === '/suggestion-question' ||
    request.url === '/suggestion-ready' ||
    request.url === '/suggestion-ready-same-agent'
  ) {
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
      const agent =
          request.url === '/suggestion-ready-same-agent' && releaseFixture
            ? releaseFixture.agent
            : authenticateSuggestionAgent(db, credentials.secret),
        run = suggestionWork.claim(agent, randomUUID(), epoch).run!;
      const ready = request.url !== '/suggestion-question';
      if (request.url === '/suggestion-working') {
        steeringFixture = { agent, runId: run.runId, leaseToken: run.leaseToken, epoch };
        suggestionWork.steering(agent, run.runId, run.leaseToken, epoch);
        suggestionWork.report(agent, run.leaseToken, {
          reportId: randomUUID(),
          expectedServerEpoch: epoch,
          runId: run.runId,
          status: 'working',
          summary: 'Working on the synthetic suggestion',
          messages: [],
          resolvedQuestionIds: [],
        });
        access.logout(actor);
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }));
        return;
      }
      if (ready) releaseFixture = { agent, suggestionId };
      suggestionWork.report(agent, run.leaseToken, {
        reportId: randomUUID(),
        expectedServerEpoch: epoch,
        runId: run.runId,
        status: ready ? 'ready' : 'needs_input',
        summary: ready ? 'Implemented and tested the recipe label.' : 'An earlier step asked a question.',
        messages: ready
          ? []
          : [
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
