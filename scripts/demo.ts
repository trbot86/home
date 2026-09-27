import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase, migrate, installation } from '../apps/server/src/infrastructure/database.js';
import { provisionHousehold } from '../apps/server/src/features/access/access.js';
import { initialiseBackupDestination } from '../apps/server/src/features/operations/backups.js';
import { buildApp } from '../apps/server/src/app.js';

const dataRoot = resolve('.local/demo/data'); const backupRoot = resolve('.local/demo/backups');
const filename = join(dataRoot, 'db/household.sqlite'); const fresh = !existsSync(filename);
if (fresh) {
  const db = openDatabase(filename); migrate(db);
  await provisionHousehold(db, [{ username: 'alex', displayName: 't', password: 'local-demo-alex-2026' }, { username: 'sam', displayName: 'b', password: 'local-demo-sam-2026' }]);
  await initialiseBackupDestination(backupRoot, installation(db).installation_id, true); db.close();
}
const { app, access, writes } = await buildApp({ dataRoot, backupRoot, publicOrigin: 'http://127.0.0.1:3173', development: true, logger: true, authenticationMode: 'trusted-network' });
if (fresh) {
  const { session, secret } = await access.login('alex', 'local-demo-alex-2026', 'browser'); const context = access.authenticate(secret);
  const shared = session.scopes.find(scope => scope.kind === 'shared')!.scopeId; const personal = session.scopes.find(scope => scope.kind === 'private')!.scopeId;
  for (const [text, scopeId] of [
    ['Electric toothbrush heads\nCheck which model we have before ordering.', shared],
    ['Something delicious for Sunday\nSave that roasted tomato pasta recipe to try together.', shared],
    ['Kitchen ideas\nA little herb shelf by the window? Measure the space and take a photo.', shared],
    ['Gift idea for Sam\nA pottery class for two. Keep this one a surprise.', personal]
  ]) writes.execute(context, 'CreateInboxEntry', { operationId: randomUUID(), contractVersion: 1, expectedServerEpoch: session.serverEpoch,
    arguments: { inboxId: randomUUID(), scopeId, text, capturedAt: Date.now(), source: { kind: 'typed' }, attachments: [] } });
  access.logout(context);
}
await app.listen({ host: '127.0.0.1', port: 3173 });
process.stdout.write('Local synthetic demo: http://127.0.0.1:3173\nChoose profile t or b. These are demonstration profiles.\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
