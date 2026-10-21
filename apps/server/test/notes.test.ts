import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { copyFile, readFile, readdir, writeFile } from 'node:fs/promises';
import type { CommandKind } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { installation, migrate } from '../src/infrastructure/database.js';
import { migrationsRoot } from '../src/paths.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { isSecure } from '../src/application/record-security.js';
import { RecordSharing } from '../src/application/record-sharing.js';

test('037 adds only the note kind and payload, preserves existing rows, and rolls back atomically', async () => {
  const f = await integrationFixture();
  try {
    for (const name of (await readdir(migrationsRoot)).filter((n) => n.endsWith('.sql') && n < '037_'))
      await copyFile(join(migrationsRoot, name), join(f.oldMigrations, name));
    migrate(f.db, f.oldMigrations);
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name <> 'schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const snapshot = () =>
      tables.map((name) =>
        f.db
          .prepare(
            `SELECT * FROM ${name} ${name === 'record_kinds' ? "WHERE kind <> 'note'" : ''} ORDER BY rowid`,
          )
          .all(),
      );
    const before = snapshot(),
      identity = installation(f.db),
      schemas = f.db.prepare('SELECT * FROM schema_migrations').all();
    const file = '037_notes.sql',
      sql = await readFile(join(migrationsRoot, file), 'utf8');
    await writeFile(join(f.oldMigrations, file), sql + '\nSELECT missing_notes_migration();');
    assert.throws(() => migrate(f.db, f.oldMigrations), /function/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations').all(), schemas);
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='notes'").get(), undefined);
    migrate(f.db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(installation(f.db), identity);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM record_kinds WHERE kind='note'").pluck().get(), 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM notes').pluck().get(), 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    await f.close();
  }
});

async function fixture() {
  const f = await integrationFixture();
  const backupRoot = join(f.root, 'backups');
  await initialiseBackupDestination(backupRoot, installation(f.db).installation_id, true);
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    backupRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const a = service.access.authenticate('a'.repeat(43)),
    b = service.access.authenticate('b'.repeat(43));
  const privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId,
    shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId;
  const features = createRecordFeatures(f.db, service.access);
  const run = (kind: CommandKind, args: unknown, context = a) =>
    service.writes.execute(context, kind, {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      arguments: args,
    });
  return {
    ...f,
    service,
    a,
    b,
    shared,
    privateScope,
    features,
    run,
    backupRoot,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}

test('notes support private/shared access, revision guards, per-user history, deletion and restore', async () => {
  const f = await fixture();
  try {
    const id = randomUUID();
    assert.equal(
      f.run('CreateNote', {
        recordId: id,
        scopeId: f.privateScope,
        title: 'Saved thought',
        body: 'Long lived text',
        category: 'Ideas',
      }).status,
      'Applied',
    );
    assert.equal(f.features.notes.snapshot(f.a).length, 1);
    assert.equal(f.features.notes.snapshot(f.b).length, 0);
    assert.throws(() => f.features.notes.get(f.b, id));
    assert.equal(
      f.run('UpdateNote', {
        recordId: id,
        expectedRevision: 1,
        title: 'Revised',
        body: 'Kept detail',
        category: 'Reference',
      }).status,
      'Applied',
    );
    assert.equal(
      f.run('UpdateNote', { recordId: id, expectedRevision: 1, title: 'Stale', body: 'Lost?', category: '' })
        .status,
      'Rejected',
    );
    assert.equal(f.service.history.list(f.a, id, 'note').length, 2);
    const deleted = f.run('DeleteNote', { recordId: id, expectedRevision: 2 });
    assert.equal(deleted.status, 'Applied');
    if (deleted.status === 'Applied')
      assert.equal(f.run('UndoChangeSet', { changeSetId: deleted.changeSetId }).status, 'Applied');
    assert.equal(f.features.notes.get(f.a, id).content.deletedAt, null);
    const sharedId = randomUUID();
    const created = f.run('CreateNote', {
      recordId: sharedId,
      scopeId: f.shared,
      title: 'Shared thought',
      body: 'Initial',
      category: '',
    });
    assert.equal(created.status, 'Applied');
    assert.equal(
      f.run(
        'UpdateNote',
        {
          recordId: sharedId,
          expectedRevision: 1,
          title: 'Shared thought',
          body: 'Partner edit',
          category: 'Ideas',
        },
        f.b,
      ).status,
      'Applied',
    );
    if (created.status === 'Applied')
      assert.equal(f.run('UndoChangeSet', { changeSetId: created.changeSetId }).status, 'Rejected');
    assert.equal(f.features.notes.get(f.a, sharedId).content.body, 'Partner edit');
    const sharing = new RecordSharing(f.db, f.service.access, f.features.records);
    const preview = sharing.preview(f.a, id);
    assert.deepEqual(
      preview.records.map((r) => r.recordId),
      [id],
    );
    assert.equal(f.run('ShareRecords', { recordId: id, token: preview.token }).status, 'Applied');
    assert.equal(f.features.notes.get(f.b, id).content.body, 'Kept detail');
    assert.equal(f.features.notes.get(f.b, id).content.scopeId, f.shared);
  } finally {
    await f.close();
  }
});

test('filing keeps capture identity and photos, inherits Secure, supports undo, and survives backup restore', async () => {
  const f = await fixture();
  try {
    const source = f.service.inbox.snapshot(f.a, f.now()).entries.find((e) => e.attachments.length > 0)!;
    assert.ok(source);
    const noteId = randomUUID();
    const args = {
      inboxId: source.inboxId,
      expectedRevision: source.revision,
      destination: {
        kind: 'CreateNote',
        arguments: {
          recordId: noteId,
          scopeId: source.scopeId,
          title: 'Photo thought',
          body: source.text,
          category: 'Reference',
          attachments: source.attachments.map((a) => ({ ...a, attachmentId: randomUUID() })),
        },
      },
    };
    const command = {
      operationId: randomUUID(),
      contractVersion: 1 as const,
      expectedServerEpoch: installation(f.db).recovery_epoch,
      arguments: args,
    };
    const result = f.service.writes.execute(f.a, 'FileInboxEntry', command);
    assert.equal(result.status, 'Applied');
    assert.equal(f.service.writes.execute(f.a, 'FileInboxEntry', command).status, 'Applied');
    const note = f.features.notes.project(f.features.notes.get(f.a, noteId));
    assert.equal(note.attachments[0]!.mediaId, source.attachments[0]!.mediaId);
    assert.equal(f.service.inbox.get(f.a, source.inboxId).text, source.text);
    assert.ok(f.service.inbox.get(f.a, source.inboxId).filedAt !== null);
    const originalBytes = (await f.service.media.read(f.a, note.attachments[0]!.mediaId)).bytes;
    const backup = await f.service.backups.create();
    const restoredRoot = join(f.root, 'restored-notes');
    await restoreBackup(join(f.backupRoot, `${backup.archive.name}.complete.json`), restoredRoot, true);
    const restored = await buildApp({
      dataRoot: restoredRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
    try {
      const restoredNotes = createRecordFeatures(restored.db, restored.access).notes;
      assert.deepEqual(restoredNotes.project(restoredNotes.get(f.a, noteId)), note);
      assert.deepEqual((await restored.media.read(f.a, note.attachments[0]!.mediaId)).bytes, originalBytes);
      assert.deepEqual(
        restored.history.list(f.a, noteId, 'note'),
        f.service.history.list(f.a, noteId, 'note'),
      );
    } finally {
      await restored.app.close();
    }
    if (result.status === 'Applied')
      assert.equal(f.run('UndoChangeSet', { changeSetId: result.changeSetId }).status, 'Applied');
    assert.equal(f.service.inbox.get(f.a, source.inboxId).filedAt, null);
    assert.notEqual(f.features.notes.get(f.a, noteId).content.deletedAt, null);
    const secureInboxId = randomUUID(),
      secureNoteId = randomUUID();
    assert.equal(
      f.run('CreateInboxEntry', {
        inboxId: secureInboxId,
        scopeId: f.privateScope,
        text: 'Private synthetic thought',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [],
        secure: true,
      }).status,
      'Applied',
    );
    assert.equal(
      f.run('FileInboxEntry', {
        inboxId: secureInboxId,
        expectedRevision: 1,
        destination: {
          kind: 'CreateNote',
          arguments: {
            recordId: secureNoteId,
            scopeId: f.privateScope,
            title: 'Protected thought',
            body: 'Private synthetic thought',
            category: '',
          },
        },
      }).status,
      'Applied',
    );
    assert.equal(isSecure(f.db, secureNoteId), true);
    assert.equal(
      f.features.notes.snapshot(f.b).some((n) => n.recordId === secureNoteId),
      false,
    );
  } finally {
    await f.close();
  }
});
