import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCodexTurn } from './app-server.mjs';

async function fixture(t, { wrongPermissions = false, crash = false } = {}) {
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
      if (m.method === 'thread/start')
        emit({
          id: m.id,
          result: {
            thread: { id: 'synthetic-thread' },
            approvalPolicy: wrongPermissions ? 'never' : 'on-request',
            approvalsReviewer: 'auto_review',
            sandbox: { type: 'workspaceWrite' },
          },
        });
      if (m.method === 'turn/start') {
        emit({ id: m.id, result: { turn: { id: 'synthetic-turn' } } });
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
  const result = await runCodexTurn(
    spec,
    (event) => events.push(event),
    () => child,
  );
  return { result, requests, events };
}
test('app-server verifies permissions and declines any unhandled approval request', async (t) => {
  const { result, requests } = await fixture(t);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.summary, 'Implemented');
  const start = requests.find((m) => m.method === 'thread/start').params;
  assert.equal(start.approvalPolicy, 'on-request');
  assert.equal(start.approvalsReviewer, 'auto_review');
  assert.equal(start.sandbox, 'workspace-write');
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
