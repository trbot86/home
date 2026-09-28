import { existsSync } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { installation, openDatabase, requireCurrentSchema } from '../../infrastructure/database.js';
import { AccessService, type HumanRequestContext } from './access.js';
import { IntegrationAccessService } from './integrations.js';

export type CaptureProvisioning = {
  dataRoot: string;
  outputFile: string;
  expectedInstallationId: string;
  expectedServerEpoch: string;
  username: string;
  password: string;
  displayName: string;
  expiresAt: number;
};

/** Local administrative operation. Never invoked by a listener or during startup. */
export async function provisionCaptureCredential(options: CaptureProvisioning, now = Date.now) {
  const filename = join(options.dataRoot, 'db/household.sqlite');
  if (!isAbsolute(options.dataRoot) || !isAbsolute(options.outputFile) || !existsSync(filename))
    throw new Error('An existing household and absolute output path are required');
  const parent = await lstat(dirname(options.outputFile));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Invalid output directory');
  const db = openDatabase(filename);
  let administrator: HumanRequestContext | undefined;
  let clientId: string | undefined;
  let output: Awaited<ReturnType<typeof open>> | undefined;
  let completed = false;
  const access = new AccessService(db, now);
  const integrations = new IntegrationAccessService(db, now);
  try {
    requireCurrentSchema(db);
    const state = installation(db);
    if (
      state.installation_id !== options.expectedInstallationId ||
      state.recovery_epoch !== options.expectedServerEpoch ||
      state.recovery_mode !== 'normal'
    )
      throw new Error('Household identity, epoch or recovery state does not match');
    if (
      !options.displayName.trim() ||
      options.displayName.length > 80 ||
      !Number.isSafeInteger(options.expiresAt) ||
      options.expiresAt <= now()
    )
      throw new Error('Invalid integration label or expiry');
    // Refuse accidental repeated provisioning; inspect/revoke an existing actor explicitly.
    if (
      db
        .prepare('SELECT 1 FROM integration_actors WHERE display_name=? AND active=1')
        .get(options.displayName)
    )
      throw new Error('An integration with this label already exists');
    output = await open(options.outputFile, 'wx', 0o600);
    const login = await access.login(options.username, options.password, 'browser');
    administrator = access.authenticate(login.secret);
    access.requireAdministrator(administrator);
    const issued = integrations.provision(administrator, options.displayName, options.expiresAt);
    clientId = issued.clientId;
    await output.writeFile(
      JSON.stringify({
        installationId: state.installation_id,
        expectedServerEpoch: state.recovery_epoch,
        displayName: options.displayName,
        expiresAt: options.expiresAt,
        ...issued,
      }) + '\n',
    );
    await output.sync();
    completed = true;
    return { integrationId: issued.integrationId, clientId, expiresAt: options.expiresAt };
  } finally {
    try {
      if (administrator) {
        try {
          if (clientId && !completed) integrations.revoke(administrator, clientId);
        } finally {
          access.logout(administrator);
        }
      }
    } finally {
      try {
        if (output) {
          const original = await output.stat();
          await output.close();
          if (!completed) {
            const current = await lstat(options.outputFile).catch(() => undefined);
            if (current?.isFile() && current.dev === original.dev && current.ino === original.ino)
              await unlink(options.outputFile);
          }
        }
      } finally {
        db.close();
      }
    }
  }
}
