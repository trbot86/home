import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createBroker } from './broker.mjs';
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
