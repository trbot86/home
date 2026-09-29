import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
await build({ entryPoints: ['main', 'capture-main', 'capture-admin', 'bootstrap', 'operations', 'filing-worker-main'].map(name => `./src/${name}.ts`), tsconfig: 'tsconfig.json',
  outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true,
  external: ['better-sqlite3', 'fastify', '@fastify/*', '@sinclair/*', 'tar', 'google-auth-library', 'node-ical'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
// Check the emitted bundle too: injected compatibility helpers can collide with source imports.
for (const name of ['main', 'capture-main', 'capture-admin', 'bootstrap', 'operations', 'filing-worker-main']) {
  execFileSync(process.execPath, ['--check', `dist/${name}.js`], { windowsHide: true, stdio: 'pipe' });
}
