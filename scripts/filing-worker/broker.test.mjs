import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker } from './broker.mjs';

test('supervised broker exits when its parent lifetime pipe closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'our-place-broker-'));
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = join(root, 'broker.json');
  await writeFile(
    config,
    JSON.stringify({
      repository: root,
      docker: process.execPath,
      port,
      token: randomBytes(32).toString('base64url'),
    }),
  );
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./broker.mjs', import.meta.url)), config, '--supervised'],
    {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe'],
    },
  );
  const exited = once(child, 'exit');
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}`)).status === 403;
      } catch {
        await delay(25);
      }
    }
    assert(ready, 'Broker must listen before its supervisor exits');
    child.stdin.end();
    const result = await Promise.race([exited, delay(5000).then(() => null)]);
    assert.deepEqual(result, [0, null]);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
test('broker requires its private token, bounds concurrency, and cancels a disconnected job', async () => {
  const token = randomBytes(32).toString('base64url');
  let calls = 0,
    signal,
    entered;
  const started = new Promise((r) => (entered = r));
  const server = createBroker({ token }, async (_config, _payload, s) => {
    calls++;
    signal = s;
    entered();
    await new Promise((_r, reject) => s.addEventListener('abort', () => reject(Error()), { once: true }));
  });
  server.listen(0, 'localhost');
  await once(server, 'listening');
  const url = `http://localhost:${server.address().port}/filing`;
  const request = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ version: 1, model: 'gpt-5.6-luna', effort: 'low' }),
  };
  const abort = new AbortController();
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    const first = fetch(url, { ...request, signal: abort.signal });
    await started;
    assert.equal((await fetch(url, request)).status, 503);
    abort.abort();
    await assert.rejects(first);
    if (!signal.aborted) await once(signal, 'abort');
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('broker carries larger title contexts and four-digit keys with bounded input', async () => {
  const token = randomBytes(32).toString('base64url');
  let calls = 0;
  const server = createBroker({ token }, async (_config, payload) => {
    calls++;
    assert(JSON.parse(payload).input.choices.length === 1003);
    return JSON.stringify({ keys: ['1002'] });
  });
  server.listen(0, 'localhost');
  await once(server, 'listening');
  try {
    const url = `http://localhost:${server.address().port}/filing`;
    const options = {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        version: 1,
        model: 'gpt-5.6-luna',
        effort: 'low',
        input: {
          text: 'synthetic',
          choices: Array.from({ length: 1003 }, (_, i) => ({
            key: String(i),
            label: 'Synthetic project '.repeat(7),
          })),
        },
      }),
    };
    assert(options.body.length > 65536);
    const response = await fetch(url, options);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { keys: ['1002'] });
    const overflow = await fetch(url, { ...options, body: 'x'.repeat(2 * 1024 * 1024 + 1) });
    assert.equal(overflow.status, 503);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
