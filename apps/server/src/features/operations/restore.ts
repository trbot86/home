import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { extract } from 'tar';
import { immediate, installation, migrate, openDatabase } from '../../infrastructure/database.js';
import { syncDirectory } from '../media/file-media-store.js';
import {
  durableWrite,
  fileInfo,
  readCompletion,
  serialise,
  verifyArchive,
  verifyDatabase,
} from './backup-format.js';

/** Offline administrative operation. The source installation must be stopped by its operator. */
export async function restoreBackup(
  completionPath: string,
  destination: string,
  development = false,
): Promise<{ installationId: string; serverEpoch: string; snapshotAt: number }> {
  destination = resolve(destination);
  try {
    await lstat(destination);
    throw new Error('Restore destination must not exist');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const completion = await readCompletion(completionPath);
  const archivePath = join(dirname(completionPath), completion.archive.name);
  await verifyArchive(archivePath, completion);
  const work = join(dirname(destination), `.restore-${randomUUID()}`);
  await mkdir(work, { mode: 0o700 });
  const expected = new Map(completion.manifest.files.map((file) => [file.path, file.byteLength]));
  expected.set('manifest.json', Buffer.byteLength(serialise(completion.manifest)));
  const seen = new Set<string>();
  let invalid = false;
  // Inspect on extraction as well as verification, so changed archives cannot introduce paths or links.
  await extract({
    file: archivePath,
    cwd: work,
    strict: true,
    preserveOwner: false,
    noMtime: true,
    maxDepth: 3,
    filter(path, entry) {
      if (
        !('type' in entry) ||
        entry.type !== 'File' ||
        expected.get(path) !== entry.size ||
        seen.has(path)
      ) {
        invalid = true;
        return false;
      }
      seen.add(path);
      return true;
    },
  });
  if (invalid || seen.size !== expected.size)
    throw new Error(`Restore archive changed; inspect isolated directory ${work}`);
  for (const file of completion.manifest.files) {
    const actual = await fileInfo(join(work, file.path));
    if (actual.byteLength !== file.byteLength || actual.digest !== file.digest)
      throw new Error(`Restore checksum mismatch; inspect isolated directory ${work}`);
  }
  await mkdir(join(work, 'db'));
  await rename(join(work, 'database.sqlite'), join(work, 'db/household.sqlite'));
  await mkdir(join(work, 'media/staging'), { recursive: true });
  await mkdir(join(work, 'media/objects'), { recursive: true });
  const db = openDatabase(join(work, 'db/household.sqlite'));
  const epoch = randomUUID();
  try {
    const identity = installation(db);
    if (
      identity.installation_id !== completion.manifest.installationId ||
      identity.recovery_epoch !== completion.manifest.serverEpoch
    )
      throw new Error('Restore database identity mismatch');
    const schemas = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
    if (JSON.stringify(schemas) !== JSON.stringify(completion.manifest.schemas))
      throw new Error('Restore schema manifest mismatch');
    migrate(db);
    verifyDatabase(db);
    const ready = db
      .prepare(
        "SELECT 'media/' || storage_key AS path,byte_length AS byteLength,digest FROM media_objects WHERE state='ready' ORDER BY storage_key",
      )
      .all();
    if (
      JSON.stringify(ready) !==
      JSON.stringify(completion.manifest.files.filter((file) => file.path !== 'database.sqlite'))
    )
      throw new Error('Restore media catalogue mismatch');
    immediate(db, () => {
      db.prepare(
        "UPDATE installation_state SET recovery_epoch=?,restored_from_at=?,recovery_mode='reconciling' WHERE singleton=1",
      ).run(epoch, completion.manifest.snapshotAt);
      db.prepare(
        "UPDATE backup_runs SET state='abandoned',error_code='restored_incomplete_run' WHERE state='running'",
      ).run();
      db.prepare(
        "UPDATE background_jobs SET state='paused',error_code='restored_review_required' WHERE state NOT IN ('complete','abandoned')",
      ).run();
      db.prepare('DELETE FROM calendar_authorizations').run();
      db.prepare('DELETE FROM calendar_credentials').run();
      db.prepare(
        "UPDATE calendar_connections SET state='needs_auth',generation=generation+1,error_code='authentication_required' WHERE state<>'disconnected'",
      ).run();
      db.prepare(
        "UPDATE media_objects SET state='collected',unreferenced_at=COALESCE(unreferenced_at,?) WHERE state IN ('staging','deleting')",
      ).run(Date.now());
    });
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  // Sync verified extracted files and all directory entries before publishing the new tree.
  const { flushFile } = await import('./backup-format.js');
  for (const file of completion.manifest.files)
    await flushFile(join(work, file.path === 'database.sqlite' ? 'db/household.sqlite' : file.path));
  await durableWrite(
    join(work, 'restore-complete.json'),
    serialise({ sourceRunId: completion.manifest.runId, newServerEpoch: epoch, restoredAt: Date.now() }),
  );
  for (const path of ['db', 'media/objects', 'media/staging', 'media', ''])
    await syncDirectory(join(work, path), development);
  await rename(work, destination);
  await syncDirectory(dirname(destination), development);
  return {
    installationId: completion.manifest.installationId,
    serverEpoch: epoch,
    snapshotAt: completion.manifest.snapshotAt,
  };
}
