import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, lstat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ReleaseExecutor, reviewPaths } from './release-executor.mjs';
import { ReleaseRunner } from './release-runner.mjs';
import { writeJson, readJson } from './journal.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const temp = () => mkdtemp(join(tmpdir(), 'our-place-release-test-'));
test('one release checkout reuses caches without traversing junctions or deleting ignored notes', async () => {
  const root = await temp(),
    repo = join(root, 'repo');
  try {
    await mkdir(repo);
    const git = async (...args) =>
      (await promisify(execFile)('git', args, { cwd: repo, windowsHide: true })).stdout.trim();
    await git('init', '-q');
    await git('config', 'user.name', 'Release fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n.cache/\n');
    await writeFile(join(repo, 'source.txt'), 'committed fixture');
    await git('add', '.');
    await git('commit', '-qm', 'Fixture base');
    const base = await git('rev-parse', 'HEAD'),
      config = { repository: repo, stateRoot: join(root, 'state') };
    const job = () => ({ releaseId: randomUUID(), suggestionId: randomUUID(), runId: randomUUID() });
    const first = new ReleaseExecutor(config, job(), join(root, 'commands.log'));
    await first.workspace(base);
    await mkdir(join(first.cwd, 'node_modules'));
    await symlink(
      first.cwd,
      join(first.cwd, 'node_modules', 'cycle'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await mkdir(join(first.cwd, '.cache'));
    await writeFile(join(first.cwd, '.cache', 'note.txt'), 'preserve this');
    const second = new ReleaseExecutor(config, job(), join(root, 'commands.log'));
    await second.workspace(base);
    assert.equal(await readFile(join(second.cwd, '.cache', 'note.txt'), 'utf8'), 'preserve this');
    assert.equal((await lstat(join(second.cwd, 'node_modules', 'cycle'))).isSymbolicLink(), true);
    assert.equal(await second.treeGit('symbolic-ref', '--short', 'HEAD'), second.branch);
    assert.equal(await git('rev-parse', first.branch), base, 'earlier source branch remains');
  } finally {
    await cleanup(root);
  }
});
async function cleanup(root) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('our-place-release-test-'))
    throw new Error('Unsafe test cleanup');
  await rm(root, { recursive: true, force: true });
}
test('release paths admit app changes and require review of build or host control changes', () => {
  assert.equal(reviewPaths(['apps/web/src/ui/food/Food.tsx', 'scripts/verify-android-food.mjs']), true);
  for (const path of [
    'scripts/dev-host.mjs',
    'scripts/suggestion-bridge/runner.mjs',
    'ops/compose.dev.yaml',
    'Dockerfile',
    'package.json',
    '.local/host.json',
    'apps/android/gradlew.bat',
  ])
    assert.equal(reviewPaths([path]), false, path);
});
test('deployment verifies source, server image and APK before touching the host', async () => {
  const root = await temp();
  try {
    const config = { repository: root, stateRoot: join(root, 'state') };
    const manifest = {
      baseCommit: 'a'.repeat(40),
      sourceCommit: 'b'.repeat(40),
      candidateCommit: 'c'.repeat(40),
      imageId: 'sha256:' + 'd'.repeat(64),
      previousImageId: 'sha256:' + 'e'.repeat(64),
      apkSha256: hash('apk'),
      checks: ['Fixture'],
      preparedAt: 1000,
    };
    const job = {
      releaseId: randomUUID(),
      suggestionId: randomUUID(),
      runId: randomUUID(),
      manifest,
      manifestDigest: hash(JSON.stringify(manifest)),
    };
    const events = [];
    class FakeExecutor extends ReleaseExecutor {
      current = manifest.previousImageId;
      async cleanBase(expected) {
        assert.equal(expected, manifest.baseCommit);
      }
      async liveImage() {
        return this.current;
      }
      async treeGit(...args) {
        return args[0] === 'rev-parse' ? manifest.candidateCommit : '';
      }
      async docker(...args) {
        events.push(args);
        return manifest.imageId;
      }
      async git(...args) {
        events.push(args);
        return '';
      }
      async run(_file, args) {
        events.push(args);
        if (args[1] === 'upgrade') this.current = manifest.imageId;
        return '';
      }
    }
    const executor = new FakeExecutor(config, job, join(root, 'log'));
    const apk = join(executor.cwd, 'apps/android/app/build/outputs/apk/debug/app-debug.apk');
    await mkdir(join(apk, '..'), { recursive: true });
    await writeFile(apk, 'tampered');
    await assert.rejects(executor.deploy(), /Android package changed/);
    assert.equal(events.length, 0);
    await writeFile(apk, 'apk');
    executor.current = 'sha256:' + 'f'.repeat(64);
    await assert.rejects(executor.deploy(), /running app changed/);
    assert.equal(events.length, 0);
    executor.current = manifest.previousImageId;
    await executor.deploy();
    const commands = events.map((e) => e.join(' '));
    assert.ok(
      commands.indexOf('scripts/dev-host.mjs upgrade') <
        commands.indexOf('scripts/dev-host.mjs publish-client'),
    );
    assert.ok(commands.some((c) => c === 'merge --ff-only ' + manifest.candidateCommit));
    assert.ok(commands.some((c) => c === '--import tsx scripts/replicate-backups.ts'));
  } finally {
    await cleanup(root);
  }
});
test('release runner reconciles lost acknowledgements and never relaunches an interrupted process', async () => {
  const root = await temp();
  try {
    const config = { repository: root, stateRoot: root, serverEpoch: 'fixture' };
    let job = {
      releaseId: randomUUID(),
      suggestionId: randomUUID(),
      runId: randomUUID(),
      revision: 1,
      state: 'queued',
    };
    let loseAck = true;
    const send = async (path, payload) => {
      if (path === 'releases') return { release: job };
      assert.equal(payload.expectedRevision, job.revision);
      job = { ...job, ...payload, revision: job.revision + 1 };
      if (loseAck) {
        loseAck = false;
        throw new Error('Lost acknowledgement');
      }
      return job;
    };
    const runner = new ReleaseRunner(config, send);
    await assert.rejects(runner.tick(), /Lost acknowledgement/);
    assert.equal(job.state, 'preparing');
    const directory = join(root, 'releases/jobs', job.releaseId, 'prepare');
    await writeJson(join(directory, 'launch-intent.json'), { at: 0 });
    await runner.tick();
    assert.equal(job.state, 'uncertain');
    assert.equal(await readJson(join(directory, 'launch.json')), null, 'uncertain launch is not retried');
    assert.equal(await runner.tick(), false, 'other coding work can continue');
  } finally {
    await cleanup(root);
  }
});
