import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, migrate, installation } from '../src/infrastructure/database.js';
import { provisionHousehold } from '../src/features/access/access.js';
import { buildApp } from '../src/app.js';
import { BackupCoordinator, initialiseBackupDestination } from '../src/features/operations/backups.js';
import { restoreBackup } from '../src/features/operations/restore.js';
import { readCompletion, serialise, verifyArchive } from '../src/features/operations/backup-format.js';
import { sha256 } from '../src/features/media/file-media-store.js';
import { replicateBackups } from '../src/features/operations/backup-replication.js';
import type { Envelope } from '@our-place/contracts';
import { OperationsWorker } from '../src/features/operations/worker.js';
import { HomeRepository } from '../src/features/home/home.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=', 'base64');
const origin = 'http://127.0.0.1:5173';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'our-place-backup-')); const dataRoot = join(root, 'data'); const outputRoot = join(root, 'exports');
  const db = openDatabase(join(dataRoot, 'db/household.sqlite')); migrate(db);
  await provisionHousehold(db, [{ username: 'alex', displayName: 'Alex', password: 'test-alex-password' }, { username: 'sam', displayName: 'Sam', password: 'test-sam-password' }]);
  await initialiseBackupDestination(outputRoot, installation(db).installation_id, true); db.close();
  let time = Date.now(); const service = await buildApp({ dataRoot, backupRoot: outputRoot, development: true, publicOrigin: origin, now: () => time });
  const { secret, session } = await service.access.login('alex', 'test-alex-password', 'browser'); const context = service.access.authenticate(secret);
  const scopeId = session.scopes.find(scope => scope.kind === 'shared')!.scopeId;
  const command = (args: unknown): Envelope => ({ operationId: randomUUID(), contractVersion: 1, expectedServerEpoch: session.serverEpoch, arguments: args });
  const capture = (text: string) => command({ inboxId: randomUUID(), scopeId, text, source: { kind: 'typed' }, capturedAt: time, attachments: [] });
  const mediaId = randomUUID();
  service.media.prepare(context, mediaId, { scopeId, expectedServerEpoch: session.serverEpoch, digest: sha256(png), byteLength: png.length, mimeType: 'image/png' });
  await service.media.transfer(context, mediaId, session.serverEpoch, png);
  const inboxId = randomUUID(); const original = command({ inboxId, scopeId, text: 'Filter model and its receipt', source: { kind: 'photo' }, capturedAt: time, attachments: [{ attachmentId: randomUUID(), mediaId, digest: sha256(png), byteLength: png.length, mimeType: 'image/png', position: 0 }] });
  assert.equal(service.writes.execute(context, 'CreateInboxEntry', original).status, 'Applied');
  return { ...service, root, dataRoot, outputRoot, command, capture, original, inboxId, mediaId, session, context, advance: (ms: number) => { time += ms; }, now: () => time,
    close: async () => { await service.app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('secondary copies verify bytes, survive primary retention and expose copy failures', async () => {
  const f = await fixture(); try {
    const destinationRoot = join(f.root, 'secondary');
    const options = { sourceRoot: f.outputRoot, destinationRoot, installationId: f.session.installationId };
    const first = await f.backups.create();
    const copied = await replicateBackups({ ...options, initialise: true });
    assert.equal(copied.lastVerifiedRunId, first.manifest.runId);
    assert.equal((await f.backups.status()).externalStatus, 'verified');
    await verifyArchive(join(destinationRoot, first.archive.name), first);
    f.advance(86400000); const second = await f.backups.create();
    await rm(join(f.outputRoot, first.archive.name)); await rm(join(f.outputRoot, `${first.archive.name}.complete.json`));
    await replicateBackups(options);
    await verifyArchive(join(destinationRoot, first.archive.name), first);
    await writeFile(join(destinationRoot, second.archive.name), 'broken copy');
    await assert.rejects(replicateBackups(options), /checksum/);
    assert.equal((await f.backups.status()).externalStatus, 'failed');
    const foreign = join(f.root, 'foreign'); await mkdir(foreign); await writeFile(join(foreign, 'keep.txt'), 'unrelated');
    await assert.rejects(replicateBackups({ ...options, destinationRoot: foreign, initialise: true }));
    assert.deepEqual(await readdir(foreign), ['keep.txt']);
  } finally { await f.close(); }
});

test('online snapshot survives concurrent edits/deletion and restores records, photos, receipts with a new epoch', async () => {
  const f = await fixture(); try {
    const later = f.capture('Accepted after the snapshot, with a lost reply');
    const coordinator = new BackupCoordinator(f.db, f.media.files, f.retention, { dataRoot: f.dataRoot, outputRoot: f.outputRoot, development: true, now: f.now,
      afterSnapshot: async manifest => {
        assert.equal(manifest.files.length, 2);
        assert.equal(f.writes.execute(f.context, 'DeleteInboxEntry', f.command({ inboxId: f.inboxId, expectedRevision: 1 })).status, 'Applied');
        assert.equal(f.writes.execute(f.context, 'CreateInboxEntry', later).status, 'Applied');
        f.advance(3 * 86400000); assert.equal(await f.media.collect(), 0, 'snapshot protects originals even after live reference deletion');
      } });
    const completed = await coordinator.create();
    const marker = join(f.outputRoot, `${completed.archive.name}.complete.json`);
    assert.deepEqual(await readCompletion(marker), completed);
    await verifyArchive(join(f.outputRoot, completed.archive.name), completed);
    assert.equal(await f.media.collect(), 1, 'hold is released after the copied bytes are verified');
    const restoredRoot = join(f.root, 'restored'); const result = await restoreBackup(marker, restoredRoot, true);
    assert.notEqual(result.serverEpoch, f.session.serverEpoch);
    const restored = await buildApp({ dataRoot: restoredRoot, development: true, publicOrigin: origin });
    try {
      const saved = restored.inbox.get(f.context, f.inboxId); assert.equal(saved.deletedAt, null); assert.equal(saved.revision, 1);
      assert.deepEqual((await restored.media.read(f.context, f.mediaId)).bytes, png);
      const replay = restored.writes.execute(f.context, 'CreateInboxEntry', f.original); assert.equal(replay.status, 'Applied'); assert.equal('replayed' in replay && replay.replayed, true);
      assert.equal(restored.writes.execute(f.context, 'CreateInboxEntry', later).status, 'RecoveryRequired');
      assert.equal(restored.writes.abandonRestored(f.context, 'CreateInboxEntry', f.original).status, 'Applied', 'a surviving receipt takes precedence over abandonment');
      const abandoned = restored.writes.abandonRestored(f.context, 'CreateInboxEntry', later);
      assert.equal(abandoned.status, 'Rejected'); assert.equal(abandoned.status === 'Rejected' && abandoned.code, 'abandoned_after_restore');
      assert.equal(restored.writes.execute(f.context, 'CreateInboxEntry', later).status, 'Rejected');
      assert.throws(() => restored.writes.abandonRestored(f.context, 'CreateInboxEntry', { ...later, operationId: randomUUID(), expectedServerEpoch: result.serverEpoch }), /ordinary_submission/);
      assert.equal(restored.writes.execute(f.context, 'SetInboxEntryText', f.command({ inboxId: f.inboxId, expectedRevision: 1, text: 'Stale revision accidentally matches' })).status, 'RecoveryRequired');
      assert.equal(restored.inbox.snapshot(f.context, Date.now()).entries.length, 1);
      assert.equal(restored.history.list(f.context, f.inboxId).length, 1);
    } finally { await restored.app.close(); }
    assert.equal((await f.backups.status()).runs[0]!.available, true);
    await assert.rejects(restoreBackup(marker, restoredRoot, true), /must not exist/);
  } finally { await f.close(); }
});

test('Home receipts stay live through other reference removal and restore with exact service cost and history', async () => {
  const f = await fixture();
  try {
    const assetId = randomUUID(), serviceId = randomUUID();
    const scopeId = f.session.scopes.find(scope => scope.kind === 'shared')!.scopeId;
    const home = new HomeRepository(f.db, f.access);
    const asset = f.command({ recordId: assetId, scopeId, name: 'Fixture heat pump', model: '', serial: '', location: '', acquiredDate: null, notes: 'Keep the service record' });
    const service = f.command({ recordId: serviceId, scopeId, assetId, occurredAt: f.now(), notes: 'Annual service', costAmount: '143.2500', currency: 'CAD' });
    assert.equal(f.writes.execute(f.context, 'CreateHomeAsset', asset).status, 'Applied');
    assert.equal(f.writes.execute(f.context, 'CreateMaintenanceRecord', service).status, 'Applied');
    const attachment = { attachmentId: randomUUID(), mediaId: f.mediaId, digest: sha256(png), byteLength: png.length, mimeType: 'image/png', position: 0, caption: 'Service receipt' };
    assert.equal(f.writes.execute(f.context, 'SetRecordAttachments', f.command({ recordId: serviceId, expectedRevision: 1, attachments: [attachment] })).status, 'Applied');
    assert.equal(f.writes.execute(f.context, 'DeleteInboxEntry', f.command({ inboxId: f.inboxId, expectedRevision: 1 })).status, 'Applied');
    f.advance(3 * 86400000);
    assert.equal(await f.media.collect(), 0, 'The Home service remains an active photo reference');
    const before = home.snapshot(f.context);
    const completed = await f.backups.create();
    assert.equal(f.writes.execute(f.context, 'DeleteMaintenanceRecord', f.command({ recordId: serviceId, expectedRevision: 2 })).status, 'Applied');
    f.advance(3 * 86400000);
    assert.equal(await f.media.collect(), 1, 'The last removed reference can expire');
    const restoredRoot = join(f.root, 'restored-home');
    await restoreBackup(join(f.outputRoot, `${completed.archive.name}.complete.json`), restoredRoot, true);
    const restored = await buildApp({ dataRoot: restoredRoot, development: true, publicOrigin: origin });
    try {
      assert.deepEqual(new HomeRepository(restored.db, restored.access).snapshot(f.context), before);
      assert.deepEqual((await restored.media.read(f.context, f.mediaId)).bytes, png);
      const versions = restored.history.list(f.context, serviceId, 'maintenance_record');
      assert.equal(versions.length, 2);
      assert.equal(versions[0]!.canUndo, true);
      assert.equal(restored.writes.execute(f.context, 'CreateMaintenanceRecord', service).status, 'Applied');
      assert.deepEqual(restored.db.pragma('foreign_key_check'), []);
    } finally { await restored.app.close(); }
  } finally { await f.close(); }
});

test('failed exports release collection hold and never publish completion; corrupt archives cannot restore', async () => {
  const f = await fixture(); try {
    const completed = await f.backups.create();
    const marker = join(f.outputRoot, `${completed.archive.name}.complete.json`);
    const archive = join(f.outputRoot, completed.archive.name);
    const bytes = await readFile(archive); bytes[20] = (bytes[20] ?? 0) ^ 1; await writeFile(archive, bytes);
    await assert.rejects(restoreBackup(marker, join(f.root, 'bad-restore'), true), /checksum mismatch/);
    const storage = f.db.prepare('SELECT storage_key FROM media_objects WHERE media_id=?').get(f.mediaId) as { storage_key: string };
    await writeFile(f.media.files.path(storage.storage_key), Buffer.from('broken photo'));
    await assert.rejects(f.backups.create(), /checksum mismatch/);
    assert.equal((await readdir(f.outputRoot)).filter(name => name.endsWith('.complete.json')).length, 1);
    f.writes.execute(f.context, 'DeleteInboxEntry', f.command({ inboxId: f.inboxId, expectedRevision: 1 })); f.advance(3 * 86400000);
    assert.equal(await f.media.collect(), 1);
    assert.equal((await f.backups.status()).runs[0]!.state, 'failed');
  } finally { await f.close(); }
});

test('retention keeps the newest export per day, retries interrupted cleanup, and preserves daily worker output', async () => {
  const f = await fixture(); try {
    const first = await f.backups.create(); f.advance(1000);
    const second = await f.backups.create();
    // Retention groups by UTC date; the worker runs by local wall time. Cross both boundaries even for a late-evening test run.
    const next = new Date(f.now()); next.setDate(next.getDate() + 2); next.setHours(7, 0, 0, 0); f.advance(next.getTime() - f.now());
    const worker = new OperationsWorker(f.db, f.media, f.backups, { backupsEnabled: true, backupHour: 6, now: f.now, report: error => { throw error; } });
    await worker.tick(); await worker.tick(); await f.backups.prune();
    const status = await f.backups.status();
    assert.equal(status.runs.filter(run => run.available).length, 2, 'daily worker runs once and retention keeps yesterday plus today');
    assert.equal(status.runs.find(run => run.runId === first.manifest.runId)?.state, 'pruned');
    assert.equal(status.runs.find(run => run.runId === second.manifest.runId)?.available, true);
    assert.equal((await readdir(f.outputRoot)).includes(first.archive.name), false);
    const orphanId = randomUUID();
    f.db.prepare("INSERT INTO backup_runs(run_id,started_at,state) VALUES (?,?,'running')").run(orphanId, f.now());
    await writeFile(join(f.outputRoot, `backup-${orphanId}.tar.gz.partial`), 'interrupted archive');
    await f.backups.initialise();
    assert.equal((await readdir(f.outputRoot)).some(name => name.includes(orphanId)), false);
  } finally { await f.close(); }
});

test('backup administration is private, and the destination must be explicitly owned', async () => {
  const f = await fixture(); try {
    const sam = await f.access.login('sam', 'test-sam-password', 'browser');
    assert.equal((await f.app.inject({ url: '/api/backups', headers: { cookie: `our_place_session=${sam.secret}` } })).statusCode, 404);
    const wrong = join(f.root, 'wrong'); await mkdir(wrong);
    await writeFile(join(wrong, '.our-place-backups.json'), serialise({ format: 1, installationId: randomUUID() }));
    const coordinator = new BackupCoordinator(f.db, f.media.files, f.retention, { dataRoot: f.dataRoot, outputRoot: wrong, development: true });
    await assert.rejects(coordinator.create(), /different installation/);
    assert.equal((await coordinator.status()).destinationAvailable, false);
  } finally { await f.close(); }
});
