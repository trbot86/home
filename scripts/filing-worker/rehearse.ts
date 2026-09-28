// Explicit opt-in, real-model rehearsal. Creates and destroys only a synthetic
// integration fixture, with no production configuration or household mounts.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { resolve, isAbsolute } from 'node:path';
import { createBroker, dockerJob } from './broker.mjs';
import { integrationFixture } from '../../apps/server/test/integration-fixture.js';
import { buildApp } from '../../apps/server/src/app.js';
import { dedicatedCodexProvider } from '../../apps/server/src/infrastructure/filing-codex-provider.js';
import type { CommandKind } from '@our-place/contracts';

const docker = process.argv[2];
if (!docker || !isAbsolute(docker)) throw Error('Pass the absolute Docker executable path');
const config = {
  docker,
  repository: resolve(import.meta.dirname, '../..'),
  token: randomBytes(32).toString('base64url'),
};
let calls = 0;
const broker = createBroker(config, async (...args) => {
  calls++;
  return dockerJob(...args);
});
broker.listen(0, 'localhost');
await once(broker, 'listening');
const port = (broker.address() as { port: number }).port;
const fixture = await integrationFixture();
const provider = dedicatedCodexProvider(
  {
    launcher: process.execPath,
    workingDirectory: fixture.root,
    model: 'gpt-5.6-luna',
    effort: 'low',
    isolationReviewed: true,
  },
  async (_e, _a, payload, _cwd, _env, signal) => {
    const response = await fetch(`http://localhost:${port}/filing`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.token}` },
      body: payload,
      signal,
    });
    if (!response.ok) throw Error('Synthetic broker failed');
    return response.text();
  },
);
const service = await buildApp({
  db: fixture.db,
  dataRoot: fixture.dataRoot,
  development: true,
  publicOrigin: 'http://localhost',
  now: fixture.now,
  filingAdviceProvider: provider,
});
try {
  const person = service.access.authenticate('a'.repeat(43));
  const scopeId = service.access.scopes(person).find((s) => s.kind === 'shared')!.scopeId;
  const run = (kind: CommandKind, args: unknown) =>
    service.writes.execute(person, kind, {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: 'fixture-epoch',
      arguments: args,
    });
  const api = (url: string, payload: object) =>
    service.app.inject({
      method: 'POST',
      url,
      headers: { cookie: `our_place_session=${'a'.repeat(43)}`, origin: 'http://localhost' },
      payload,
    });
  assert.equal(
    (
      await api('/api/filing-advice/settings', {
        expectedRevision: 0,
        preferences: { enabled: true, automatic: false, scopeIds: [scopeId], destinationTitles: false },
      })
    ).statusCode,
    200,
  );
  const inboxId = randomUUID();
  assert.equal(
    run('CreateInboxEntry', {
      inboxId,
      scopeId,
      text: 'Buy apples and milk',
      capturedAt: fixture.now(),
      source: { kind: 'typed' },
      attachments: [],
    }).status,
    'Applied',
  );
  const request = { expectedRevision: 1, expectedAttempt: 0, destinationIds: [] };
  const response = await api(`/api/inbox/${inboxId}/filing-advice`, request);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().review.choices, [{ kind: 'category', category: 'shopping' }]);
  await api(`/api/inbox/${inboxId}/filing-advice`, request);
  assert.equal(calls, 1);
  assert.equal(service.inbox.get(person, inboxId).revision, 1);
  const listId = randomUUID();
  assert.equal(
    run('CreateShoppingList', {
      recordId: listId,
      scopeId,
      name: 'Synthetic groceries',
      purpose: 'household',
    }).status,
    'Applied',
  );
  const edit = run('FileInboxEntry', {
    inboxId,
    expectedRevision: 1,
    destination: {
      kind: 'AddShoppingEntry',
      arguments: { recordId: randomUUID(), listId, label: 'Apples and milk', quantity: '', notes: '' },
    },
  });
  assert.equal(edit.status, 'Applied');
  if (edit.status === 'Applied')
    assert.equal(run('UndoChangeSet', { changeSetId: edit.changeSetId }).status, 'Applied');
  const secureId = randomUUID();
  assert.equal(
    run('CreateInboxEntry', {
      inboxId: secureId,
      scopeId,
      text: 'Synthetic secure note',
      secure: true,
      capturedAt: fixture.now(),
      source: { kind: 'typed' },
      attachments: [],
    }).status,
    'Applied',
  );
  const secured = await api(`/api/inbox/${secureId}/filing-advice`, request);
  assert.notEqual(secured.statusCode, 200);
  assert.equal(calls, 1);
  console.log(
    'PASS: real Luna low through app, broker, isolated worker and gateway; deduplication, unchanged source, explicit shopping filing/undo, and Secure exclusion.',
  );
} finally {
  await service.app.close();
  await fixture.close();
  broker.closeAllConnections();
  await new Promise<void>((r) => broker.close(() => r()));
}
