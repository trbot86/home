import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type RequestListener } from 'node:http';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import {
  PublicWebFetcher,
  PublicFetchError,
  isPublicAddress,
  publicWebUrl,
} from '../src/infrastructure/public-web.js';

const ip = (...parts: number[]) => parts.join('.');
const publicAddress = '93.184.216.34';
const rejected = (code: string) => (error: unknown) =>
  error instanceof PublicFetchError && error.code === code;
async function fixture(
  handler: RequestListener,
  timeoutMs = 1000,
  resolve = async () => [{ address: publicAddress, family: 4 as const }],
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const requests: { url: string; options: unknown }[] = [];
  const fetcher = new PublicWebFetcher({
    timeoutMs,
    resolve,
    send(url, options, callback) {
      requests.push({ url: url.href, options });
      assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, true);
      options.lookup!(url.hostname, { all: false }, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, publicAddress);
        assert.equal(family, 4);
      });
      options.lookup!(url.hostname, { all: true }, (error, addresses) => {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: publicAddress, family: 4 }]);
      });
      // A test-only sender connects exclusively to this ephemeral fixture. Production keeps the validated URL.
      return request(
        `http://127.0.0.1:${port}${url.pathname}${url.search}`,
        { headers: options.headers, maxHeaderSize: options.maxHeaderSize },
        callback,
      );
    },
  });
  return {
    fetcher,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('public URL and address policy rejects credentials, local ranges, alternative IP encodings and non-web protocols', () => {
  for (const address of [
    ip(10, 1, 2, 3),
    ip(172, 16, 3, 4),
    ip(192, 168, 1, 9),
    ip(100, 64, 2, 3),
    ip(169, 254, 169, 254),
    '127.0.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.51.100.1',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:7f00:1',
    '64:ff9b::808:808',
    '2001:db8::1',
    '2002:0808:0808::1',
    '7fff::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [publicAddress, '8.8.8.8', '2606:4700:4700::1111'])
    assert.equal(isPublicAddress(address), true);
  const credentialUrl = new URL('https://example.com');
  credentialUrl.username = 'fixture';
  credentialUrl.password = 'fixture';
  for (const url of [
    'file:///test',
    'ftp://example.com/a',
    credentialUrl.href,
    'http://localhost',
    'http://printer.local',
    'http://host.home.arpa',
    'http://host.internal',
    'http://localhost.',
    'http://2130706433',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'http://[::ffff:127.0.0.1]',
    'https://example.com:8443',
  ])
    assert.throws(() => publicWebUrl(url), PublicFetchError);
  assert.equal(
    publicWebUrl('/recipe?x=1#step2', 'https://example.com/page').href,
    'https://example.com/recipe?x=1',
  );
});

test('all resolved addresses must be public; mixed DNS and missing results make no request', async () => {
  for (const addresses of [
    [],
    [{ address: ip(10, 1, 2, 3), family: 4 as const }],
    [
      { address: publicAddress, family: 4 as const },
      { address: '::1', family: 6 as const },
    ],
  ]) {
    const fetcher = new PublicWebFetcher({
      resolve: async () => addresses,
      send: () => {
        throw new Error('Must not connect');
      },
    });
    await assert.rejects(fetcher.get('https://recipe.example/page', 'html'), rejected('non_public_address'));
  }
});

test('GET uses pinned DNS and safe headers, follows bounded public redirects and preserves decoded UTF-8 bytes', async () => {
  const f = await fixture((req, res) => {
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.referer, undefined);
    if (req.url === '/start') {
      res.writeHead(302, { location: '/recipe#ingredients' }).end();
      return;
    }
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' })
      .end(gzipSync('<h1>Crème soup</h1>'));
  });
  try {
    const result = await f.fetcher.get('https://recipe.example/start', 'html');
    assert.equal(result.url, 'https://recipe.example/recipe');
    assert.equal(result.bytes.toString(), '<h1>Crème soup</h1>');
    assert.equal(result.contentType, 'text/html; charset=utf-8');
    assert.equal(f.requests.length, 2);
  } finally {
    await f.close();
  }
});

test('every redirect is revalidated; loop, private hop and HTTPS downgrade are rejected before another request', async () => {
  for (const [location, code] of [
    ['https://recipe.example/start', 'redirect_loop'],
    ['http://recipe.example/plain', 'insecure_redirect'],
    ['http://127.0.0.1/secret', 'non_public_address'],
  ]) {
    const f = await fixture((_req, res) => res.writeHead(302, { location: location! }).end());
    try {
      await assert.rejects(f.fetcher.get('https://recipe.example/start', 'html'), rejected(code!));
      assert.equal(f.requests.length, 1);
    } finally {
      await f.close();
    }
  }
  const f = await fixture((req, res) => res.writeHead(302, { location: `/next/${req.url}` }).end());
  try {
    await assert.rejects(
      f.fetcher.get('https://recipe.example/start', 'html'),
      rejected('too_many_redirects'),
    );
    assert.equal(f.requests.length, 4);
  } finally {
    await f.close();
  }
});

test('declared and decompressed response bounds, content types, corrupt compression and incomplete bodies fail closed', async () => {
  const cases: [RequestListener, string][] = [
    [
      (_req, res) => res.writeHead(200, { 'content-type': 'text/html', 'content-length': 3000000 }).end(),
      'response_too_large',
    ],
    [
      (_req, res) =>
        res
          .writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })
          .end(gzipSync('x'.repeat(2100000))),
      'response_too_large',
    ],
    [
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.write('x'.repeat(2100000));
        res.end();
      },
      'response_too_large',
    ],
    [
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html', 'content-length': 100 });
        res.write('partial');
        setTimeout(() => res.destroy(), 10);
      },
      'truncated_response',
    ],
    [
      (_req, res) => {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
          'content-length': 100,
        });
        res.write(gzipSync('partial').subarray(0, 12));
        setTimeout(() => res.destroy(), 10);
      },
      'truncated_response',
    ],
    [
      (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'),
      'unsupported_content_type',
    ],
    [
      (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'custom' }).end('x'),
      'unsupported_content_encoding',
    ],
    [
      (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end('broken'),
      'fetch_failed',
    ],
    [(_req, res) => res.writeHead(401).end(), 'http_error'],
  ];
  for (const [handler, code] of cases) {
    const f = await fixture(handler);
    try {
      await assert.rejects(f.fetcher.get('https://recipe.example/page', 'html'), rejected(code));
    } finally {
      await f.close();
    }
  }
});

