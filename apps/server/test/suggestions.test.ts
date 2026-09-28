import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandKind, CommandOutcome } from '@our-place/contracts';
import { integrationFixture } from './integration-fixture.js';
import { buildApp } from '../src/app.js';
import { createRecordFeatures } from '../src/application/record-features.js';
import { migrationsRoot } from '../src/paths.js';
import { migrate, immediate } from '../src/infrastructure/database.js';
import { ensureRecipeWorker } from '../src/features/access/workers.js';
import {
  provisionSuggestionAgent,
  authenticateSuggestionAgent,
} from '../src/features/suggestions/agent-access.js';

function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}
test('022 preserves existing rows and recipe-worker identity, including rollback of its referenced-table rebuild', async () => {
  const f = await integrationFixture();
  try {
    for (const name of (await readdir(migrationsRoot)).filter((n) => n.endsWith('.sql') && n < '022_'))
      await copyFile(join(migrationsRoot, name), join(f.oldMigrations, name));
    migrate(f.db, f.oldMigrations);
    const worker = immediate(f.db, () => ensureRecipeWorker(f.db, f.legacy.contexts[0]!));
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','record_kinds','sqlite_sequence') ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((t) => t.name);
    const snapshot = () => tables.map((t) => f.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
      before = snapshot();
    const filename = '022_suggestion_discussions.sql',
      sql = await readFile(join(migrationsRoot, filename), 'utf8');
    for (const fault of [
      'SELECT missing_suggestion_migration();',
      "INSERT INTO suggestion_agents(agent_id,client_id,token_digest,created_at) VALUES ('missing-worker','missing-client','bad',0);",
    ]) {
      await writeFile(join(f.oldMigrations, filename), sql + '\n' + fault);
      assert.throws(() => migrate(f.db, f.oldMigrations), /function|foreign key check/);
      assert.deepEqual(snapshot(), before);
      assert.equal(f.db.pragma('foreign_keys', { simple: true }), 1);
    }
    migrate(f.db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(
      immediate(f.db, () => ensureRecipeWorker(f.db, f.legacy.contexts[0]!)),
      worker,
    );
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
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

test('suggestion reply and work intent are atomic, replay once, and leave original note untouched', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion(),
      before = f.service.inbox.get(f.a, id),
      args = f.reply(id, true),
      command = f.envelope(args);
    const result = applied(f.service.writes.execute(f.a, 'PostSuggestionMessage', command));
    const replay = applied(f.service.writes.execute(f.a, 'PostSuggestionMessage', command));
    assert.equal(replay.changeSetId, result.changeSetId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(f.service.inbox.get(f.a, id), before);
    const view = f.features.suggestions.snapshot(f.b);
    assert.equal(view.messages.length, 1);
    assert.equal(view.work.length, 1);
    assert.equal(view.work[0]!.requestId, args.recordId);
    const undo = f.run('UndoChangeSet', { changeSetId: result.changeSetId });
    assert.equal(undo.status, 'Rejected');
    applied(f.run('CancelSuggestionWork', { requestId: args.recordId }));
    applied(f.run('UndoChangeSet', { changeSetId: result.changeSetId }));
    assert.equal(f.features.suggestions.messages(f.a, id)[0]!.deletedAt, f.now());
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('private discussion inherits access and invalid question rolls back every record', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion(f.privateScope),
      args = f.reply(id, false, f.privateScope);
    applied(f.run('PostSuggestionMessage', args));
    assert.deepEqual(f.features.suggestions.snapshot(f.b).messages, []);
    assert.throws(() => f.features.suggestions.messages(f.b, id));
    const count = f.db.prepare('SELECT count(*) AS n FROM records').get();
    const other = f.suggestion(),
      baseline = f.db.prepare('SELECT count(*) AS n FROM records').get();
    const failed = f.run('PostSuggestionMessage', {
      ...f.reply(other, true),
      replyToQuestionId: args.recordId,
    });
    assert.equal(failed.status, 'Rejected');
    assert.deepEqual(f.db.prepare('SELECT count(*) AS n FROM records').get(), baseline);
    assert.ok(count);
    assert.equal(f.features.suggestions.snapshot(f.a).work.length, 0);
  } finally {
    await f.close();
  }
});
test('undo cannot hide a later discussion; replying after a fully undone discussion restores its workflow', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion(),
      first = applied(f.run('PostSuggestionMessage', f.reply(id)));
    applied(f.run('PostSuggestionMessage', f.reply(id), f.b));
    assert.equal(f.run('UndoChangeSet', { changeSetId: first.changeSetId }).status, 'Rejected');
    const other = f.suggestion(),
      only = applied(f.run('PostSuggestionMessage', f.reply(other)));
    applied(f.run('UndoChangeSet', { changeSetId: only.changeSetId }));
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: other }));
    assert.equal(
      f.features.suggestions.snapshot(f.a).workflows.find((w) => w.suggestionId === other)!.deletedAt,
      null,
    );
  } finally {
    await f.close();
  }
});

