import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodexTurn, threadParameters } from './app-server.mjs';
import { steeringMailbox } from './steering.mjs';
import { writeJson, readJson } from './journal.mjs';

async function fixture(
  t,
  {
    wrongPermissions = false,
    crash = false,
    steer = false,
    rejectSteering = false,
    projectId,
    wrongProject = false,
    missingProject = false,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'suggestion-protocol-'));
  const verified = await realpath(root);
  t.after(async () => {
    assert.equal(await realpath(root), verified);
    await rm(root, { recursive: true, force: true });
  });
  const spec = {
    cwd: root,
    packageStore: root,
    promptPath: join(root, 'prompt.txt'),
    schema: join(root, 'schema.json'),
    executable: 'fake',
    runId: 'test-run',
    projectId,
  };
  await writeFile(spec.promptPath, 'Synthetic task');
  await writeFile(spec.schema, '{}');
  const requests = [],
    events = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const emit = (m) => child.stdout.write(JSON.stringify(m) + '\n');
  child.stdin.on('data', (bytes) => {
    const m = JSON.parse(bytes.toString());
    requests.push(m);
    if (!m.method || m.id === undefined) return;
    queueMicrotask(() => {
      if (m.method === 'initialize') emit({ id: m.id, result: {} });
      if (m.method === 'project/read')
        emit(
          missingProject
            ? { id: m.id, error: { message: 'Configured project no longer exists' } }
            : { id: m.id, result: { project: { id: projectId } } },
        );
      if (m.method === 'thread/start')
        emit({
          id: m.id,
          result: {
            thread: { id: 'synthetic-thread', projectId: wrongProject ? null : projectId },
            approvalPolicy: wrongPermissions ? 'never' : 'on-request',
            approvalsReviewer: 'auto_review',
            sandbox: { type: 'workspaceWrite' },
            model: 'gpt-6-astra',
            reasoningEffort: 'medium',
          },
        });
      if (m.method === 'turn/start' || m.method === 'turn/steer') {
        if (m.method === 'turn/start') {
          emit({ id: m.id, result: { turn: { id: 'synthetic-turn' } } });
          if (steer) return;
        } else {
          emit(
            rejectSteering
              ? { id: m.id, error: { message: 'Turn has finished' } }
              : { id: m.id, result: { turnId: 'synthetic-turn' } },
          );
        }
        if (crash) {
          child.emit('close', 1);
          return;
        }
        emit({ id: 900, method: 'item/commandExecution/requestApproval', params: {} });
        emit({
          method: 'item/completed',
          params: {
            threadId: 'unrelated-thread',
            item: { type: 'agentMessage', phase: 'final_answer', text: 'wrong thread' },
          },
        });
        emit({
          method: 'item/completed',
          params: {
            threadId: 'synthetic-thread',
            item: {
              type: 'agentMessage',
              phase: 'final_answer',
              text: JSON.stringify({ status: 'ready', summary: 'Implemented' }),
            },
          },
        });
        emit({
          method: 'turn/completed',
          params: { threadId: 'synthetic-thread', turn: { id: 'synthetic-turn', status: 'completed' } },
        });
      }
    });
  });
  const deliveries = [];
  let supplied = false;
  const mailbox = {
    async next() {
      if (supplied) return null;
      supplied = true;
      return { message: { recordId: 'comment-one', text: 'Please use green' } };
    },
    async complete(item, state) {
      deliveries.push(state);
    },
  };
  const result = await runCodexTurn(
    spec,
    (event) => events.push(event),
    () => child,
    steer ? mailbox : null,
  );
  return { result, requests, events, deliveries };
}
test('app-server verifies permissions and declines any unhandled approval request', async (t) => {
  const { result, requests } = await fixture(t);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.summary, 'Implemented');
  const start = requests.find((m) => m.method === 'thread/start').params;
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.model, 'gpt-6-astra');
  assert.equal(requests.find((m) => m.method === 'turn/start').params.effort, 'medium');
  assert.deepEqual(requests.find((m) => m.id === 900).result, { decision: 'decline' });
});
test('permission downgrade fails before any agent turn', async (t) => {
  const { result, requests } = await fixture(t, { wrongPermissions: true });
  assert.equal(result.exitCode, -1);
  assert.match(result.failure, /did not grant/);
  assert.ok(!requests.some((m) => m.method === 'turn/start'));
});
test('app-server exit cannot be mistaken for completed work', async (t) => {
  const { result } = await fixture(t, { crash: true });
  assert.equal(result.exitCode, -1);
  assert.match(result.failure, /exited before/);
});

