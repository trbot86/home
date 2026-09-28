import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, writeJson, createOnce, deliver, alive } from './journal.mjs';
import { releaseIdentity } from './release-executor.mjs';
export class ReleaseRunner {
  constructor(config, send) {
    this.config = config;
    this.send = send;
  }
  async tick() {
    const { release: job } = await this.send('releases', { expectedServerEpoch: this.config.serverEpoch });
    if (!job) return false;
    releaseIdentity(job);
    if (['prepared', 'uncertain'].includes(job.state)) return false;
    const phase = ['queued', 'preparing'].includes(job.state) ? 'prepare' : 'deploy';
    const directory = join(this.config.stateRoot, 'releases', 'jobs', job.releaseId, phase);
    const update = (name, payload) =>
      deliver(
        join(directory, name + '.json'),
        () => ({
          expectedServerEpoch: this.config.serverEpoch,
          releaseId: job.releaseId,
          expectedRevision: job.revision,
          ...payload,
        }),
        (request) => this.send('release-update', request),
      );
    if (['queued', 'deploy_queued'].includes(job.state)) {
      await update('started', {
        state: phase === 'prepare' ? 'preparing' : 'deploying',
        summary:
          phase === 'prepare'
            ? 'Integrating this suggestion and running release checks.'
            : 'Deploying the tested release; the server may reconnect briefly.',
      });
      return true;
    }
    const intent = await readJson(join(directory, 'launch-intent.json'));
    if (!intent) {
      // Credentials stay in the bridge process. The supervisor receives only local build paths.
      const { repository, stateRoot, pnpmEntry } = this.config;
      await writeJson(join(directory, 'launch.json'), {
        phase,
        job,
        config: { repository, stateRoot, pnpmEntry },
      });
      if (!(await createOnce(join(directory, 'launch-intent.json'), { at: Date.now() }))) return true;
      const log = openSync(join(directory, 'supervisor.log'), 'a', 0o600);
      try {
        const child = spawn(
          process.execPath,
          [resolve(import.meta.dirname, 'release-supervisor.mjs'), directory],
          { detached: true, stdio: ['ignore', log, log], windowsHide: true },
        );
        child.on('error', () => {});
        child.unref();
      } finally {
        closeSync(log);
      }
      return true;
    }
    const result = await readJson(join(directory, 'result.json'));
    if (result) {
      await update('finished', result);
      return true;
    }
    const owner = await readJson(join(directory, 'owner.json'));
    if ((!owner || !alive(owner.pid)) && Date.now() - intent.at > 20000)
      await update('interrupted', {
        state: 'uncertain',
        summary:
          'The release process was interrupted. Its files and diagnostics are preserved; host inspection is required before another release.',
      });
    return true;
  }
}