test('agent claims freeze input, late replies queue, questions survive runs and reports replay', async () => {
  const f = await suggestionFixture();
  try {
    const credentials = provisionSuggestionAgent(f.db, 'Test agent', f.now()),
      agent = authenticateSuggestionAgent(f.db, credentials.secret),
      work = f.service.suggestionWork;
    const id = f.suggestion();
    applied(f.run('PostSuggestionMessage', f.reply(id, true)));
    const op = randomUUID(),
      first = work.claim(agent, op, 'fixture-epoch').run!;
    assert.equal(work.claim(agent, op, 'fixture-epoch').run!.runId, first.runId);
    assert.equal(first.context.messages.length, 1);
    applied(f.run('PostSuggestionMessage', f.reply(id, true), f.b));
    assert.equal(work.claim(agent, randomUUID(), 'fixture-epoch').run, null);
    const questionId = randomUUID(),
      report = {
        reportId: randomUUID(),
        expectedServerEpoch: 'fixture-epoch',
        runId: first.runId,
        summary: 'Need a preference',
        status: 'needs_input' as const,
        messages: [
          {
            messageId: questionId,
            text: 'Which layout?',
            kind: 'question' as const,
            choices: ['Compact', 'Spacious'],
          },
        ],
        resolvedQuestionIds: [],
      };
    const result = work.report(agent, first.leaseToken, report);
    assert.deepEqual(work.report(agent, first.leaseToken, report), result);
    assert.equal(f.features.suggestions.snapshot(f.a).questions[0]!.state, 'unanswered');
    applied(
      f.run('PostSuggestionMessage', {
        ...f.reply(id, true),
        replyToQuestionId: questionId,
        text: 'Compact',
      }),
    );
    const second = work.claim(agent, randomUUID(), 'fixture-epoch').run!;
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.context.messages.length, 4);
    assert.equal(second.context.questions[0]!.state, 'answered');
    work.report(agent, second.leaseToken, {
      ...report,
      reportId: randomUUID(),
      runId: second.runId,
      status: 'ready',
      summary: 'Implemented and tested, awaiting integration.',
      messages: [],
      resolvedQuestionIds: [questionId],
    });
    assert.equal(f.features.suggestions.snapshot(f.b).questions[0]!.state, 'resolved');
    assert.equal(f.features.suggestions.snapshot(f.a).work.filter((w) => w.state === 'queued').length, 0);
    assert.throws(() => work.report(agent, first.leaseToken, { ...report, reportId: randomUUID() }));
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('lease expiry fences writes without releasing work; reconciliation rotates token; restore and revocation reject old authority', async () => {
  const f = await suggestionFixture();
  try {
    const credentials = provisionSuggestionAgent(f.db, 'Test agent', f.now()),
      agent = authenticateSuggestionAgent(f.db, credentials.secret),
      work = f.service.suggestionWork;
    const id = f.suggestion();
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    const first = work.claim(agent, randomUUID(), 'fixture-epoch').run!;
    f.setTime(first.leaseUntil + 1);
    assert.equal(work.status(agent, 'fixture-epoch').runs[0]!.state, 'uncertain');
    assert.throws(() => work.heartbeat(agent, first.runId, first.leaseToken, 'fixture-epoch'));
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    assert.equal(work.claim(agent, randomUUID(), 'fixture-epoch').run, null);
    const resumed = work.transition(agent, {
      operationId: randomUUID(),
      expectedServerEpoch: 'fixture-epoch',
      runId: first.runId,
      leaseToken: first.leaseToken,
      state: 'reconcile',
      sessionId: null,
      turnId: null,
      issue: null,
    }).run;
    assert.notEqual(resumed.leaseToken, first.leaseToken);
    assert.throws(() => work.heartbeat(agent, first.runId, first.leaseToken, 'fixture-epoch'));
    work.heartbeat(agent, resumed.runId, resumed.leaseToken, 'fixture-epoch');
    assert.throws(() => work.heartbeat(agent, resumed.runId, resumed.leaseToken, 'wrong-epoch'));
    f.db.prepare('UPDATE suggestion_agents SET enabled=0 WHERE agent_id=?').run(agent.agentId);
    assert.throws(() => work.status(agent, 'fixture-epoch'));
    assert.throws(() => f.service.access.authenticate(credentials.secret));
  } finally {
    await f.close();
  }
});

test('obsolete questions can be dismissed without dispatch, with scoped history, replay and undo', async () => {
  const f = await suggestionFixture();
  try {
    const credentials = provisionSuggestionAgent(f.db, 'Test agent', f.now());
    const agent = authenticateSuggestionAgent(f.db, credentials.secret),
      work = f.service.suggestionWork;
    const id = f.suggestion();
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    const run = work.claim(agent, randomUUID(), 'fixture-epoch').run!;
    const questionId = randomUUID();
    work.report(agent, run.leaseToken, {
      reportId: randomUUID(),
      expectedServerEpoch: 'fixture-epoch',
      runId: run.runId,
      summary: 'Old environment question',
      status: 'needs_input',
      messages: [
        { messageId: questionId, kind: 'question', text: 'Is the old environment available?', choices: [] },
      ],
      resolvedQuestionIds: [],
    });
    const command = f.envelope({ recordId: randomUUID(), suggestionId: id, questionId });
    const result = applied(f.service.writes.execute(f.b, 'DismissSuggestionQuestion', command));
    assert.equal(applied(f.service.writes.execute(f.b, 'DismissSuggestionQuestion', command)).replayed, true);
    let view = f.features.suggestions.snapshot(f.a);
    assert.equal(view.questions[0]!.state, 'resolved');
    assert.equal(view.messages.filter((m) => m.messageType === 'resolution').length, 1);
    assert.equal(view.messages.find((m) => m.recordId === questionId)!.deletedAt, null);
    assert.equal(view.work.length, 1);
    const undo = applied(f.run('UndoChangeSet', { changeSetId: result.changeSetId }, f.b));
    assert.equal(f.features.suggestions.snapshot(f.a).questions[0]!.state, 'unanswered');
    applied(f.run('RedoChangeSet', { changeSetId: undo.changeSetId }, f.b));
    assert.equal(f.features.suggestions.snapshot(f.a).questions[0]!.state, 'resolved');
    const otherId = f.suggestion();
    assert.equal(
      f.run('DismissSuggestionQuestion', { recordId: randomUUID(), suggestionId: otherId, questionId })
        .status,
      'Rejected',
    );
    const privateId = f.suggestion(f.privateScope);
    assert.throws(() =>
      f.run(
        'DismissSuggestionQuestion',
        { recordId: randomUUID(), suggestionId: privateId, questionId },
        f.b,
      ),
    );
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    assert.equal(
      work.claim(agent, randomUUID(), 'fixture-epoch').run!.context.questions[0]!.state,
      'resolved',
    );
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
