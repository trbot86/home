import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replicateBackups } from '../apps/server/src/features/operations/backup-replication.js';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = JSON.parse(await readFile(join(workspace, '.local/phone-trial/host.json'), 'utf8'));
const config = JSON.parse(await readFile(join(workspace, '.local/phone-trial/secondary-backup.json'), 'utf8'));
if (resolve(host.workspace) !== workspace || config.installationId !== host.installationId) throw new Error('Backup configuration identity mismatch');
const result = await replicateBackups({ sourceRoot: host.backupRoot, destinationRoot: config.destinationRoot, installationId: host.installationId, initialise: process.argv.includes('--initialise') });
console.log(JSON.stringify(result));
