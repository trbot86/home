import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, openDatabase, requireCurrentSchema } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { upgradeDatabase } from '../src/features/operations/upgrade.js';
import type { Completion } from '../src/features/operations/backup-format.js';

test('attachment upgrade preserves existing placements and media while freeing only removed positions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'our-place-attachment-upgrade-'));
  const db = openDatabase(':memory:');
  try {
    for (const name of await readdir(migrationsRoot))
      if (name.endsWith('.sql') && name < '006_') await cp(join(migrationsRoot, name), join(root, name));
    migrate(db, root);
    db.exec(`
      INSERT INTO people(person_id,username,display_name,password_verifier) VALUES ('person-fixture','fixture','Fixture','test-only');
      INSERT INTO clients(client_id,person_id,kind) VALUES ('client-fixture','person-fixture','browser');
      INSERT INTO visibility_scopes VALUES ('scope-fixture','shared',NULL);
      INSERT INTO records VALUES ('record-fixture','inbox','scope-fixture',7,100,200,NULL);
      INSERT INTO inbox_entries(inbox_id,text,captured_at,source_json) VALUES ('record-fixture','Keep this note',100,'{"kind":"typed"}');
      INSERT INTO media_objects VALUES ('media-fixture','scope-fixture','client-fixture','digest-fixture',100,'image/png','synthetic/file','generation-fixture','ready',100,NULL,200);
      INSERT INTO attachments VALUES ('photo-live','record-fixture','media-fixture','Original caption',0,NULL);
      INSERT INTO attachments VALUES ('photo-removed','record-fixture','media-fixture','Earlier caption',1,150);
      INSERT INTO change_sets(change_set_id,client_id,actor_person_id,operation_kind,recorded_at) VALUES ('change-fixture','client-fixture','person-fixture','CreateInboxEntry',100);
      INSERT INTO record_changes VALUES ('change-fixture','record-fixture',6,7,'scope-fixture','scope-fixture',1,'{"kept":"exactly"}');
      INSERT INTO operation_receipts VALUES ('client-fixture','operation-fixture','digest-fixture','person-fixture','{"kept":"exactly"}',100);
    `);
    const tables = [
      'records',
      'inbox_entries',
      'media_objects',
      'attachments',
      'change_sets',
      'record_changes',
      'operation_receipts',
    ];
    const selects = tables.map((table) => {
      const columns = db.pragma(`table_info(${table})`) as { name: string }[];
      return `SELECT ${columns.map((column) => column.name).join(',')} FROM ${table} ORDER BY rowid`;
    });
    const before = selects.map((sql) => db.prepare(sql).all());
    migrate(db);
    assert.deepEqual(
      selects.map((sql) => db.prepare(sql).all()),
      before,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,NULL)').run(
      'photo-new',
      'record-fixture',
      'media-fixture',
      'Replacement',
      1,
    );
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO attachments VALUES (?,?,?,?,?,NULL)')
          .run('photo-clash', 'record-fixture', 'media-fixture', '', 0),
      /UNIQUE/,
    );
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n, 3);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
