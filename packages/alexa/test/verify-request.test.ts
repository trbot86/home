import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateUrl, createRequestVerifier } from '../src/verify-request.js';
import { fetchBoundedText } from '../src/bounded-fetch.js';
import { signedFixture } from './signed-fixture.js';

const now = Date.parse('2026-09-27T12:00:00Z');
const fixture = signedFixture(now);
test('verifies real RSA signatures and trusted chains, rechecks cached certificate expiry', async () => {
  let clock = now,
    fetches = 0;
  const verify = createRequestVerifier({
    now: () => clock,
    trustRoots: fixture.trustRoots,
    fetch: async (url, options) => {
      assert.equal(String(url), fixture.signed().headers.signaturecertchainurl);
      assert.equal(options?.redirect, 'error');
      assert.ok(options?.signal);
      fetches++;
      return new Response(fixture.pem);
    },
  });
  const request = fixture.signed();
  assert.deepEqual(await verify(request.payload, request.headers), fixture.event);
  await verify(request.payload, request.headers);
  assert.equal(fetches, 1);
  await assert.rejects(
    verify(Buffer.from(request.payload.toString().replace('blue', 'pink')), request.headers),
  );
  const sha1 = fixture.signed(fixture.event, 'RSA-SHA1');
  await assert.rejects(verify(sha1.payload, sha1.headers));
  clock += 120_001;
  const fresh = fixture.signed({
    ...fixture.event,
    request: { ...fixture.event.request, timestamp: new Date(clock).toISOString() },
  });
  await assert.rejects(verify(fresh.payload, fresh.headers), /verification failed/);
});

test('malformed headers, stale/future requests and certificate URL attacks fail before network I/O', async () => {
  let fetches = 0;
  const verify = createRequestVerifier({
    now: () => now,
    trustRoots: fixture.trustRoots,
    fetch: async () => {
      fetches++;
      throw new Error('unexpected fetch');
    },
  });
  for (const url of [
    'http://s3.amazonaws.com/echo.api/x.pem',
    'https://example.org/echo.api/x.pem',
    'https://s3.amazonaws.com:444/echo.api/x.pem',
    'https://s3.amazonaws.com/echo.api/../x.pem',
    'https://s3.amazonaws.com/echo.api/%2e%2e/x.pem',
    'https://s3.amazonaws.com/ECHO.API/x.pem',
    'https://s3.amazonaws.com/echo.api/x.pem?query=1',
    'https://s3.amazonaws.com/echo.api/x.pem#fragment',
  ]) {
    const request = fixture.signed();
    request.headers.signaturecertchainurl = url;
    await assert.rejects(verify(request.payload, request.headers));
  }
  const request = fixture.signed();
  await assert.rejects(verify(request.payload, {}));
  await assert.rejects(verify(request.payload, { ...request.headers, 'signature-256': ['one', 'two'] }));
  await assert.rejects(verify(request.payload, { ...request.headers, 'signature-256': '!'.repeat(344) }));
  for (const timestamp of [
    '',
    'invalid',
    new Date(now - 150_001).toISOString(),
    new Date(now + 150_001).toISOString(),
  ]) {
    const invalid = fixture.signed({ ...fixture.event, request: { ...fixture.event.request, timestamp } });
    await assert.rejects(verify(invalid.payload, invalid.headers));
  }
  const malformed = fixture.signed('{bad json');
  await assert.rejects(verify(malformed.payload, malformed.headers));
  assert.equal(fetches, 0);
  assert.equal(
    certificateUrl('https://S3.AMAZONAWS.COM:443/echo.api/../echo.api/x.pem'),
    'https://s3.amazonaws.com/echo.api/x.pem',
  );
});

test('self-signed impostors, wrong SAN and non-DNS SAN fail even with valid body signatures', async () => {
  const request = fixture.signed();
  const wrongTrust = createRequestVerifier({
    now: () => now,
    trustRoots: [],
    fetch: async () => new Response(fixture.pem),
  });
  await assert.rejects(wrongTrust(request.payload, request.headers));
  for (const [san, type] of [
    ['impostor.example', 2],
    ['*.amazon.com', 2],
    ['echo-api.amazon.com', 1],
  ] as const) {
    const impostor = signedFixture(now, san, type);
    const verify = createRequestVerifier({
      now: () => now,
      trustRoots: impostor.trustRoots,
      fetch: async () => new Response(impostor.pem),
    });
    const signed = impostor.signed();
    await assert.rejects(verify(signed.payload, signed.headers));
  }
});

test('certificate fetch is bounded across headers and body and never accepts redirects', async () => {
  for (const response of [new Response('redirect', { status: 302 }), new Response('x'.repeat(33))]) {
    await assert.rejects(
      fetchBoundedText('https://example.org', { maxBytes: 32, timeoutMs: 50, fetch: async () => response }),
    );
  }
  let aborted = false;
  await assert.rejects(
    fetchBoundedText('https://example.org', {
      maxBytes: 32,
      timeoutMs: 10,
      fetch: async (_url, options) => {
        options?.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      },
    }),
    /timed out/,
  );
  assert.equal(aborted, true);
});
