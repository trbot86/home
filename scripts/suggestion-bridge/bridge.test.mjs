import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { integrationFixture } from '../../apps/server/test/integration-fixture.ts';
import { buildApp } from '../../apps/server/src/app.ts';
import {
  provisionSuggestionAgent,
  authenticateSuggestionAgent,
} from '../../apps/server/src/features/suggestions/agent-access.ts';
import { SuggestionRunner, validateResult } from './runner.mjs';
import { writeJson, readJson, deliver } from './journal.mjs';

async function fixture() {
  const f = await integrationFixture();
  f.setTime(Date.now());
  const app = await buildApp({
    db: f.db,
    dataRoot: f.dataRoot,
    development: true,
    publicOrigin: 'http://localhost',
    now: () => Date.now(),
  });
  const actor = f.legacy.contexts[0],
    scopeId = app.access.scopes(actor).find((s) => s.kind === 'shared').scopeId;
  const id = randomUUID(),
    epoch = 'fixture-epoch';
  const execute = (kind, args) => {
    const result = app.writes.execute(actor, kind, {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: epoch,
      arguments: args,
    });
    assert.equal(result.status, 'Applied', JSON.stringify(result));
    return result;
  };
  execute('CreateInboxEntry', {
    inboxId: id,
    scopeId,
    category: 'app_suggestion',
    text: 'Synthetic runner check',
    capturedAt: Date.now(),
    source: { kind: 'typed' },
    attachments: [],
  });
  execute('RequestSuggestionWork', { recordId: randomUUID(), suggestionId: id });
  const credentials = provisionSuggestionAgent(f.db, 'Synthetic agent', Date.now()),
    agent = authenticateSuggestionAgent(f.db, credentials.secret),
    work = app.suggestionWork;
  const send = async (path, body) => {
    const result = await app.app.inject({
      method: 'POST',
      url: '/api/suggestion-agent/' + path,
      headers: { authorization: 'Bearer ' + credentials.secret },
      payload: body,
    });
    if (result.statusCode !== 200) throw new Error(result.json().code);
    return result.json();
  };
  const config = { stateRoot: join(f.root, 'bridge'), serverEpoch: epoch };
  const run = (await send('claim', { operationId: randomUUID(), expectedServerEpoch: epoch })).run;
  return {
    ...f,
    app,
    config,
    run,
    send,
    work,
    agent,
    execute,
    id,
    scopeId,
    close: async () => {
      await app.app.close();
      await f.close();
    },
  };
}

test('journal repeats identical dispatch after lost acknowledgement', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'request.json');
    let calls = 0,
      original;
    const send = async (request) => {
      calls++;
      original ??= request;
      assert.deepEqual(request, original);
      if (calls === 1) throw new Error('Lost response');
      return { accepted: true };
    };
    await assert.rejects(deliver(path, () => ({ operationId: randomUUID() }), send));
    assert.deepEqual(
      await deliver(
        path,
        () => {
          throw new Error('Must retain request');
        },
        send,
      ),
      { accepted: true },
    );
    await deliver(
      path,
      () => {
        throw new Error();
      },
      send,
    );
    assert.equal(calls, 2);
  } finally {
    await f.close();
  }
});

test('detached agent survives bridge restart, is not relaunched, and publishes a durable question', async () => {
  const f = await fixture();
  try {
    let runner = new SuggestionRunner(f.config, f.send);
    const directory = runner.directory(f.run),
      script = join(f.root, 'fake-agent.mjs'),
      counter = join(f.root, 'launch-count.txt');
    await writeFile(
      script,
      `import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync(${JSON.stringify(counter)},'started\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'synthetic-session'}));setTimeout(()=>{writeFileSync(process.argv[2],JSON.stringify({summary:'Need a layout choice',status:'needs_input',messages:[{kind:'question',text:'Compact or spacious?',choices:['Compact','Spacious']}],resolvedQuestionIds:[]}));console.log(JSON.stringify({type:'turn.completed'}));},700);`,
    );
    const outputPath = join(directory, 'result.json'),
      promptPath = join(f.root, 'prompt.txt');
    await writeFile(promptPath, 'Synthetic input');
    await writeJson(join(directory, 'launch.json'), {
      nonce: randomUUID(),
      runId: f.run.runId,
      cwd: f.root,
      promptPath,
      outputPath,
      executable: process.execPath,
      arguments: [script, outputPath],
    });
    assert.equal(await runner.tick(f.run), 'starting');
    runner = new SuggestionRunner(f.config, f.send); // Fresh host adapter, existing journal and external process.
    let outcome;
    for (let i = 0; i < 100; i++) {
      await delay(50);
      const current = f.work.status(f.agent, 'fixture-epoch').runs[0];
      if (!current) break;
      outcome = await runner.tick(current);
      if (outcome === 'needs_input') break;
    }
    assert.equal(outcome, 'needs_input', await readFile(join(directory, 'supervisor.log'), 'utf8'));
    assert.equal((await readFile(counter, 'utf8')).split('started').length - 1, 1);
    assert.ok(await readJson(join(directory, 'published.json')));
    const question = f.db
      .prepare("SELECT message_id FROM suggestion_messages WHERE message_type='question'")
      .get();
    assert.ok(question);
    f.execute('PostSuggestionMessage', {
      recordId: randomUUID(),
      suggestionId: f.id,
      scopeId: f.scopeId,
      text: 'Compact',
      replyToQuestionId: question.message_id,
      requestWork: true,
      attachments: [],
    });
    const next = f.work.claim(f.agent, randomUUID(), 'fixture-epoch').run;
    assert.equal(next.context.questions[0].state, 'answered');
  } finally {
    await f.close();
  }
});

test('ambiguous launch remains uncertain and never creates a replacement process', async () => {
  const f = await fixture();
  try {
    const runner = new SuggestionRunner(f.config, f.send),
      directory = runner.directory(f.run);
    await writeJson(join(directory, 'launch-intent.json'), { at: Date.now() - 20000 });
    assert.equal(await runner.tick(f.run), 'uncertain');
    const pending = f.work.status(f.agent, 'fixture-epoch').runs[0];
    assert.equal(await new SuggestionRunner(f.config, f.send).tick(pending), 'uncertain');
    assert.equal(await readJson(join(directory, 'supervisor.json')), null);
    assert.equal(f.work.claim(f.agent, randomUUID(), 'fixture-epoch').run, null);
  } finally {
    await f.close();
  }
});

test('agent completion distinguishes ready from release and requires durable questions', () => {
  assert.throws(() =>
    validateResult({ summary: 'Done', status: 'released', messages: [], resolvedQuestionIds: [] }),
  );
  assert.throws(() =>
    validateResult({ summary: 'Blocked', status: 'needs_input', messages: [], resolvedQuestionIds: [] }),
  );
});

test('a missing local journal cannot relaunch a server-acknowledged process', async () => {
  const f = await fixture();
  try {
    const started = f.work.transition(f.agent, {
      operationId: randomUUID(),
      runId: f.run.runId,
      leaseToken: f.run.leaseToken,
      expectedServerEpoch: 'fixture-epoch',
      state: 'running',
      sessionId: 'previous-session',
      turnId: null,
      issue: null,
    }).run;
    const runner = new SuggestionRunner(f.config, f.send);
    assert.equal(await runner.tick(started), 'uncertain');
    assert.equal(await readJson(join(runner.directory(started), 'launch-intent.json')), null);
  } finally {
    await f.close();
  }
});
