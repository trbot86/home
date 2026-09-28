import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = resolve(root, '.local/filing-worker/build');
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['apps/server/src/filing-worker-main.ts'],
  tsconfig: 'apps/server/tsconfig.json',
  outfile: resolve(output, 'worker.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
});
for (const name of [
  'Dockerfile',
  'Proxy.Dockerfile',
  'Guard.Dockerfile',
  'auth-proxy.mjs',
  'network-guard.mjs',
])
  await copyFile(resolve(root, 'ops/filing-worker', name), resolve(output, name));
console.log('Prepared minimal worker build context; no household files or credentials included.');
