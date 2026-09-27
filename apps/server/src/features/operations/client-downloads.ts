import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

// An optional, read-only distribution folder. Only these public artifacts are served;
// adjacent account files, backups and arbitrary directory contents are never routes.
const artifacts = [
  ['index.html', 'text/html; charset=utf-8'],
  ['install.css', 'text/css; charset=utf-8'],
  ['theme.css', 'text/css; charset=utf-8'],
  ['install.js', 'text/javascript; charset=utf-8'],
  ['build.json', 'application/json; charset=utf-8'],
  ['our-place-debug.apk', 'application/vnd.android.package-archive'],
] as const;

export function registerClientDownloads(app: FastifyInstance, directory?: string) {
  if (!directory) return;
  const root = resolve(directory);
  app.get('/install', async (_request, reply) => reply.redirect('/install/', 308));
  for (const [name, contentType] of artifacts) {
    app.get(name === 'index.html' ? '/install/' : `/install/${name}`, async (_request, reply) => {
      const path = join(root, name);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isFile()) return reply.code(404).send({ code: 'unavailable' });
      reply.type(contentType).header('cache-control', 'no-store');
      if (name.endsWith('.apk')) reply.header('content-disposition', `attachment; filename="${name}"`);
      return reply.send(createReadStream(path));
    });
  }
}
