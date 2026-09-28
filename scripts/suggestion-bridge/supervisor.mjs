import { spawn } from 'node:child_process';
import { appendFileSync, openSync, closeSync, fsyncSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOnce, readJson, writeJson } from './journal.mjs';
import { runCodexTurn } from './app-server.mjs';
import { steeringMailbox } from './steering.mjs';

/** Detached from the polling bridge. Its journal remains inspectable across bridge restarts. */
export async function supervise(directory) {
  const spec = await readJson(join(directory, 'launch.json'));
  if (
    !spec ||
    !(await createOnce(join(directory, 'supervisor.json'), { pid: process.pid, nonce: spec.nonce }))
  )
    return;
  const events = join(directory, 'events.jsonl');
  function record(event) {
    const fd = openSync(events, 'a', 0o600);
    try {
      appendFileSync(fd, JSON.stringify(event) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  if (spec.transport === 'app-server') {
    await writeJson(
      join(directory, 'terminal.json'),
      await runCodexTurn(spec, record, spawn, spec.liveSteering ? steeringMailbox(directory) : null),
    );
    return;
  }
  // Reconcile already-dispatched legacy runs without changing their launch contract.
  let sessionId = null,
    buffer = '',
    stderr = '',
    failure = null;
  try {
    const child = spawn(spec.executable, spec.arguments, {
      cwd: spec.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, OUR_PLACE_SUGGESTION_RUN: spec.runId },
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'thread.started') sessionId = event.thread_id;
        if (
          ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type) ||
          (event.type === 'item.completed' && event.item?.type === 'agent_message')
        )
          record(event);
      }
      if (buffer.length > 8 * 1024 * 1024) {
        buffer = '';
        failure = 'An agent output line exceeded the journal limit';
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(readFileSync(spec.promptPath));
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    let output = null;
    try {
      output = JSON.parse(readFileSync(spec.outputPath, 'utf8'));
    } catch {
      failure ??= 'The agent did not return a valid structured result';
    }
    await writeJson(join(directory, 'terminal.json'), {
      exitCode: code,
      sessionId,
      output,
      failure,
      stderr,
      finishedAt: Date.now(),
    });
  } catch (error) {
    await writeJson(join(directory, 'terminal.json'), {
      exitCode: -1,
      sessionId,
      output: null,
      failure: error.message,
      stderr,
      finishedAt: Date.now(),
    });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await supervise(resolve(process.argv[2]));
