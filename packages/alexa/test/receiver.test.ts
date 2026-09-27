import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureRequest } from '@our-place/contracts';
import { buildAlexaReceiver } from '../src/receiver.js';
import { createRequestVerifier } from '../src/verify-request.js';
import { parseReceiverConfig } from '../src/config.js';
import { signedFixture } from './signed-fixture.js';

const now = Date.parse('2026-09-27T12:00:00Z');
const fixture = signedFixture(now);
test('HTTP receiver verifies signed bytes before capture and exposes only the Alexa route', async () => {
  const captures: CaptureRequest[] = [];
  const app = await buildAlexaReceiver({
    skillId: 'test-skill',
    now: () => now,
    users: new Map([['test-user', { bindingId: 'test-binding', expectedServerEpoch: 'test-epoch' }]]),
    verifyRequest: createRequestVerifier({
      now: () => now,
      trustRoots: fixture.trustRoots,
      fetch: async () => new Response(fixture.pem),
    }),
    capture: async (_binding, capture) => {
      captures.push(capture);
      return {
        status: 'Applied',
        receipt: { operationId: capture.operationId, requestDigest: 'a'.repeat(64), recordedAt: now },
        result: { records: [] },
      };
    },
  });
  try {
    const request = fixture.signed();
    const invoke = (options = request) => app.inject({ method: 'POST', url: '/alexa', ...options });
    assert.equal(
      (await invoke({ ...request, headers: { ...request.headers, 'signature-256': '' } })).statusCode,
      400,
    );
    assert.equal(
      (await invoke({ ...request, payload: Buffer.from(request.payload.toString().replace('blue', 'pink')) }))
        .statusCode,
      400,
    );
    assert.equal(captures.length, 0);
    const saved = await invoke();
    assert.equal(saved.statusCode, 200);
    assert.match(saved.json().response.outputSpeech.text, /^Saved to your shared inbox:/);
    assert.equal(saved.json().response.shouldEndSession, true);
    assert.equal(saved.headers['cache-control'], 'no-store');
    await invoke();
    assert.deepEqual(captures[0], captures[1]);
    const wrongUser = structuredClone(fixture.event);
    wrongUser.context.System.user.userId = 'someone-else';
    const denied = await invoke(fixture.signed(wrongUser));
    assert.doesNotMatch(denied.json().response.outputSpeech.text, /Saved/);
    assert.equal(captures.length, 2);
    for (const url of [
      '/capture/inbox',
      '/api/profiles',
      '/api/session',
      '/api/history',
      '/media/a',
      '/health',
      '/',
    ])
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/alexa',
          payload: 'x',
          headers: { 'content-type': 'text/plain' },
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/alexa',
          ...request,
          headers: { ...request.headers, origin: 'https://example.org' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/alexa',
          ...request,
          headers: { ...request.headers, 'content-encoding': 'gzip' },
        })
      ).statusCode,
      403,
    );
    assert.equal((await invoke({ ...request, payload: Buffer.alloc(64 * 1024 + 1) })).statusCode, 413);
  } finally {
    await app.close();
  }
});

test('production verifier rejects unsigned events and rate limits do not trust forwarded addresses', async () => {
  let captures = 0;
  const app = await buildAlexaReceiver({
    skillId: 'test-skill',
    users: new Map([['test-user', { bindingId: 'test-binding', expectedServerEpoch: 'test-epoch' }]]),
    capture: async () => {
      captures++;
      throw new Error();
    },
  });
  try {
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/alexa',
        payload: fixture.event,
        headers: { 'x-forwarded-for': `203.0.113.${i}` },
      });
      assert.equal(response.statusCode, 400);
    }
    assert.equal(
      (await app.inject({ method: 'POST', url: '/alexa', payload: fixture.event })).statusCode,
      429,
    );
    assert.equal(captures, 0);
  } finally {
    await app.close();
  }
});

test('private config fails closed on extra authority, missing values and invalid credentials', () => {
  const config = {
    skillId: `amzn1.ask.skill.${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`,
    alexaUserIds: ['test-user'],
    expectedServerEpoch: 'test-epoch',
    captureSocketPath: process.platform === 'win32' ? 'C:/socket/test' : '/socket/test',
    captureToken: 'a'.repeat(43),
  };
  assert.deepEqual(parseReceiverConfig(config), config);
  for (const invalid of [
    null,
    [],
    { ...config, verifySignature: false },
    { ...config, captureSocketPath: 'relative' },
    { ...config, alexaUserIds: [] },
    { ...config, captureToken: 'short' },
    { ...config, expectedServerEpoch: '' },
    { ...config, alexaUserIds: ['a', 'a'] },
  ])
    assert.throws(() => parseReceiverConfig(invalid));
});