test('DNS changes between redirect hops are blocked before connecting to the changed address', async () => {
  let resolutions = 0;
  const f = await fixture(
    (_req, res) => res.writeHead(302, { location: '/next' }).end(),
    1000,
    async () => [{ address: ++resolutions === 1 ? publicAddress : ip(10, 2, 3, 4), family: 4 as const }],
  );
  try {
    await assert.rejects(
      f.fetcher.get('https://recipe.example/start', 'html'),
      rejected('non_public_address'),
    );
    assert.equal(f.requests.length, 1);
    assert.equal(resolutions, 2);
  } finally {
    await f.close();
  }
});

test('the deadline covers a trickling body and cancellation interrupts an active response', async () => {
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('start');
    const timer = setInterval(() => res.write('.'), 10);
    res.on('close', () => clearInterval(timer));
  }, 100);
  try {
    await assert.rejects(f.fetcher.get('https://recipe.example/slow', 'html'), rejected('request_timeout'));
  } finally {
    await f.close();
  }
  const cancel = new AbortController();
  const c = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('start');
    setTimeout(() => cancel.abort(), 10);
  });
  try {
    await assert.rejects(
      c.fetcher.get('https://recipe.example/cancel', 'html', cancel.signal),
      rejected('cancelled'),
    );
  } finally {
    await c.close();
  }
});

test('image types are bounded separately and brotli decoding preserves the original bytes', async () => {
  const bytes = Buffer.from([137, 80, 78, 71]);
  const f = await fixture((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'br' })
      .end(brotliCompressSync(bytes)),
  );
  try {
    assert.deepEqual((await f.fetcher.get('https://recipe.example/image', 'image')).bytes, bytes);
  } finally {
    await f.close();
  }
  const svg = await fixture((_req, res) =>
    res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>'),
  );
  try {
    await assert.rejects(
      svg.fetcher.get('https://recipe.example/image', 'image'),
      rejected('unsupported_content_type'),
    );
  } finally {
    await svg.close();
  }
});

test('one deadline bounds DNS and response time; caller cancellation aborts without following redirects', async () => {
  const dns = new PublicWebFetcher({ timeoutMs: 30, resolve: () => new Promise(() => {}) });
  // Keep the test process alive while Node's unref'ed AbortSignal deadline fires.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(dns.get('https://recipe.example/page', 'html'), rejected('request_timeout'));
  } finally {
    clearInterval(keepAlive);
  }
  const f = await fixture((_req, _res) => {}, 50);
  try {
    await assert.rejects(f.fetcher.get('https://recipe.example/page', 'html'), rejected('request_timeout'));
  } finally {
    await f.close();
  }
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(
    new PublicWebFetcher().get('https://recipe.example/page', 'html', cancel.signal),
    rejected('cancelled'),
  );
});
