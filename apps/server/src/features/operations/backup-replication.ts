import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { durableWrite, flushFile, readCompletion, serialise, verifyArchive } from './backup-format.js';

export type SecondaryBackupReport = {
  installationId: string;
  checkedAt: number;
  lastVerifiedRunId: string | null;
  lastVerifiedSnapshotAt: number | null;
  error: string | null;
};
export const secondaryReportName = 'secondary-copy-status.json';
const markerName = '.our-place-secondary-backups.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function publishReport(root: string, report: SecondaryBackupReport) {
  const temp = join(root, `${secondaryReportName}.${randomUUID()}.partial`);
  try {
    await durableWrite(temp, serialise(report));
    await rename(temp, join(root, secondaryReportName));
  } finally {
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}
/** Host-side copying only. Never mounts, opens for writing, or replaces the live database. */
export async function replicateBackups(options: {
  sourceRoot: string;
  destinationRoot: string;
  installationId: string;
  initialise?: boolean;
}): Promise<SecondaryBackupReport> {
  const source = resolve(options.sourceRoot),
    destination = resolve(options.destinationRoot);
  const inside = (parent: string, child: string) => {
    const value = relative(parent, child);
    return !value || (!value.startsWith('..') && !isAbsolute(value));
  };
  if (inside(source, destination) || inside(destination, source))
    throw new Error('Backup folders must be separate');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('Unsafe primary backup folder');
  const primary = JSON.parse(await readFile(join(source, '.our-place-backups.json'), 'utf8'));
  if (primary.installationId !== options.installationId) throw new Error('Primary backup identity mismatch');
  let report: SecondaryBackupReport = {
    installationId: options.installationId,
    checkedAt: Date.now(),
    lastVerifiedRunId: null,
    lastVerifiedSnapshotAt: null,
    error: null,
  };
  try {
    if (options.initialise) {
      await mkdir(destination, { recursive: true });
      const targetInfo = await lstat(destination);
      if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
        throw new Error('Unsafe secondary backup folder');
      if ((await readdir(destination)).length === 0)
        await durableWrite(
          join(destination, markerName),
          serialise({ format: 1, installationId: options.installationId }),
        );
    }
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe secondary backup folder');
    const marker = JSON.parse(await readFile(join(destination, markerName), 'utf8'));
    if (marker.format !== 1 || marker.installationId !== options.installationId)
      throw new Error('Secondary backup identity mismatch');
    for (const name of await readdir(source)) {
      if (!/^backup-[a-f0-9-]{36}\.tar\.gz\.complete\.json$/.test(name)) continue;
      const completion = await readCompletion(join(source, name));
      if (completion.manifest.installationId !== options.installationId)
        throw new Error('Export identity mismatch');
      const targetArchive = join(destination, completion.archive.name);
      if (!(await exists(targetArchive))) {
        const temp = `${targetArchive}.${randomUUID()}.partial`;
        try {
          await copyFile(join(source, completion.archive.name), temp, constants.COPYFILE_EXCL);
          await verifyArchive(temp, completion);
          await flushFile(temp);
          await rename(temp, targetArchive);
        } finally {
          await unlink(temp).catch((error) => {
            if (!missing(error)) throw error;
          });
        }
      }
      await verifyArchive(targetArchive, completion);
      const targetMarker = join(destination, name);
      if (await exists(targetMarker)) {
        if (serialise(await readCompletion(targetMarker)) !== serialise(completion))
          throw new Error('Secondary completion manifest differs');
      } else {
        const temp = `${targetMarker}.${randomUUID()}.partial`;
        try {
          await durableWrite(temp, serialise(completion));
          await rename(temp, targetMarker);
        } finally {
          await unlink(temp).catch((error) => {
            if (!missing(error)) throw error;
          });
        }
      }
      if (completion.manifest.snapshotAt > (report.lastVerifiedSnapshotAt ?? -1)) {
        report.lastVerifiedSnapshotAt = completion.manifest.snapshotAt;
        report.lastVerifiedRunId = completion.manifest.runId;
      }
    }
    if (!report.lastVerifiedRunId) throw new Error('No completed backups available to copy');
    report.checkedAt = Date.now();
    await publishReport(source, report);
    return report;
  } catch (error) {
    report = { ...report, checkedAt: Date.now(), error: 'Secondary backup copy needs attention' };
    await publishReport(source, report);
    throw error;
  }
}
