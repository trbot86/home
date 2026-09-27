import { join, resolve } from 'node:path';
import { openDatabase, installation } from './infrastructure/database.js';
import { BackupCoordinator, initialiseBackupDestination } from './features/operations/backups.js';
import { restoreBackup } from './features/operations/restore.js';
import { FileMediaStore } from './features/media/file-media-store.js';
import { MediaRetentionGate } from './features/media/retention-gate.js';
import { upgradeDatabase } from './features/operations/upgrade.js';

const [operation, ...args] = process.argv.slice(2).filter((arg) => arg !== '--development');
const development = process.argv.includes('--development');
if (operation === 'init-backups' && args[0] && process.env['DATA_ROOT']) {
  const db = openDatabase(join(resolve(process.env['DATA_ROOT']), 'db/household.sqlite'));
  try {
    await initialiseBackupDestination(resolve(args[0]), installation(db).installation_id, development);
  } finally {
    db.close();
  }
  process.stdout.write('Initialised dedicated backup output directory.\n');
} else if (operation === 'upgrade' && process.env['DATA_ROOT'] && process.env['BACKUP_ROOT']) {
  const dataRoot = resolve(process.env['DATA_ROOT']);
  const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
  try {
    installation(db);
    const files = new FileMediaStore(join(dataRoot, 'media'), development);
    await files.initialise();
    const backups = new BackupCoordinator(db, files, new MediaRetentionGate(), {
      dataRoot,
      outputRoot: resolve(process.env['BACKUP_ROOT']),
      development,
    });
    await backups.initialise();
    const result = await upgradeDatabase(db, backups);
    process.stdout.write(
      result
        ? `Applied ${result.migrations.length} migration(s); verified pre-upgrade backup: ${result.archive}\n`
        : 'Schema is current. No migration needed.\n',
    );
  } finally {
    db.close();
  }
} else if (operation === 'restore' && args.length === 2 && args[0] && args[1]) {
  const result = await restoreBackup(resolve(args[0]), resolve(args[1]), development);
  process.stdout.write(`Restored verified backup with a new recovery epoch: ${JSON.stringify(result)}\n`);
} else {
  throw new Error(
    'Usage: with DATA_ROOT set, init-backups <empty-directory>; with DATA_ROOT and BACKUP_ROOT set, upgrade; or restore <complete.json> <new-data-directory>. Stop the app before upgrade or restore. Windows development only: --development.',
  );
}
