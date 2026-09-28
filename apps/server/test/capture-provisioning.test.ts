import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, openDatabase, installation } from '../src/infrastructure/database.js';
import { provisionHousehold } from '../src/features/access/access.js';
import { IntegrationAccessService } from '../src/features/access/integrations.js';
import { provisionCaptureCredential } from '../src/features/access/provision-capture.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'capture-provisioning-'));
  const dataRoot = join(root, 'data');
  const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
  migrate(db);
  await provisionHousehold(db, [
    { username: 'admin', displayName: 'Administrator', password: 'synthetic-admin-password' },
    { username: 'member', displayName: 'Member', password: 'synthetic-member-password' },
  ]);
  const state = installation(db);
  const options = {
    dataRoot,
    outputFile: join(root, 'capture.json'),
    expectedInstallationId: state.installation_id,
    expectedServerEpoch: state.recovery_epoch,
    username: 'admin',
    password: 'synthetic-admin-password',
    displayName: 'Alexa',
    expiresAt: 200000,
  };
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    root,
    db,
    options,
    count,
    now: () => 100000,
    close: async () => {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('local provisioning produces only an integration credential and revokes the temporary login', async () => {
  const f = await fixture();
  try {
    const before = installation(f.db);
    const result = await provisionCaptureCredential(f.options, f.now);
    const issued = JSON.parse(await readFile(f.options.outputFile, 'utf8'));
    assert.equal(issued.clientId, result.clientId);
    assert.equal(issued.installationId, f.options.expectedInstallationId);
    assert.equal(issued.expectedServerEpoch, f.options.expectedServerEpoch);
    assert.equal(issued.expiresAt, f.options.expiresAt);
    assert.match(issued.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new IntegrationAccessService(f.db, f.now).authenticate(issued.secret).kind, 'integration');
    assert.equal(f.count('integration_actors'), 1);
    assert.equal(f.count('inbox_entries'), 0);
    assert.equal(f.count('change_sets'), 0);
    assert.deepEqual(installation(f.db), before);
    assert.equal(
      (
        f.db
          .prepare(
            `SELECT COUNT(*) AS n FROM client_credentials cc JOIN clients c USING(client_id)
      WHERE c.kind='browser' AND cc.revoked_at IS NULL`,
          )
          .get() as { n: number }
      ).n,
      0,
    );
    if (process.platform !== 'win32') assert.equal((await stat(f.options.outputFile)).mode & 0o777, 0o600);
  } finally {
    await f.close();
  }
});

test('wrong installation, epoch, recovery mode and schema cannot provision an integration', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      provisionCaptureCredential({ ...f.options, expectedInstallationId: 'other' }, f.now),
    );
    await assert.rejects(provisionCaptureCredential({ ...f.options, expectedServerEpoch: 'other' }, f.now));
    f.db.prepare("UPDATE installation_state SET recovery_mode='reconciling'").run();
    await assert.rejects(provisionCaptureCredential(f.options, f.now));
    f.db.prepare("UPDATE installation_state SET recovery_mode='normal'").run();
    f.db
      .prepare(
        "UPDATE schema_migrations SET checksum='changed' WHERE version=(SELECT MAX(version) FROM schema_migrations)",
      )
      .run();
    await assert.rejects(provisionCaptureCredential(f.options, f.now));
    assert.equal(f.count('integration_actors'), 0);
    assert.equal(f.count('clients'), 0);
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('incorrect credentials and non-administrators cannot provision, and output stays absent', async () => {
  const f = await fixture();
  try {
    await assert.rejects(provisionCaptureCredential({ ...f.options, password: 'incorrect-password' }, f.now));
    await assert.rejects(
      provisionCaptureCredential(
        { ...f.options, username: 'member', password: 'synthetic-member-password' },
        f.now,
      ),
    );
    assert.equal(f.count('integration_actors'), 0);
    assert.equal(
      (
        f.db.prepare('SELECT COUNT(*) AS n FROM client_credentials WHERE revoked_at IS NULL').get() as {
          n: number;
        }
      ).n,
      0,
    );
    await assert.rejects(stat(f.options.outputFile), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('existing output and repeated labels cannot overwrite or duplicate a provisioned credential', async () => {
  const f = await fixture();
  try {
    await writeFile(f.options.outputFile, 'preserve existing content');
    await assert.rejects(provisionCaptureCredential(f.options, f.now), { code: 'EEXIST' });
    assert.equal(await readFile(f.options.outputFile, 'utf8'), 'preserve existing content');
    assert.equal(f.count('clients'), 0);
    const next = { ...f.options, outputFile: join(f.root, 'new-capture.json') };
    await provisionCaptureCredential(next, f.now);
    await assert.rejects(
      provisionCaptureCredential({ ...next, outputFile: join(f.root, 'duplicate.json') }, f.now),
    );
    assert.equal(f.count('integration_actors'), 1);
  } finally {
    await f.close();
  }
});
