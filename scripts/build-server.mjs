import { build } from 'esbuild';
import { resolve } from 'node:path';
await build({ entryPoints: ['main', 'capture-main', 'bootstrap', 'operations'].map(name => `./src/${name}.ts`), tsconfig: 'tsconfig.json',
  outdir: 'dist', bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: true,
  external: ['better-sqlite3', 'fastify', '@fastify/*', '@sinclair/*', 'tar', 'google-auth-library'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }
});
