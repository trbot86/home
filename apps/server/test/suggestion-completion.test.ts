import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandOutcome } from '@our-place/contracts';
import { suggestionFixture } from './suggestion-fixture.js';
import { integrationFixture } from './integration-fixture.js';
import { migrationsRoot } from '../src/paths.js';
import { migrate } from '../src/infrastructure/database.js';
import {
  authenticateSuggestionAgent,
  provisionSuggestionAgent,
} from '../src/features/suggestions/agent-access.js';

function applied(outcome: CommandOutcome) {
  assert.equal(outcome.status, 'Applied', JSON.stringify(outcome));
  if (outcome.status !== 'Applied') throw new Error();
  return outcome;
}

test('completion persists independently of work status, replays once and preserves the original and discussion', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion();
    const original = f.service.inbox.get(f.a, id);
    applied(f.run('PostSuggestionMessage', f.reply(id)));
    const before = f.features.suggestions.snapshot(f.a);
    const workflow = before.workflows[0]!;
    const command = f.envelope({ suggestionId: id, expectedRevision: workflow.revision, completed: true });
    const result = applied(f.service.writes.execute(f.a, 'SetSuggestionCompleted', command));
    const replay = applied(f.service.writes.execute(f.a, 'SetSuggestionCompleted', command));
    assert.equal(replay.changeSetId, result.changeSetId);
    assert.equal(replay.replayed, true);
    const completed = f.features.suggestions.snapshot(f.b);
    assert.equal(completed.workflows[0]!.completedAt, f.now());
    assert.equal(completed.workflows[0]!.status, workflow.status);
    assert.equal(completed.workflows[0]!.revision, workflow.revision + 1);
    assert.deepEqual(completed.messages, before.messages);
    assert.deepEqual(f.service.inbox.get(f.a, id), original);
    assert.equal(
      f.run('SetSuggestionCompleted', {
        suggestionId: id,
        expectedRevision: workflow.revision,
        completed: false,
      }).status,
      'Rejected',
    );
    applied(
      f.run(
        'SetSuggestionCompleted',
        { suggestionId: id, expectedRevision: completed.workflows[0]!.revision, completed: false },
        f.b,
      ),
    );
    assert.equal(f.features.suggestions.snapshot(f.a).workflows[0]!.completedAt, null);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('completion can start a workflow, enforces visibility and active category, and supports guarded undo', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion(f.privateScope);
    const args = { suggestionId: id, expectedRevision: 0, completed: true };
    assert.throws(() => f.run('SetSuggestionCompleted', args, f.b));
    const first = applied(f.run('SetSuggestionCompleted', args));
    assert.equal(f.features.suggestions.snapshot(f.a).workflows[0]!.completedAt, f.now());
    assert.equal(f.features.suggestions.snapshot(f.b).workflows.length, 0);
    applied(f.run('UndoChangeSet', { changeSetId: first.changeSetId }));
    const hidden = f.features.suggestions.snapshot(f.a).workflows[0]!;
    assert.notEqual(hidden.deletedAt, null);
    applied(f.run('SetSuggestionCompleted', { ...args, expectedRevision: hidden.revision }));
    assert.equal(f.features.suggestions.snapshot(f.a).workflows[0]!.deletedAt, null);
    assert.equal(f.features.suggestions.snapshot(f.a).workflows[0]!.completedAt, f.now());
    // Restoring discussion after undo keeps it active, even if its old workflow was completed.
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    assert.equal(f.features.suggestions.snapshot(f.a).workflows[0]!.completedAt, null);
    const other = f.suggestion();
    const entry = f.service.inbox.get(f.a, other);
    applied(
      f.run('SetInboxEntryCategory', { inboxId: other, expectedRevision: entry.revision, category: 'inbox' }),
    );
    assert.equal(
      f.run('SetSuggestionCompleted', { suggestionId: other, expectedRevision: 0, completed: true }).status,
      'Rejected',
    );
  } finally {
    await f.close();
  }
});

