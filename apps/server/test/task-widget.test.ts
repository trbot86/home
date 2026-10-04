import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';

test('cache widget projection is read-only, coherent and authorised separately for each person', async () => {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  try {
    const a = service.access.authenticate('a'.repeat(43)),
      b = service.access.authenticate('b'.repeat(43));
    const shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId;
    const privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
    for (const [title, scopeId, assigneeId] of [
      ['Shared work', shared, null],
      ['For partner', shared, b.personId],
      ['Secret present', privateScope, a.personId],
    ] as const) {
      const result = service.writes.execute(a, 'CreateTask', {
        operationId: randomUUID(),
        contractVersion: 1,
        expectedServerEpoch: 'fixture-epoch',
        arguments: {
          recordId: randomUUID(),
          occurrenceId: randomUUID(),
          scopeId,
          title,
          instructions: 'Detailed notes',
          context: 'home',
          defaultAssigneeId: assigneeId,
          defaultPriority: 2,
          recurrence: null,
          assigneeId,
          priority: 2,
          deadlineDate: null,
          targetDate: '2026-09-28',
          reviewDate: null,
        },
      });
      assert.equal(result.status, 'Applied');
    }
    const before = f.db.prepare('SELECT * FROM records ORDER BY record_id').all();
    const mineResponse = await service.app.inject({
      url: '/api/cache/inbox',
      headers: { cookie: `our_place_session=${'a'.repeat(43)}` },
    });
    const partnerResponse = await service.app.inject({
      url: '/api/cache/inbox',
      headers: { authorization: `Bearer ${'b'.repeat(43)}` },
    });
    assert.equal(mineResponse.statusCode, 200);
    assert.equal(partnerResponse.statusCode, 200);
    const mine = mineResponse.json(),
      partner = partnerResponse.json();
    assert.deepEqual(mine.taskWidget.rows.map((r: { title: string }) => r.title).sort(), [
      'Secret present',
      'Shared work',
    ]);
    assert.deepEqual(partner.taskWidget.rows.map((r: { title: string }) => r.title).sort(), [
      'For partner',
      'Shared work',
    ]);
    assert.deepEqual(mine.taskWidget.calendarTasks.map((r: { title: string }) => r.title).sort(), [
      'Secret present',
      'Shared work',
    ]);
    assert.deepEqual(partner.taskWidget.calendarTasks.map((r: { title: string }) => r.title).sort(), [
      'For partner',
      'Shared work',
    ]);
    assert.equal(mine.taskWidget.sampledAt, mine.sampledAt);
    assert.equal(partner.taskWidget.sampledAt, partner.sampledAt);
    assert.equal(mine.taskWidget.personId, a.personId);
    assert.equal(partner.taskWidget.personId, b.personId);
    assert.ok(!JSON.stringify(partner).includes('Secret present'));
    assert.ok(!JSON.stringify(mine.taskWidget).includes('Detailed notes'));
    assert.deepEqual(f.db.prepare('SELECT * FROM records ORDER BY record_id').all(), before);
    assert.equal((await service.app.inject({ url: '/api/cache/inbox' })).statusCode, 401);
  } finally {
    await service.app.close();
    await f.close();
  }
});
