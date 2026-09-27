import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export default defineConfig({
  plugins: [{ name: 'offline-shell', generateBundle(_options, bundle) {
    const files = ['/index.html', ...Object.keys(bundle).filter(name => name.startsWith('assets/')).map(name => `/${name}`)];
    const version = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
    const template = readFileSync(new URL('./src/platform/browser/service-worker.template.js', import.meta.url), 'utf8');
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: template.replace('__CACHE_NAME__', JSON.stringify(`our-place-shell-${version}`)).replace('__SHELL_FILES__', JSON.stringify(files)) });
  } }],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000' } },
  build: { target: 'es2022' }
});
