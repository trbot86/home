import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, statfs, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { create } from 'tar';
import type { BackupStatus, BackupSummary } from '@our-place/contracts';
import { installation, openDatabase, type Sqlite } from '../../infrastructure/database.js';
import { FileMediaStore, syncDirectory } from '../media/file-media-store.js';
import { MediaRetentionGate } from '../media/retention-gate.js';
import { secondaryReportName, type SecondaryBackupReport } from './backup-replication.js';
import {
  durableWrite,
  fileInfo,
  flushFile,
  readCompletion,
  readOnlyDatabase,
  removeWorkDirectory,
  serialise,
  verifyArchive,
  verifyDatabase,
  type Completion,
  type Manifest,
} from './backup-format.js';

const marker = '.our-place-backups.json';
export async function initialiseBackupDestination(
  directory: string,
  installationId: string,
  development = false,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('Backup directory cannot be a symbolic link');
  const entries = await readdir(directory);
  if (entries.length) throw new Error('Choose an empty, dedicated backup directory');
  await durableWrite(join(directory, marker), serialise({ format: 1, installationId }));
  await syncDirectory(directory, development);
  await syncDirectory(dirname(resolve(directory)), development);
}
type Options = {
  dataRoot: string;
  outputRoot?: string;
  development?: boolean;
  now?: () => number;
  afterSnapshot?: (manifest: Manifest) => Promise<void>;
};
export class BackupCoordinator {
  private running: Promise<Completion> | null = null;
  private readonly now: () => number;
  readonly workRoot: string;
  constructor(
    private readonly db: Sqlite,
    private readonly files: FileMediaStore,
    private readonly retention: MediaRetentionGate,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
    this.workRoot = join(options.dataRoot, 'backup-work');
  }
  async initialise(): Promise<void> {
    await mkdir(this.workRoot, { recursive: true });
    if ((await lstat(this.workRoot)).isSymbolicLink()) throw new Error('Unsafe backup work directory');
    this.db
      .prepare(
        "UPDATE backup_runs SET state='abandoned',error_code='process_interrupted' WHERE state='running'",
      )
      .run();
    for (const name of await readdir(this.workRoot))
      if (/^[a-f0-9-]{36}$/.test(name)) await removeWorkDirectory(this.workRoot, join(this.workRoot, name));
    await this.cleanInterruptedExports();
  }
  private async cleanInterruptedExports(): Promise<void> {
    let root: string;
    try {
      root = await this.destination();
    } catch {
      return;
    }
    const rows = this.db
      .prepare("SELECT run_id FROM backup_runs WHERE state IN ('failed','abandoned')")
      .all() as { run_id: string }[];
    for (const { run_id: id } of rows) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Unsafe interrupted backup identity');
      const name = `backup-${id}.tar.gz`;
      try {
        await lstat(join(root, `${name}.complete.json`));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      for (const file of [name, `${name}.partial`, `${name}.complete.json.partial`]) {
        try {
          await unlink(join(root, file));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }
  }
  private async destination(): Promise<string> {
    const root = this.options.outputRoot;
    if (!root) throw new Error('Backup destination not configured');
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Backup destination unavailable');
    const markerPath = join(root, marker);
    const markerInfo = await lstat(markerPath);
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4096)
      throw new Error('Invalid backup destination marker');
    const value = JSON.parse(await readFile(markerPath, 'utf8')) as {
      format?: number;
      installationId?: string;
    };
    if (value.format !== 1 || value.installationId !== installation(this.db).installation_id)
      throw new Error('Backup destination belongs to a different installation');
    return root;
  }
  create(): Promise<Completion> {
    if (this.running) return this.running;
    const promise = this.export();
    this.running = promise;
    void promise
      .finally(() => {
        if (this.running === promise) this.running = null;
      })
      .catch(() => {});
    return promise;
  }
  async wait(): Promise<void> {
    await this.running?.catch(() => {});
  }
  private async export(): Promise<Completion> {
    const runId = randomUUID();
    const startedAt = this.now();
    const scratch = join(this.workRoot, runId);
    this.db
      .prepare("INSERT INTO backup_runs(run_id,started_at,state) VALUES (?,?,'running')")
      .run(runId, startedAt);
    let release: (() => void) | undefined;
    try {
      const output = await this.destination();
      const pageCount = Number(this.db.pragma('page_count', { simple: true }));
      const pageSize = Number(this.db.pragma('page_size', { simple: true }));
      const mediaSize = (
        this.db
          .prepare("SELECT COALESCE(sum(byte_length),0) AS n FROM media_objects WHERE state='ready'")
          .get() as { n: number }
      ).n;
      const needed = pageCount * pageSize + mediaSize + 64 * 1024 ** 2;
      for (const root of [output, this.workRoot]) {
        const capacity = await statfs(root);
        if (capacity.bavail * capacity.bsize < needed * 2) throw new Error('Insufficient backup space');
      }
      await mkdir(scratch);
      await mkdir(join(scratch, 'media/objects'), { recursive: true });
      release = await this.retention.hold();
      const deadline = Date.now() + 15 * 60000;
      const checkDeadline = () => {
        if (Date.now() > deadline) throw new Error('Backup time limit exceeded');
      };
      const snapshotPath = join(scratch, 'database.sqlite');
      await this.db.backup(snapshotPath, {
        progress: () => {
          checkDeadline();
          return 128;
        },
      });
      const snapshotAt = this.now();
      // Close the copied database without companion files before packaging it.
      const snapshot = openDatabase(snapshotPath);
      let manifest: Manifest;
      try {
        snapshot.pragma('wal_checkpoint(TRUNCATE)');
        snapshot.pragma('journal_mode = DELETE');
        verifyDatabase(snapshot);
        const identity = installation(snapshot);
        manifest = {
          format: 1,
          runId,
          installationId: identity.installation_id,
          serverEpoch: identity.recovery_epoch,
          snapshotAt,
          schemas: snapshot
            .prepare('SELECT version,checksum FROM schema_migrations ORDER BY version')
            .all() as Manifest['schemas'],
          files: snapshot
            .prepare(
              "SELECT 'media/' || storage_key AS path,byte_length AS byteLength,digest FROM media_objects WHERE state='ready' ORDER BY storage_key",
            )
            .all() as Manifest['files'],
          exclusions: [
            'Partial uploads',
            'Rebuildable thumbnails',
            'Backup scratch files',
            'Host configuration and external credentials',
          ],
        };
      } finally {
        snapshot.close();
      }
      await flushFile(snapshotPath);
      manifest.files.unshift({ path: 'database.sqlite', ...(await fileInfo(snapshotPath)) });
      if (
        manifest.files.length > 20000 ||
        manifest.files.reduce((sum, file) => sum + file.byteLength, 0) > 30 * 1024 ** 3
      )
        throw new Error('Backup exceeds supported size');
      this.db.prepare('UPDATE backup_runs SET snapshot_at=? WHERE run_id=?').run(snapshotAt, runId);
      await this.options.afterSnapshot?.(manifest);
      for (const file of manifest.files) {
        checkDeadline();
        if (file.path === 'database.sqlite') continue;
        const source = this.files.path(file.path.slice(6));
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Unsafe original media');
        const target = join(scratch, file.path);
        await copyFile(source, target);
        const actual = await fileInfo(target);
        if (actual.byteLength !== file.byteLength || actual.digest !== file.digest)
          throw new Error('Backup media checksum mismatch');
      }
      // Once the complete immutable set has been copied and checked, GC can resume.
      release();
      release = undefined;
      await durableWrite(join(scratch, 'manifest.json'), serialise(manifest));
      const name = `backup-${runId}.tar.gz`;
      const partialPath = join(output, `${name}.partial`);
      // Reserve the filename ourselves; tar writes only this unique app-owned file.
      const reservation = await open(partialPath, 'wx', 0o600);
      await reservation.close();
      await create(
        { cwd: scratch, file: partialPath, gzip: true, portable: true, noMtime: true, strict: true },
        ['manifest.json', ...manifest.files.map((file) => file.path)],
      );
      checkDeadline();
      await flushFile(partialPath);
      const completion: Completion = {
        format: 1,
        manifest,
        completedAt: this.now(),
        archive: { name, ...(await fileInfo(partialPath)) },
      };
      await verifyArchive(partialPath, completion);
      checkDeadline();
      await rename(partialPath, join(output, name));
      await syncDirectory(output, !!this.options.development);
      const completionName = `${name}.complete.json`;
      await durableWrite(join(output, `${completionName}.partial`), serialise(completion));
      await rename(join(output, `${completionName}.partial`), join(output, completionName));
      await syncDirectory(output, !!this.options.development);
      this.db
        .prepare(
          "UPDATE backup_runs SET state='complete',completed_at=?,archive_name=?,byte_length=?,digest=?,verified_at=? WHERE run_id=?",
        )
        .run(
          completion.completedAt,
          name,
          completion.archive.byteLength,
          completion.archive.digest,
          this.now(),
          runId,
        );
      return completion;
    } catch (error) {
      this.db
        .prepare("UPDATE backup_runs SET state='failed',error_code=? WHERE run_id=?")
        .run(
          (error as NodeJS.ErrnoException).code === 'ENOSPC' ? 'insufficient_space' : 'export_failed',
          runId,
        );
      throw error;
    } finally {
      release?.();
      await removeWorkDirectory(this.workRoot, scratch);
      await this.cleanInterruptedExports();
    }
  }
  async status(): Promise<BackupStatus> {
    let root: string | undefined;
    try {
      root = await this.destination();
    } catch {
      /* Missing output is status, not lost household data. */
    }
    // Reconcile a completion marker published just before a process interruption.
    if (root)
      for (const name of await readdir(root))
        if (/^backup-[a-f0-9-]{36}\.tar\.gz\.complete\.json$/.test(name)) {
          try {
            const completion = await readCompletion(join(root, name));
            const row = this.db
              .prepare('SELECT state FROM backup_runs WHERE run_id=?')
              .get(completion.manifest.runId) as { state: string } | undefined;
            if (
              completion.manifest.installationId !== installation(this.db).installation_id ||
              row?.state === 'complete' ||
              row?.state === 'pruned'
            )
              continue;
            await verifyArchive(join(root, completion.archive.name), completion);
            this.db
              .prepare(
                `INSERT INTO backup_runs(run_id,started_at,snapshot_at,completed_at,state,archive_name,byte_length,digest,verified_at)
          VALUES (?,?,?,?,'complete',?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET state='complete',completed_at=excluded.completed_at,archive_name=excluded.archive_name,byte_length=excluded.byte_length,digest=excluded.digest,verified_at=excluded.verified_at,error_code=NULL`,
              )
              .run(
                completion.manifest.runId,
                completion.manifest.snapshotAt,
                completion.manifest.snapshotAt,
                completion.completedAt,
                completion.archive.name,
                completion.archive.byteLength,
                completion.archive.digest,
                this.now(),
              );
          } catch {
            /* Invalid or incomplete exports never become available restore points. */
          }
        }
    const rows = this.db
      .prepare(
        'SELECT run_id AS runId,started_at AS startedAt,snapshot_at AS snapshotAt,completed_at AS completedAt,state,byte_length AS byteLength,verified_at AS verifiedAt,error_code AS errorCode,archive_name AS archiveName FROM backup_runs ORDER BY started_at DESC,rowid DESC LIMIT 40',
      )
      .all() as (Omit<BackupSummary, 'available'> & { archiveName: string | null })[];
    const runs: BackupSummary[] = [];
    for (const { archiveName, ...row } of rows) {
      let available = false;
      if (root && row.state === 'complete' && archiveName)
        try {
          const completion = await readCompletion(join(root, `${archiveName}.complete.json`));
          const info = await lstat(join(root, archiveName));
          available =
            completion.manifest.runId === row.runId &&
            info.isFile() &&
            !info.isSymbolicLink() &&
            info.size === row.byteLength;
        } catch {
          /* A past successful export does not establish current availability. */
        }
      runs.push({ ...row, available });
    }
    let secondary: SecondaryBackupReport | undefined;
    if (root)
      try {
        const path = join(root, secondaryReportName);
        const info = await lstat(path);
        if (info.isFile() && !info.isSymbolicLink() && info.size < 4096) {
          const report = JSON.parse(await readFile(path, 'utf8')) as SecondaryBackupReport;
          if (
            report.installationId === installation(this.db).installation_id &&
            Number.isSafeInteger(report.checkedAt) &&
            report.checkedAt > 0 &&
            (report.lastVerifiedSnapshotAt === null || Number.isSafeInteger(report.lastVerifiedSnapshotAt)) &&
            (report.error === null || typeof report.error === 'string')
          )
            secondary = report;
        }
      } catch {
        /* Secondary reports are observations, never proof of current drive availability. */
      }
    return {
      configured: !!this.options.outputRoot,
      destinationAvailable: !!root,
      checkedAt: this.now(),
      runs,
      externalStatus: secondary ? (secondary.error ? 'failed' : 'verified') : 'not_reported',
      ...(secondary
        ? { secondaryCopy: { checkedAt: secondary.checkedAt, snapshotAt: secondary.lastVerifiedSnapshotAt } }
        : {}),
      running: this.running !== null,
    };
  }
  async prune(): Promise<void> {
    const root = await this.destination();
    const rows = this.db
      .prepare(
        "SELECT run_id,archive_name,snapshot_at,state FROM backup_runs WHERE state IN ('complete','pruned') ORDER BY snapshot_at DESC,rowid DESC",
      )
      .all() as { run_id: string; archive_name: string; snapshot_at: number; state: string }[];
    const keep = new Set<string>();
    const days = new Set<string>();
    const weeks = new Set<number>();
    for (const row of rows.filter((row) => row.state === 'complete')) {
      const day = new Date(row.snapshot_at).toISOString().slice(0, 10);
      if (days.size < 7 && !days.has(day)) {
        keep.add(row.run_id);
        days.add(day);
      }
    }
    const oldestDaily = [...days].sort()[0];
    for (const row of rows.filter((row) => row.state === 'complete')) {
      if (oldestDaily && new Date(row.snapshot_at).toISOString().slice(0, 10) >= oldestDaily) continue;
      const week = Math.floor((row.snapshot_at + 3 * 86400000) / (7 * 86400000));
      if (weeks.size < 4 && !weeks.has(week)) {
        keep.add(row.run_id);
        weeks.add(week);
      }
    }
    for (const row of rows)
      if (!keep.has(row.run_id)) {
        if (!/^[a-f0-9-]{36}$/.test(row.run_id) || row.archive_name !== `backup-${row.run_id}.tar.gz`)
          throw new Error('Unsafe backup filename');
        const markerPath = join(root, `${row.archive_name}.complete.json`);
        try {
          const completion = await readCompletion(markerPath);
          if (
            completion.manifest.runId !== row.run_id ||
            completion.manifest.installationId !== installation(this.db).installation_id
          )
            throw new Error('Backup retention identity mismatch');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        // Persist deletion intent first; rerunning finishes interrupted pruning safely.
        this.db.prepare("UPDATE backup_runs SET state='pruned' WHERE run_id=?").run(row.run_id);
        for (const path of [markerPath, join(root, row.archive_name)])
          try {
            await unlink(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        await syncDirectory(root, !!this.options.development);
      }
  }
}