test('implementation defaults use Astra medium without changing global Codex preferences', () => {
  const params = threadParameters({ cwd: 'synthetic', packageStore: 'cache' });
  assert.equal(params.model, 'gpt-6-astra');
  assert.equal(params.config.model_reasoning_effort, 'medium');
  assert.equal(Object.hasOwn(params, 'projectId'), false);
});

test('explicit project groups the thread without changing its isolated workspace or permissions', async (t) => {
  const { result, requests, events } = await fixture(t, { projectId: 'suggestion-project' });
  assert.equal(result.exitCode, 0);
  const start = requests.find((m) => m.method === 'thread/start').params;
  assert.equal(start.projectId, 'suggestion-project');
  assert.ok(start.cwd.includes('suggestion-protocol-'));
  assert.equal(start.sandbox, 'workspace-write');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.equal(start.model, 'gpt-6-astra');
  assert.ok(
    requests.findIndex((m) => m.method === 'project/read') <
      requests.findIndex((m) => m.method === 'thread/start'),
  );
  assert.ok(events.some((e) => e.type === 'project.confirmed' && e.projectId === 'suggestion-project'));
});

test('missing configured project fails before creating a thread', async (t) => {
  const { result, requests } = await fixture(t, { projectId: 'deleted-project', missingProject: true });
  assert.equal(result.exitCode, -1);
  assert.match(result.failure, /no longer exists/);
  assert.ok(!requests.some((m) => m.method === 'thread/start' || m.method === 'turn/start'));
});

test('ignored project assignment fails before starting work', async (t) => {
  const { result, requests } = await fixture(t, { projectId: 'suggestion-project', wrongProject: true });
  assert.equal(result.exitCode, -1);
  assert.match(result.failure, /did not assign/);
  assert.ok(!requests.some((m) => m.method === 'turn/start'));
});

test('discussion steering targets the current turn and waits for acknowledged delivery', async (t) => {
  const f = await fixture(t, { steer: true });
  assert.equal(f.result.exitCode, 0);
  const steers = f.requests.filter((r) => r.method === 'turn/steer');
  assert.equal(steers.length, 1);
  assert.equal(steers[0].params.expectedTurnId, 'synthetic-turn');
  assert.equal(steers[0].params.threadId, 'synthetic-thread');
  assert.match(steers[0].params.input[0].text, /Please use green/);
  assert.deepEqual(f.deliveries, ['accepted']);
});
test('rejected steering is not reported as delivered or retried as another turn', async (t) => {
  const f = await fixture(t, { steer: true, rejectSteering: true });
  assert.deepEqual(f.deliveries, ['uncertain']);
  assert.equal(f.requests.filter((r) => r.method === 'turn/start').length, 1);
  assert.equal(f.requests.filter((r) => r.method === 'turn/steer').length, 1);
});
test('durable steering mailbox never resends an ambiguous dispatch after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'steering-mailbox-'));
  const verified = await realpath(root);
  t.after(async () => {
    assert.equal(await realpath(root), verified);
    await rm(root, { recursive: true, force: true });
  });
  await writeJson(join(root, 'steering-feed.json'), {
    messages: [{ recordId: 'comment-one', text: 'Correction' }],
  });
  const first = await steeringMailbox(root).next();
  assert.equal((await readJson(first.path)).state, 'uncertain');
  assert.equal(await steeringMailbox(root).next(), null);
  await steeringMailbox(root).complete(first, 'accepted');
  assert.equal(await steeringMailbox(root).next(), null);
});
