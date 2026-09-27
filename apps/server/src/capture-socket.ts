import { lstat, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';

/** Called under capture-entry.sh's lifetime flock in a dedicated, owner-only socket directory. */
export async function prepareCaptureSocket(path: string) {
  if (process.env['CAPTURE_SOCKET_LOCK_HELD'] !== '1')
    throw new Error('Start socket capture through capture-entry.sh');
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!before) return;
  if (!before.isSocket()) throw new Error('Refusing to replace a non-socket capture path');
  const state = await new Promise<'active' | 'stale' | 'missing'>((resolve, reject) => {
    const socket = createConnection({ path });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Capture socket state is uncertain'));
    }, 500);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('active');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED') resolve('stale');
      else if (error.code === 'ENOENT') resolve('missing');
      else reject(new Error('Capture socket state is uncertain'));
    });
  });
  if (state === 'active') throw new Error('Capture socket already has a listener');
  if (state === 'missing') return;
  const after = await lstat(path);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino)
    throw new Error('Capture socket changed during recovery');
  // The lifetime flock excludes another cooperating capture process from racing this unlink.
  // Never delete the directory, lock file, a regular file, symlink, or a reachable listener.
  await unlink(path);
}
