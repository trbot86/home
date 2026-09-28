import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson, acquireLock, deliver } from './suggestion-bridge/journal.mjs';
import { SuggestionRunner } from './suggestion-bridge/runner.mjs';
import { ReleaseRunner } from './suggestion-bridge/release-runner.mjs';

const configPath = resolve(process.argv[2] ?? '.local/suggestion-bridge/config.json');
const config = await readJson(configPath);
if (
  !config ||
  !config.origin ||
  !config.secret ||
  !config.serverEpoch ||
  !config.stateRoot ||
  !config.repository ||
  !config.codexExecutable
)
  throw new Error('Suggestion bridge configuration is incomplete');
if (
  config.codexProjectId !== undefined &&
  (typeof config.codexProjectId !== 'string' || !config.codexProjectId.trim())
)
  throw new Error('codexProjectId must be a nonempty app-server project ID');
const origin = new URL(config.origin);
if (
  origin.origin !== config.origin ||
  (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))
)
  throw new Error('Invalid private server origin');
const root = resolve(config.stateRoot),
  release = await acquireLock(join(root, 'bridge.lock'));
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
async function send(path, payload, binary = false) {
  const response = await fetch(config.origin + '/api/suggestion-agent/' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.secret, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ code: 'agent_request_failed' }));
    throw new Error(error.code ?? 'agent_request_failed');
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
}
const runner = new SuggestionRunner(config, send);
const releases = new ReleaseRunner(config, send);
try {
  while (!stopping) {
    try {
      const { runs, queued } = await send('status', {
        expectedServerEpoch: config.serverEpoch,
        acceptingWork: config.enabled === true,
      });
      if (runs.length) {
        for (const run of runs) await runner.tick(run);
      } else if (config.releasesEnabled === true && (await releases.tick())) {
        // The single release slot owns integration until it completes or is cancelled.
      } else if (config.enabled === true && queued) {
        // Keep one durable claim pending until its response is reconciled.
        let poll = await readJson(join(root, 'poll.json'));
        if (!poll) {
          poll = { id: randomUUID() };
          await writeJson(join(root, 'poll.json'), poll);
        }
        const result = await deliver(
          join(root, 'claims', poll.id + '.json'),
          () => ({ operationId: poll.id, expectedServerEpoch: config.serverEpoch }),
          (request) => send('claim', request),
        );
        if (result.run) await runner.tick(result.run);
        await writeJson(join(root, 'poll.json'), { id: randomUUID() });
      }
      await writeJson(join(root, 'health.json'), { checkedAt: Date.now(), issue: null });
    } catch (error) {
      await writeJson(join(root, 'health.json'), { checkedAt: Date.now(), issue: error.message });
      // Recovery/revocation needs deliberate host reconciliation, never credential fallback.
      if (['recovery_required', 'authentication_required'].includes(error.message)) throw error;
    }
    if (process.argv.includes('--once')) break;
    await delay(5000);
  }
} finally {
  await release();
}
