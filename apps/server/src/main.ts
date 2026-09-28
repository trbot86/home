import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { OperationsWorker } from './features/operations/worker.js';
import { RecipeImportWorker } from './features/recipes/import-worker.js';
import { installation } from './infrastructure/database.js';
import { loadCalendarConfiguration } from './features/calendars/configuration.js';
import { loadFilingProvider } from './infrastructure/filing-codex-provider.js';

const development = process.argv.includes('--development');
const publicOrigin = process.env['PUBLIC_ORIGIN'] ?? (development ? 'http://127.0.0.1:5173' : '');
if (!publicOrigin) throw new Error('Set PUBLIC_ORIGIN to the private HTTPS address');
const expectedInstallation = process.env['EXPECTED_INSTALLATION_ID'];
if (!development && !expectedInstallation)
  throw new Error('Set EXPECTED_INSTALLATION_ID from the explicit household bootstrap');
const dataRoot = resolve(process.env['DATA_ROOT'] ?? '../../.local/data');
const backupRoot = process.env['BACKUP_ROOT'];
const clientDownloadRoot = process.env['CLIENT_DOWNLOAD_ROOT'];
const authenticationMode = process.env['AUTHENTICATION_MODE'] ?? 'password';
const calendars = await loadCalendarConfiguration(process.env['CALENDAR_CONFIG_FILE'], publicOrigin);
const filingAdviceProvider = await loadFilingProvider(process.env['FILING_WORKER_CONFIG_FILE']);
if (authenticationMode !== 'password' && authenticationMode !== 'trusted-network')
  throw new Error('AUTHENTICATION_MODE must be password or trusted-network');
const { app, db, media, backups, recipeImports } = await buildApp({
  dataRoot,
  publicOrigin,
  development,
  logger: true,
  authenticationMode,
  ...(calendars ? { calendars } : {}),
  ...(filingAdviceProvider ? { filingAdviceProvider } : {}),
  ...(backupRoot ? { backupRoot: resolve(backupRoot) } : {}),
  ...(clientDownloadRoot ? { clientDownloadRoot: resolve(clientDownloadRoot) } : {}),
});
if (expectedInstallation && installation(db).installation_id !== expectedInstallation) {
  await app.close();
  throw new Error('Wrong household data volume: installation identity does not match');
}
const worker = new OperationsWorker(db, media, backups, {
  backupsEnabled: !!backupRoot,
  backupHour: Number(process.env['BACKUP_HOUR'] ?? 6),
  report: (error) => app.log.error({ err: error }, 'Household maintenance failed'),
});
await app.listen({ host: process.env['HOST'] ?? '127.0.0.1', port: Number(process.env['PORT'] ?? 3000) });
worker.start();
const recipeWorker = new RecipeImportWorker(recipeImports, media, {
  report: () => app.log.error('Recipe import interrupted; saved work will be retried'),
});
recipeWorker.start();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void Promise.allSettled([worker.stop(), recipeWorker.stop()]).then(() => app.close());
  });
