import { resolve } from 'node:path';
import { buildCaptureApp } from './capture-app.js';
import { installation } from './infrastructure/database.js';

if (process.env['CAPTURE_ENABLED'] !== '1') throw new Error('Capture listener is disabled');
const dataRoot = process.env['DATA_ROOT'],
  expected = process.env['EXPECTED_INSTALLATION_ID'];
const port = Number(process.env['CAPTURE_PORT']);
if (!dataRoot || !expected || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Set DATA_ROOT, EXPECTED_INSTALLATION_ID and a separate CAPTURE_PORT');
const { app, db } = await buildCaptureApp({ dataRoot: resolve(dataRoot) });
if (installation(db).installation_id !== expected) {
  await app.close();
  throw new Error('Wrong household data volume: installation identity does not match');
}
await app.listen({ host: process.env['CAPTURE_HOST'] ?? '127.0.0.1', port });
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void app.close();
  });
