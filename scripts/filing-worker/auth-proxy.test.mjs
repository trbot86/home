import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createAuthProxy, publicAddress } from '../../ops/filing-worker/auth-proxy.mjs';

test('authentication proxy rejects other authorities and DNS results pointing to private networks', async () => {
  // Synthetic range boundaries, expressed as octets rather than deployment addresses.
  for (const octets of [
    [127, 0, 0, 1],
    [10, 1, 1, 1],
    [172, 16, 0, 1],
    [192, 168, 1, 1],
    [169, 254, 1, 1],
    [100, 64, 0, 1],
  ])
    assert.equal(publicAddress(octets.join('.')), false);
  assert.equal(publicAddress('::1'), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  let queries = 0;
  const server = createAuthProxy(
    async () => {
      queries++;
      return [{ address: '127.0.0.1' }];
    },
    () => {
      throw Error('Must not connect');
    },
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const target of [
      'example.com:443',
      'auth.openai.com:80',
      'auth.openai.com.evil:443',
      'auth.openai.com:443',
    ]) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request({
          host: '127.0.0.1',
          port: server.address().port,
          method: 'CONNECT',
          path: target,
        });
        request.on('connect', (response, socket) => {
          socket.destroy();
          resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end();
      });
      assert.equal(status, 403);
    }
    assert.equal(queries, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
