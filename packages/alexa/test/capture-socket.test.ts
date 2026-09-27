import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CaptureRequest } from '@our-place/contracts';
import { createSocketCaptureSink } from '../src/capture-socket.js';

test('socket transport fixes destination, validates receipts, bounds waits and never retries itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'alexa-socket-'));
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\alexa-test-${randomUUID()}` : join(root, 'capture.sock');
  const capture: CaptureRequest = {
    operationId: 'test-operation',
    expectedServerEpoch: 'test-epoch',
    capturedAt: 1000,
    destination: 'inbox',
    text: 'A synthetic note',
  };
  const applied = {
    status: 'Applied',
    receipt: { operationId: capture.operationId, requestDigest: 'a'.repeat(64), recordedAt: 1000 },
    result: { records: [] },
  };
  let mode = 'saved';
  const calls: { path: string | undefined; token: string | undefined; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      path: req.url,
      token: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    });
    if (mode === 'lost') {
      res.destroy();
      return;
    }
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'https://example.org' }).end();
      return;
    }
    if (mode === 'revoked') {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (mode === 'hang-headers') return;
    if (mode === 'hang-body') {
      res.write('{');
      return;
    }
    if (mode === 'large') {
      res.end('x'.repeat(16 * 1024 + 1));
      return;
    }
    if (mode === 'malformed') {
      res.end('{');
      return;
    }
    if (mode === 'wrong-id') {
      res.end(JSON.stringify({ ...applied, receipt: { ...applied.receipt, operationId: 'different-id' } }));
      return;
    }
    if (mode === 'restore') {
      res.end(
        JSON.stringify({ status: 'RecoveryRequired', currentServerEpoch: 'new-epoch', restorePoint: 1000 }),
      );
      return;
    }
    res.end(JSON.stringify(applied));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const sink = createSocketCaptureSink({
    socketPath,
    token: 'a'.repeat(43),
    bindingId: 'test-binding',
    timeoutMs: 100,
  });
  try {
    assert.deepEqual(await sink('test-binding', capture), applied);
    assert.deepEqual(calls[0], { path: '/capture/inbox', token: `Bearer ${'a'.repeat(43)}`, body: capture });
    await assert.rejects(sink('other-binding', capture));
    await assert.rejects(sink('test-binding', { ...capture, destination: 'shopping' }));
    assert.equal(calls.length, 1);
    for (mode of [
      'lost',
      'redirect',
      'revoked',
      'hang-headers',
      'hang-body',
      'large',
      'malformed',
      'wrong-id',
    ]) {
      const before: number = calls.length;
      await assert.rejects(sink('test-binding', capture), /^Error: Capture outcome unavailable$/);
      assert.equal(calls.length, before + 1, 'no automatic retry after an uncertain save');
      assert.deepEqual(calls.at(-1)?.body, capture);
    }
    mode = 'restore';
    assert.equal((await sink('test-binding', capture)).status, 'RecoveryRequired');
    mode = 'saved';
    assert.deepEqual(await sink('test-binding', capture), applied);
    assert.ok(calls.every((call) => JSON.stringify(call.body) === JSON.stringify(capture)));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
