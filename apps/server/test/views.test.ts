import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyRecipeFields } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { ViewPreferences } from '../src/features/views/views.js';
test('view pins have their own revision and scope, preserve recipe revision/history, and replay once', async () => {
  const f = await integrationFixture(),
    service = await buildApp({
      db: f.db,
      dataRoot: f.dataRoot,
      development: true,
      publicOrigin: 'http://localhost',
      now: f.now,
    });
  try {
    const a = service.access.authenticate('a'.repeat(43)),
      b = service.access.authenticate('b'.repeat(43)),
      views = new ViewPreferences(f.db, service.access),
      id = randomUUID();
    const scopeId = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
    const envelope = (args: unknown) => ({
      operationId: randomUUID(),
      contractVersion: 1 as const,
      expectedServerEpoch: 'fixture-epoch',
      arguments: args,
    });
    assert.equal(
      service.writes.execute(
        a,
        'CreateRecipe',
        envelope({ recordId: id, scopeId, ...emptyRecipeFields(), title: 'Soup', collectionIds: [] }),
      ).status,
      'Applied',
    );
    const history = service.history.list(a, id, 'recipe'),
      command = envelope({
        recordId: id,
        scopeId,
        viewKind: 'food_soon',
        expectedViewRevision: 0,
        pinned: true,
      });
    const first = service.writes.execute(a, 'SetRecordPin', command);
    assert.equal(first.status, 'Applied');
    assert.deepEqual(service.writes.execute(a, 'SetRecordPin', command), { ...first, replayed: true });
    assert.equal(views.snapshot(a)[0]!.revision, 1);
    assert.equal(views.snapshot(a)[0]!.pins[0]!.recordId, id);
    assert.deepEqual(views.snapshot(b), []);
    assert.deepEqual(service.history.list(a, id, 'recipe'), history);
    assert.equal(f.db.prepare('SELECT revision FROM records WHERE record_id=?').pluck().get(id), 1);
    const conflict = service.writes.execute(
      a,
      'SetRecordPin',
      envelope({ ...(command.arguments as object), pinned: false }),
    );
    assert.equal(conflict.status, 'Rejected');
    assert.equal(views.snapshot(a)[0]!.pins.length, 1);
    assert.equal(
      service.writes.execute(
        a,
        'SetRecordPin',
        envelope({ ...(command.arguments as object), expectedViewRevision: 1, pinned: false }),
      ).status,
      'Applied',
    );
    assert.equal(views.snapshot(a)[0]!.pins.length, 0);
    assert.equal(views.snapshot(a)[0]!.revision, 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await service.app.close();
    await f.close();
  }
});
