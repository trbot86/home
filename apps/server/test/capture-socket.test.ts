import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { prepareCaptureSocket } from '../src/capture-socket.js';

test(
  'socket recovery requires its lock and preserves ordinary files, symlinks and active listeners',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'capture-socket-'));
    const path = join(root, 'capture.sock');
    const previous = process.env['CAPTURE_SOCKET_LOCK_HELD'];
    const server = createServer((connection) => connection.end());
    try {
      delete process.env['CAPTURE_SOCKET_LOCK_HELD'];
      await assert.rejects(prepareCaptureSocket(path), /capture-entry/);
      process.env['CAPTURE_SOCKET_LOCK_HELD'] = '1';
      await prepareCaptureSocket(path);
      await writeFile(path, 'never delete ordinary files');
      await assert.rejects(prepareCaptureSocket(path), /non-socket/);
      assert.equal(await readFile(path, 'utf8'), 'never delete ordinary files');
      await rm(path);
      await writeFile(join(root, 'target'), 'never follow symlinks');
      await symlink(join(root, 'target'), path);
      await assert.rejects(prepareCaptureSocket(path), /non-socket/);
      assert.equal((await lstat(path)).isSymbolicLink(), true);
      await rm(path);
      await new Promise<void>((ready) => server.listen(path, ready));
      const before = await lstat(path);
      await assert.rejects(prepareCaptureSocket(path), /already has a listener/);
      assert.equal((await lstat(path)).ino, before.ino);
    } finally {
      if (previous === undefined) delete process.env['CAPTURE_SOCKET_LOCK_HELD'];
      else process.env['CAPTURE_SOCKET_LOCK_HELD'] = previous;
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, { recursive: true, force: true });
    }
  },
);
