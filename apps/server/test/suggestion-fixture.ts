import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { CommandKind, CommandOutcome } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { createRecordFeatures } from '../src/application/record-features.js';
function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  return outcome;
}
export async function suggestionFixture() {
  const f = await integrationFixture();
  const service = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: f.now,
  });
  const a = service.access.authenticate('a'.repeat(43)),
    b = service.access.authenticate('b'.repeat(43));
  const features = createRecordFeatures(f.db, service.access);
  const shared = service.access.scopes(a).find((s) => s.kind === 'shared')!.scopeId;
  const privateScope = service.access.scopes(a).find((s) => s.kind === 'private')!.scopeId;
  const envelope = (args: unknown) => ({
    operationId: randomUUID(),
    contractVersion: 1 as const,
    expectedServerEpoch: 'fixture-epoch',
    arguments: args,
  });
  const run = (kind: CommandKind, args: unknown, context = a) =>
    service.writes.execute(context, kind, envelope(args));
  const suggestion = (scopeId = shared) => {
    const inboxId = randomUUID();
    applied(
      run('CreateInboxEntry', {
        inboxId,
        scopeId,
        category: 'app_suggestion',
        text: 'Make suggestions easier to follow',
        capturedAt: f.now(),
        source: { kind: 'typed' },
        attachments: [],
      }),
    );
    return inboxId;
  };
  const reply = (suggestionId: string, requestWork = false, scopeId = shared) => ({
    recordId: randomUUID(),
    suggestionId,
    scopeId,
    text: 'A follow-up',
    replyToQuestionId: null,
    requestWork,
    attachments: [],
  });
  return {
    ...f,
    service,
    features,
    a,
    b,
    shared,
    privateScope,
    envelope,
    run,
    suggestion,
    reply,
    close: async () => {
      await service.app.close();
      await f.close();
    },
  };
}
