import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { openDatabase, migrate, installation } from '../apps/server/src/infrastructure/database.js';
import { provisionHousehold } from '../apps/server/src/features/access/access.js';
import { buildApp } from '../apps/server/src/app.js';
import { buildCaptureApp } from '../apps/server/src/capture-app.js';
import { IntegrationAccessService } from '../apps/server/src/features/access/integrations.js';
import { randomUUID } from 'node:crypto';

const dataRoot = await mkdtemp(join(tmpdir(), 'our-place-browser-'));
const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
migrate(db);
await provisionHousehold(db, [
  { username: 'alex', displayName: 'Alex', password: 'local-demo-alex-2026' },
  { username: 'sam', displayName: 'Sam', password: 'local-demo-sam-2026' },
]);
// UI flows intentionally run much faster than household traffic; rate limits have separate HTTP tests.
const { app, access } = await buildApp({
  db,
  dataRoot,
  development: true,
  publicOrigin: 'http://127.0.0.1:4173',
  webRoot: resolve('apps/web/dist'),
  authenticationMode: 'trusted-network',
  requestLimit: 10000,
});
const capture = await buildCaptureApp({ db, dataRoot });
await app.listen({ port: 4173, host: '127.0.0.1' });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
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
