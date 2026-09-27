import { isAbsolute, resolve } from 'node:path';
import { chmod } from 'node:fs/promises';
import { buildCaptureApp } from './capture-app.js';
import { installation } from './infrastructure/database.js';
import { prepareCaptureSocket } from './capture-socket.js';

if (process.env['CAPTURE_ENABLED'] !== '1') throw new Error('Capture listener is disabled');
const dataRoot = process.env['DATA_ROOT'],
  expected = process.env['EXPECTED_INSTALLATION_ID'];
const socketPath = process.env['CAPTURE_SOCKET'];
const port = Number(process.env['CAPTURE_PORT']);
if (
  !dataRoot ||
  !expected ||
  (socketPath
    ? !isAbsolute(socketPath) || process.env['CAPTURE_PORT'] !== undefined
    : !Number.isInteger(port) || port < 1 || port > 65535)
)
  throw new Error('Set DATA_ROOT, EXPECTED_INSTALLATION_ID and either CAPTURE_SOCKET or CAPTURE_PORT');
const { app, db } = await buildCaptureApp({ dataRoot: resolve(dataRoot) });
if (installation(db).installation_id !== expected) {
  await app.close();
  throw new Error('Wrong household data volume: installation identity does not match');
}
if (socketPath) {
  // The parent directory is a dedicated socket volume shared only with the receiver.
  // Both processes use the same unprivileged UID. No database/media mount is shared with it.
  process.umask(0o077);
  await prepareCaptureSocket(socketPath);
  await app.listen({ path: socketPath });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
} else {
  await app.listen({ host: process.env['CAPTURE_HOST'] ?? '127.0.0.1', port });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
