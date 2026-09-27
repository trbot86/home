import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerClientDownloads } from '../src/features/operations/client-downloads.js';

test('installer serves only named artifacts, preserves APK bytes and never exposes nearby private files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'our-place-install-'));
  const directory = join(root, 'install');
  const app = Fastify();
  try {
    await mkdir(directory);
    const apk = Buffer.from([0x50, 0x4b, 3, 4, 0, 255]);
    await writeFile(join(directory, 'our-place-debug.apk'), apk);
    await writeFile(join(directory, 'index.html'), '<h1>Install</h1>');
    await writeFile(join(directory, 'accidental-secret.json'), 'not public');
    await writeFile(join(root, 'accounts.json'), 'not public');
    registerClientDownloads(app, directory);
    const redirect = await app.inject('/install');
    assert.equal(redirect.statusCode, 308);
    assert.equal(redirect.headers.location, '/install/');
    assert.equal((await app.inject('/install/')).body, '<h1>Install</h1>');
    const download = await app.inject('/install/our-place-debug.apk');
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, apk);
    assert.equal(download.headers['content-type'], 'application/vnd.android.package-archive');
    assert.equal(download.headers['content-disposition'], 'attachment; filename="our-place-debug.apk"');
    assert.equal(download.headers['cache-control'], 'no-store');
    for (const path of [
      '/install/accidental-secret.json',
      '/install/accounts.json',
      '/accounts.json',
      '/install/../accounts.json',
      '/install/%2e%2e%2faccounts.json',
      '/install/build.json',
    ])
      assert.equal((await app.inject(path)).statusCode, 404, path);
    await mkdir(join(directory, 'build.json'));
    assert.equal((await app.inject('/install/build.json')).statusCode, 404, 'directory is not a file');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('installer remains disabled when no distribution folder is configured', async () => {
  const app = Fastify();
  try {
    registerClientDownloads(app);
    assert.equal((await app.inject('/install/')).statusCode, 404);
    assert.equal((await app.inject('/install/our-place-debug.apk')).statusCode, 404);
  } finally {
    await app.close();
  }
});
