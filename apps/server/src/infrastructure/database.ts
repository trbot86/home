import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { migrationsRoot } from '../paths.js';

export type Sqlite = Database.Database;
export type Installation = {
  installation_id: string;
  recovery_epoch: string;
  restored_from_at: number | null;
  recovery_mode: string;
};
export function openDatabase(filename: string): Sqlite {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('busy_timeout = 3000');
  return db;
}
export function immediate<T>(db: Sqlite, body: () => T): T {
  if (db.inTransaction) throw new Error('Nested transaction ownership');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    if (result instanceof Promise) throw new Error('Transaction body must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
export function pendingMigrations(db: Sqlite, migrationsPath = migrationsRoot): string[] {
  const files = readdirSync(migrationsPath)
    .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
    .sort();
  const applied = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get()
    ? (db.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as {
        version: string;
        checksum: string;
      }[])
    : [];
  for (const row of applied)
    if (!files.includes(row.version)) throw new Error(`Unknown applied migration: ${row.version}`);
  for (const [index, row] of applied.entries()) {
    if (files[index] !== row.version) throw new Error('Applied migrations are not a contiguous prefix');
    const checksum = createHash('sha256')
      .update(readFileSync(join(migrationsPath, row.version)))
      .digest('hex');
    if (row.checksum !== checksum) throw new Error(`Changed migration: ${row.version}`);
  }
  return files.slice(applied.length);
}
export function requireCurrentSchema(db: Sqlite, migrationsPath = migrationsRoot): void {
  const pending = pendingMigrations(db, migrationsPath);
  if (pending.length)
    throw new Error(
      `Database upgrade required (${pending.join(', ')}). Stop the app and run the upgrade command, which verifies a backup before migration.`,
    );
}
export function migrate(db: Sqlite, migrationsPath = migrationsRoot): void {
  const files = pendingMigrations(db, migrationsPath);
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL) STRICT',
  );
  for (const file of files) {
    const sql = readFileSync(join(migrationsPath, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    immediate(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(file, checksum);
    });
  }
}
export function installation(db: Sqlite): Installation {
  const row = db.prepare('SELECT * FROM installation_state WHERE singleton=1').get() as
    Installation | undefined;
  if (!row) throw new Error('Installation not bootstrapped. Refusing to create a new household at startup.');
  return row;
}
export function initialiseInstallation(db: Sqlite): void {
  if (db.prepare('SELECT 1 FROM installation_state').get()) throw new Error('Installation already exists');
  db.prepare('INSERT INTO installation_state(singleton,installation_id,recovery_epoch) VALUES (1,?,?)').run(
    randomUUID(),
    randomUUID(),
  );
  db.prepare("INSERT INTO visibility_scopes VALUES (?, 'shared', NULL)").run(randomUUID());
}
