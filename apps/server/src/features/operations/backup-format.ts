import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { list } from 'tar';
import { Type, type Static } from '@sinclair/typebox';
import { Digest, Id, Instant, isValid } from '@our-place/contracts';
import Database from 'better-sqlite3';
import type { Sqlite } from '../../infrastructure/database.js';
import { sha256 } from '../media/file-media-store.js';

const object = <T extends Record<string, import('@sinclair/typebox').TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const FileSpec = object({
  path: Type.String({ pattern: '^(database\\.sqlite|media/objects/[a-f0-9-]{36}\\.bin)$' }),
  byteLength: Type.Integer({ minimum: 1, maximum: 20 * 1024 ** 3 }),
  digest: Digest,
});
export const Manifest = object({
  format: Type.Literal(1),
  runId: Id,
  installationId: Id,
  serverEpoch: Id,
  snapshotAt: Instant,
  schemas: Type.Array(
    object({ version: Type.String({ pattern: '^\\d+_[\\w-]+\\.sql$' }), checksum: Digest }),
    { maxItems: 1000 },
  ),
  files: Type.Array(FileSpec, { minItems: 1, maxItems: 20000 }),
  exclusions: Type.Array(Type.String(), { maxItems: 10 }),
});
export type Manifest = Static<typeof Manifest>;
export const Completion = object({
  format: Type.Literal(1),
  manifest: Manifest,
  completedAt: Instant,
  archive: object({
    name: Type.String({ pattern: '^backup-[a-f0-9-]{36}\\.tar\\.gz$' }),
    byteLength: Type.Integer({ minimum: 1, maximum: 30 * 1024 ** 3 }),
    digest: Digest,
  }),
});
export type Completion = Static<typeof Completion>;
export const serialise = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
export async function fileInfo(path: string): Promise<{ byteLength: number; digest: string }> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { byteLength: info.size, digest: hash.digest('hex') };
}
export async function durableWrite(path: string, value: string | Buffer): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function flushFile(path: string): Promise<void> {
  const file = await open(path, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readCompletion(path: string): Promise<Completion> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 ** 2)
    throw new Error('Invalid completion manifest');
  const result: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isValid(Completion, result)) throw new Error('Unsupported completion manifest');
  if (result.archive.name !== `backup-${result.manifest.runId}.tar.gz`)
    throw new Error('Backup identity mismatch');
  const paths = result.manifest.files.map((f) => f.path);
  if (paths.filter((p) => p === 'database.sqlite').length !== 1 || new Set(paths).size !== paths.length)
    throw new Error('Invalid backup file set');
  if (result.manifest.files.reduce((sum, file) => sum + file.byteLength, 0) > 30 * 1024 ** 3)
    throw new Error('Backup exceeds supported size');
  return result;
}
export function verifyDatabase(db: Sqlite): void {
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length
  )
    throw new Error('Snapshot database integrity failed');
  if (
    db
      .prepare(
        "SELECT 1 FROM records r LEFT JOIN inbox_entries i ON i.inbox_id=r.record_id WHERE r.kind='inbox' AND i.inbox_id IS NULL LIMIT 1",
      )
      .get()
  )
    throw new Error('Snapshot record payload missing');
  if (
    db
      .prepare(
        "SELECT 1 FROM attachments a JOIN records r ON r.record_id=a.record_id JOIN media_objects m USING(media_id) WHERE a.removed_at IS NULL AND r.deleted_at IS NULL AND (m.state!='ready' OR m.scope_id!=r.scope_id) LIMIT 1",
      )
      .get()
  )
    throw new Error('Snapshot live media invariant failed');
}
export function readOnlyDatabase(path: string): Sqlite {
  return new Database(path, { readonly: true, fileMustExist: true });
}
export async function verifyArchive(path: string, completion: Completion): Promise<void> {
  const info = await fileInfo(path);
  if (info.byteLength !== completion.archive.byteLength || info.digest !== completion.archive.digest)
    throw new Error('Backup archive checksum mismatch');
  const manifestBytes = Buffer.from(serialise(completion.manifest));
  const expected = new Map(
    [
      ...completion.manifest.files,
      { path: 'manifest.json', byteLength: manifestBytes.length, digest: sha256(manifestBytes) },
    ].map((file) => [file.path, file]),
  );
  const seen = new Set<string>();
  let invalid = false;
  await list({
    file: path,
    strict: true,
    onReadEntry(entry) {
      const spec = expected.get(entry.path);
      if (entry.type !== 'File' || !spec || spec.byteLength !== entry.size || seen.has(entry.path)) {
        invalid = true;
        entry.resume();
        return;
      }
      seen.add(entry.path);
      const hash = createHash('sha256');
      let length = 0;
      entry.on('data', (chunk: Buffer) => {
        length += chunk.length;
        hash.update(chunk);
      });
      entry.on('end', () => {
        if (length !== spec.byteLength || hash.digest('hex') !== spec.digest) invalid = true;
      });
    },
  });
  if (invalid || seen.size !== expected.size)
    throw new Error('Backup archive contents do not match manifest');
}
/** Delete only a generated direct child of the task-owned work directory. */
export async function removeWorkDirectory(root: string, child: string): Promise<void> {
  const absoluteRoot = await realpath(root);
  const absoluteChild = resolve(child);
  const part = relative(absoluteRoot, absoluteChild);
  if (isAbsolute(part) || part.startsWith('..') || part.includes(sep) || !/^[a-f0-9-]{36}$/.test(part))
    throw new Error('Unsafe work directory');
  try {
    const info = await lstat(absoluteChild);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe work directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(absoluteChild, { recursive: true });
}
