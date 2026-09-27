import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'],
  tsconfig: 'tsconfig.json',
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: ['fastify', '@fastify/*', 'node-forge'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
