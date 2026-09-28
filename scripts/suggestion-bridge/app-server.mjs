import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export function threadParameters(spec) {
  return {
    cwd: spec.cwd,
    model: spec.model ?? 'gpt-6-astra',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
    experimentalRawEvents: false,
    persistExtendedHistory: false,
    config: {
      model_reasoning_effort: spec.reasoningEffort ?? 'medium',
      'sandbox_workspace_write.writable_roots': [spec.packageStore],
      'sandbox_workspace_write.network_access': false,
      ...(process.platform === 'win32' ? { 'windows.sandbox': 'elevated' } : {}),
    },
  };
}

/** Local stdio only. Codex's reviewer handles escalations; this adapter never approves them. */
export async function runCodexTurn(spec, record, spawnProcess = spawn) {
  const child = spawnProcess(spec.executable, ['app-server', '--listen', 'stdio://'], {
    cwd: spec.cwd,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_store_dir: spec.packageStore, OUR_PLACE_SUGGESTION_RUN: spec.runId },
  });
  let sequence = 0,
    buffer = '',
    stderr = '',
    sessionId = null,
    finalText = null,
    finished = false;
  const pending = new Map();
  let complete, fail;
  const completion = new Promise((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  // Requests can fail before the caller starts awaiting the completion notification.
  completion.catch(() => {});
  function stop(error) {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
    fail(error);
  }
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  function request(method, params) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('Codex request timed out: ' + method));
      }, 60000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }
  function receive(message) {
    if (message.id !== undefined && !message.method) {
      const p = pending.get(message.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(message.id);
      if (message.error) p.reject(new Error(message.error.message));
      else p.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      // An eligible automatic review is resolved inside Codex. Never turn fallback requests into a blanket approval.
      record({ type: 'approval.fallback', method: message.method });
      if (
        ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)
      )
        send({ id: message.id, result: { decision: 'decline' } });
      else if (message.method === 'item/tool/requestUserInput')
        send({ id: message.id, result: { answers: {} } });
      else if (message.method === 'mcpServer/elicitation/request')
        send({ id: message.id, result: { action: 'decline', content: null } });
      else
        send({
          id: message.id,
          error: {
            code: -32601,
            message:
              'Unattended bridge cannot authorize this request. Ask in the saved suggestion discussion.',
          },
        });
      return;
    }
    const p = message.params;
    if (p?.threadId && sessionId && p.threadId !== sessionId) return;
    if (message.method === 'item/completed' && p?.item?.type === 'agentMessage') {
      record({ type: 'item.completed', item: { type: 'agent_message', text: p.item.text } });
      if (p.item.phase === 'final_answer' || p.item.phase === null) finalText = p.item.text;
    }
    if (message.method === 'item/autoApprovalReview/completed')
      record({ type: 'approval.reviewed', review: p });
    if (message.method === 'turn/completed') {
      record({ type: 'turn.completed', status: p.turn.status });
      if (p.turn.status === 'completed') {
        finished = true;
        complete();
      } else fail(new Error(p.turn.error?.message ?? 'Codex turn ' + p.turn.status));
    }
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) return stop(new Error('Codex protocol buffer exceeded limit'));
    const lines = buffer.split('\n');
    buffer = lines.pop();
    try {
      for (const line of lines) if (line.trim()) receive(JSON.parse(line));
    } catch (error) {
      stop(error);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8000);
  });
  child.stdin.on('error', stop);
  child.on('error', stop);
  child.on('close', () => {
    if (!finished) stop(new Error('Codex app-server exited before turn completion'));
  });
  try {
    await request('initialize', {
      clientInfo: { name: 'our_place_suggestion_bridge', version: '0.2.0' },
      capabilities: { experimentalApi: true },
    });
    send({ method: 'initialized', params: {} });
    const thread = await request('thread/start', threadParameters(spec));
    sessionId = thread.thread.id;
    record({ type: 'thread.started', thread_id: sessionId });
    record({
      type: 'permissions.confirmed',
      approvalPolicy: thread.approvalPolicy,
      approvalsReviewer: thread.approvalsReviewer,
      sandbox: thread.sandbox,
      model: thread.model,
      reasoningEffort: thread.reasoningEffort,
    });
    if (
      thread.approvalPolicy !== 'on-request' ||
      thread.approvalsReviewer !== 'auto_review' ||
      thread.sandbox?.type !== 'workspaceWrite'
    )
      throw new Error('Codex did not grant the requested writable workspace and automatic review');
    if (
      thread.model !== (spec.model ?? 'gpt-6-astra') ||
      thread.reasoningEffort !== (spec.reasoningEffort ?? 'medium')
    )
      throw new Error('Codex did not select the requested implementation model and reasoning effort');
    await request('turn/start', {
      threadId: sessionId,
      effort: spec.reasoningEffort ?? 'medium',
      input: [{ type: 'text', text: await readFile(spec.promptPath, 'utf8'), text_elements: [] }],
      outputSchema: JSON.parse(await readFile(spec.schema, 'utf8')),
    });
    await completion;
    return {
      exitCode: 0,
      sessionId,
      output: JSON.parse(finalText),
      failure: null,
      stderr,
      finishedAt: Date.now(),
    };
  } catch (error) {
    return { exitCode: -1, sessionId, output: null, failure: error.message, stderr, finishedAt: Date.now() };
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    child.stdin.end();
    // The turn is finished or failed; stop this dedicated local server only.
    child.kill();
  }
}
