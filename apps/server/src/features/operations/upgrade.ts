import { migrate, pendingMigrations, type Sqlite } from '../../infrastructure/database.js';
import type { BackupCoordinator } from './backups.js';

/** Administrative offline operation: callers must stop the household process first. */
export async function upgradeDatabase(
  db: Sqlite,
  backups: Pick<BackupCoordinator, 'create'>,
  migrationsPath?: string,
) {
  const pending = pendingMigrations(db, migrationsPath);
  if (!pending.length) return null;
  const backup = await backups.create(); // No schema write before a fully verified export.
  migrate(db, migrationsPath);
  return { migrations: pending, archive: backup.archive.name };
}
