import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, openDatabase, requireCurrentSchema } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { upgradeDatabase } from '../src/features/operations/upgrade.js';
import type { Completion } from '../src/features/operations/backup-format.js';

test('pending upgrades refuse startup and cannot change schema before a successful backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'our-place-upgrade-'));
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    await cp(migrationsRoot, root, { recursive: true });
    const last = (
      db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get() as {
        version: string;
      }
    ).version;
    const probe = `${String(Number(last.split('_')[0]) + 1).padStart(3, '0')}_probe.sql`;
    await writeFile(join(root, probe), 'CREATE TABLE upgrade_probe (n INTEGER) STRICT;');
    assert.throws(() => requireCurrentSchema(db, root), /upgrade required/);
    await assert.rejects(
      upgradeDatabase(
        db,
        {
          create: async () => {
            throw new Error('backup unavailable');
          },
        },
        root,
      ),
      /backup unavailable/,
    );
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_probe'").get(), undefined);
    let backedUp = false;
    await upgradeDatabase(
      db,
      {
        create: async () => {
          backedUp = true;
          assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='upgrade_probe'").get(), undefined);
          return { archive: { name: 'verified-test.tar.gz' } } as Completion;
        },
      },
      root,
    );
    assert.equal(backedUp, true);
    requireCurrentSchema(db, root);
    await writeFile(join(root, probe), 'CREATE TABLE changed (n INTEGER) STRICT;');
    assert.throws(() => requireCurrentSchema(db, root), /Changed migration/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