test('active work cannot be completed; ready work stays active until chosen, and follow-up work reopens completion atomically', async () => {
  const f = await suggestionFixture();
  try {
    const id = f.suggestion();
    const credentials = provisionSuggestionAgent(f.db, 'Test agent', f.now());
    const agent = authenticateSuggestionAgent(f.db, credentials.secret);
    const snapshot = () => f.features.suggestions.snapshot(f.a);
    const complete = () =>
      f.run('SetSuggestionCompleted', {
        suggestionId: id,
        expectedRevision: snapshot().workflows[0]!.revision,
        completed: true,
      });
    applied(f.run('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id }));
    assert.equal(complete().status, 'Rejected');
    const run = f.service.suggestionWork.claim(agent, randomUUID(), 'fixture-epoch').run!;
    assert.equal(complete().status, 'Rejected');
    f.service.suggestionWork.report(agent, run.leaseToken, {
      reportId: randomUUID(),
      expectedServerEpoch: 'fixture-epoch',
      runId: run.runId,
      status: 'ready',
      summary: 'Implemented and tested; awaiting review.',
      messages: [],
      resolvedQuestionIds: [],
    });
    assert.equal(snapshot().workflows[0]!.completedAt, null);
    const releaseId = randomUUID();
    applied(f.run('PrepareSuggestionRelease', { releaseId, suggestionId: id, runId: run.runId }));
    assert.equal(complete().status, 'Rejected');
    applied(f.run('CancelSuggestionRelease', { releaseId }));
    applied(complete());
    assert.equal(
      f.run('PrepareSuggestionRelease', { releaseId: randomUUID(), suggestionId: id, runId: run.runId })
        .status,
      'Rejected',
    );
    applied(f.run('PostSuggestionMessage', f.reply(id)));
    assert.equal(snapshot().workflows[0]!.completedAt, f.now(), 'A note alone keeps completion');
    assert.equal(
      f.run('PostSuggestionMessage', { ...f.reply(id, true), replyToQuestionId: randomUUID() }).status,
      'Rejected',
    );
    assert.equal(snapshot().workflows[0]!.completedAt, f.now(), 'Invalid work reply rolls back reopening');
    const followup = f.envelope(f.reply(id, true));
    applied(f.service.writes.execute(f.b, 'PostSuggestionMessage', followup));
    applied(f.service.writes.execute(f.b, 'PostSuggestionMessage', followup));
    assert.equal(snapshot().workflows[0]!.completedAt, null);
    assert.equal(snapshot().work.filter((w) => w.state === 'queued').length, 1);
    assert.ok(f.service.suggestionWork.claim(agent, randomUUID(), 'fixture-epoch').run);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});

test('025 adds completion without changing existing rows or identity and rolls back cleanly', async () => {
  const f = await integrationFixture();
  try {
    for (const name of (await readdir(migrationsRoot)).filter((n) => n.endsWith('.sql') && n < '025_'))
      await copyFile(join(migrationsRoot, name), join(f.oldMigrations, name));
    migrate(f.db, f.oldMigrations);
    const scope = (
      f.db.prepare("SELECT scope_id FROM visibility_scopes WHERE kind='shared'").get() as { scope_id: string }
    ).scope_id;
    const suggestion = (
      f.db
        .prepare(
          'SELECT i.inbox_id FROM inbox_entries i JOIN records r ON r.record_id=i.inbox_id WHERE r.scope_id=? LIMIT 1',
        )
        .get(scope) as { inbox_id: string }
    ).inbox_id;
    const workflowId = randomUUID();
    f.db
      .prepare("INSERT INTO records VALUES (?,'suggestion_workflow',?,1,1000,1000,NULL)")
      .run(workflowId, scope);
    f.db
      .prepare(
        "INSERT INTO suggestion_workflows(workflow_id,suggestion_id,scope_id,summary,status) VALUES (?,?,?,'Existing summary','ready')",
      )
      .run(workflowId, suggestion, scope);
    const tables = (
      f.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name<>'schema_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map(({ name }) => ({
      name,
      columns: (f.db.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name).join(','),
    }));
    const snapshot = () =>
      tables.map(({ name, columns }) => f.db.prepare(`SELECT ${columns} FROM ${name} ORDER BY rowid`).all());
    const before = snapshot();
    const filename = '025_suggestion_completion.sql';
    const sql = await readFile(join(migrationsRoot, filename), 'utf8');
    await writeFile(join(f.oldMigrations, filename), sql + '\nSELECT missing_completion_migration();');
    assert.throws(() => migrate(f.db, f.oldMigrations), /function/);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      (f.db.pragma('table_info(suggestion_workflows)') as { name: string }[]).some(
        (c) => c.name === 'completed_at',
      ),
      false,
    );
    migrate(f.db);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(f.db.prepare('SELECT completed_at FROM suggestion_workflows').all(), [
      { completed_at: null },
    ]);
    assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {
    await f.close();
  }
});
