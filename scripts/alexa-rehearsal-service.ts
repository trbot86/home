// Test-only container executable. Production images never include this entry point or test trust roots.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { chmod, cp, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { integrationFixture } from '../apps/server/test/integration-fixture.js';
import { migrate } from '../apps/server/src/infrastructure/database.js';
import { AccessService } from '../apps/server/src/features/access/access.js';
import { IntegrationAccessService } from '../apps/server/src/features/access/integrations.js';
import { buildCaptureApp } from '../apps/server/src/capture-app.js';
import { prepareCaptureSocket } from '../apps/server/src/capture-socket.js';
import { buildAlexaReceiver } from '../packages/alexa/src/receiver.js';
import { createSocketCaptureSink } from '../packages/alexa/src/capture-socket.js';
import { createRequestVerifier } from '../packages/alexa/src/verify-request.js';
import { signedFixture } from '../packages/alexa/test/signed-fixture.js';

const fixturePath = '/fixture/connection.json';
const dataRoot = '/test-data/household';
const socketPath = '/sockets/capture.sock';
async function json(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function atomicJson(path: string, value: unknown) {
  await writeFile(`${path}.new`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.new`, path);
}
async function waitFor(path: string) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await delay(50);
  }
  throw new Error('Synthetic fixture startup timed out');
}
async function seed() {
  if (existsSync(fixturePath)) return;
  // Only this test image creates the fixture; the production helper never seeds or migrates.
  if (existsSync(dataRoot)) throw new Error('Refusing to overwrite an incomplete fixture');
  const f = await integrationFixture();
  try {
    migrate(f.db);
    const administrator = new AccessService(f.db, f.now).authenticate('a'.repeat(43));
    const integration = new IntegrationAccessService(f.db, f.now).provision(
      administrator,
      'Alexa',
      Date.now() + 3600_000,
    );
    f.db.pragma('wal_checkpoint(TRUNCATE)');
    f.db.close();
    await cp(f.dataRoot, dataRoot, { recursive: true, errorOnExist: true, force: false });
    await atomicJson(fixturePath, {
      token: integration.secret,
      integrationId: integration.integrationId,
      epoch: 'fixture-epoch',
    });
  } finally {
    await f.close();
  }
}
async function capture() {
  await seed();
  const child = spawn(
    '/bin/sh',
    [
      'apps/server/capture-entry.sh',
      process.execPath,
      '--import',
      'tsx',
      'scripts/alexa-rehearsal-service.ts',
      'capture-listen',
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, CAPTURE_SOCKET: socketPath },
    },
  );
  process.once('SIGTERM', () => child.kill('SIGTERM'));
  child.once('exit', (code) => process.exit(code ?? 1));
}
async function captureListen() {
  await prepareCaptureSocket(socketPath);
  const config = await json(fixturePath);
  const { app, db } = await buildCaptureApp({ dataRoot });
  const report = async () =>
    atomicJson('/fixture/result.json', {
      notes: (
        db
          .prepare('SELECT COUNT(*) AS n FROM change_sets WHERE actor_integration_id=?')
          .get(config.integrationId) as { n: number }
      ).n,
      socketMode: (await stat(socketPath)).mode & 0o777,
    });
  app.addHook('onSend', async (request, reply, payload) => {
    await report();
    if (
      request.url === '/capture/inbox' &&
      reply.statusCode === 200 &&
      !existsSync('/test-data/dropped-ack')
    ) {
      await writeFile('/test-data/dropped-ack', 'synthetic lost acknowledgement');
      reply.raw.destroy();
    }
    return payload;
  });
  process.umask(0o077);
  await app.listen({ path: socketPath });
  await chmod(socketPath, 0o600);
  await report();
  process.once('SIGTERM', () => {
    void app.close();
  });
}
async function receiver() {
  await waitFor(fixturePath);
  const config = await json(fixturePath);
  // Explicit test-only verifier. Its test CA cannot be installed through production config.
  const signed = signedFixture(Date.now());
  const request = signed.signed();
  await atomicJson('/requests/request.json', {
    headers: request.headers,
    body: request.payload.toString('utf8'),
  });
  const app = await buildAlexaReceiver({
    skillId: 'test-skill',
    users: new Map([['test-user', { bindingId: 'synthetic-binding', expectedServerEpoch: config.epoch }]]),
    verifyRequest: createRequestVerifier({
      trustRoots: signed.trustRoots,
      fetch: async () => new Response(signed.pem),
    }),
    capture: createSocketCaptureSink({ socketPath, token: config.token, bindingId: 'synthetic-binding' }),
  });
  await app.listen({ host: '127.0.0.1', port: 3000 });
  process.once('SIGTERM', () => {
    void app.close();
  });
}
function connect(host: string, port: number, family?: 4 | 6): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, ...(family ? { family } : {}) });
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('error', () => done(false));
    socket.once('connect', () => done(true));
  });
}
async function probe() {
  const targets = JSON.parse(process.env['REHEARSAL_TARGETS'] ?? '[]') as {
    name: string;
    host: string;
    port: number;
    family?: 4 | 6;
  }[];
  const results = [];
  for (const target of targets)
    results.push({ name: target.name, connected: await connect(target.host, target.port, target.family) });
  console.log(JSON.stringify({ results }));
}
async function exercise() {
  await waitFor('/requests/request.json');
  const request = await json('/requests/request.json');
  const invoke = async (body = request.body) => {
    const response = await fetch('http://127.0.0.1:3000/alexa', {
      method: 'POST',
      headers: request.headers,
      body,
    });
    return { status: response.status, value: (await response.json()) as any };
  };
  const first = await invoke();
  const result = await json('/fixture/result.json');
  assert.equal(result.notes, 1);
  assert.equal(result.socketMode, 0o600);
  if (process.env['EXPECT_REPLAY'] !== '1')
    assert.match(first.value.response.outputSpeech.text, /couldn't confirm/);
  const retry = await invoke();
  assert.match(retry.value.response.outputSpeech.text, /^Saved to your shared inbox:/);
  assert.equal(retry.value.response.shouldEndSession, true);
  assert.equal((await json('/fixture/result.json')).notes, 1);
  assert.equal((await invoke(request.body.replace('blue', 'pink'))).status, 400);
  assert.equal((await fetch('http://127.0.0.1:3000/api/profiles')).status, 404);
  assert.equal(existsSync('/test-data'), true); // Image contains an empty mount point, never the helper's data volume.
  assert.equal(existsSync('/test-data/household'), false);
  console.log(
    JSON.stringify({
      capture: 'one-note',
      retry: 'same-receipt',
      forged: 'rejected',
      socketMode: result.socketMode,
    }),
  );
}
async function outbound() {
  const response = await fetch('https://s3.amazonaws.com/echo.api/echo-api-cert.pem', {
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /BEGIN CERTIFICATE/);
  console.log(JSON.stringify({ amazonCertificateFetch: true }));
}
const mode = process.argv[2];
if (mode === 'capture') await capture();
else if (mode === 'capture-listen') await captureListen();
else if (mode === 'receiver') await receiver();
else if (mode === 'probe') await probe();
else if (mode === 'exercise') await exercise();
else if (mode === 'outbound') await outbound();
else if (mode === 'sentinel') createServer((_req, res) => res.end('synthetic sentinel')).listen(8443, '::');
else if (mode === 'capture-network') {
  assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
  assert.equal(await connect('1.1.1.1', 443), false);
  console.log(JSON.stringify({ captureNetworkDisabled: true }));
} else throw new Error('Unknown rehearsal mode');
