import { mkdtemp, mkdir, readdir, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CommandKind, Envelope, FinalOutcome } from '@our-place/contracts';
import type { HumanRequestContext } from '../src/features/access/access.js';
import { migrate, openDatabase } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { FileMediaStore } from '../src/features/media/file-media-store.js';

type LegacyCommand = {
  context: HumanRequestContext;
  kind: CommandKind;
  command: Envelope;
  digest: string;
  outcome: FinalOutcome;
};
type Legacy = {
  producerRevision: string;
  contexts: HumanRequestContext[];
  commands: LegacyCommand[];
  pending: Omit<LegacyCommand, 'outcome'>;
  tables: Record<string, Record<string, string | number | null>[]>;
  sequence: number;
  media: { storageKey: string; base64: string; digest: string };
};
export async function integrationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'our-place-integration-'));
  const dataRoot = join(root, 'data'),
    oldMigrations = join(root, 'old-migrations');
  await mkdir(oldMigrations);
  for (const name of await readdir(migrationsRoot))
    if (name.endsWith('.sql') && name < '007_')
      await copyFile(join(migrationsRoot, name), join(oldMigrations, name));
  const db = openDatabase(join(dataRoot, 'db/household.sqlite'));
  migrate(db, oldMigrations);
  const legacy = JSON.parse(
    await readFile(new URL('./fixtures/pre-integration.json', import.meta.url), 'utf8'),
  ) as Legacy;
  for (const [table, rows] of Object.entries(legacy.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      if (![table, ...columns].every((name) => /^[a-z_]+$/.test(name)))
        throw new Error('Invalid fixture identifier');
      db.prepare(
        `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    }
  }
  db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='change_sets'").run(legacy.sequence);
  const selects = Object.keys(legacy.tables).map((table) => {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    return `SELECT rowid,${columns.map((column) => column.name).join(',')} FROM ${table} ORDER BY rowid`;
  });
  const files = new FileMediaStore(join(dataRoot, 'media'), true);
  await files.initialise();
  await files.publish(legacy.media.storageKey, Buffer.from(legacy.media.base64, 'base64'));
  let time = 1000;
  return {
    root,
    dataRoot,
    oldMigrations,
    db,
    legacy,
    files,
    now: () => time,
    setTime: (next: number) => {
      time = next;
    },
    snapshot: () => selects.map((sql) => db.prepare(sql).all()),
    close: async () => {
      if (db.open) db.close();
      if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
      await rm(root, { recursive: true, force: true });
    },
  };
}
