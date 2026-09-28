import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, lstat, appendFile } from 'node:fs/promises';
import { resolve, join, dirname, delimiter } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from './journal.mjs';
const exec = promisify(execFile);
const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export class ReleaseCheckError extends Error {}
// Release requests contain identifiers, never executable commands or filesystem paths.
export function releaseIdentity(job) {
  for (const value of [
    job.releaseId,
    job.suggestionId,
    job.runId,
    ...(job.members || []).flatMap((m) => [m.suggestionId, m.runId]),
  ])
    if (!/^[a-f0-9-]{36}$/.test(value)) throw new ReleaseCheckError('Invalid release identity.');
  return job;
}
export function reviewPaths(paths, sourceCommit, approvals = []) {
  return paths.every(
    (p) =>
      /^(?:apps\/web\/(?:src|public|test)\/|apps\/server\/(?:src|test|migrations)\/|apps\/android\/app\/src\/|packages\/(?:contracts|client)\/|tests\/|scripts\/verify-[\w-]+\.mjs$)/.test(
        p,
      ) ||
      /^[A-Z_]+\.md$/.test(p) ||
      approvals.some(
        (a) =>
          a.sourceCommit === sourceCommit &&
          /^[a-f0-9]{40}$/.test(a.sourceCommit) &&
          Array.isArray(a.paths) &&
          a.paths.includes(p),
      ),
  );
}
export function reviewedIntegration(reviewed, baseCommit, sources) {
  if (
    !reviewed ||
    reviewed.baseCommit !== baseCommit ||
    JSON.stringify(reviewed.sources) !== JSON.stringify(sources)
  )
    return null;
  if (!/^[a-f0-9]{40}$/.test(reviewed.candidateCommit))
    throw new ReleaseCheckError('Invalid reviewed integration commit.');
  return reviewed.candidateCommit;
}
export class ReleaseExecutor {
  constructor(config, job, log) {
    this.config = config;
    this.job = releaseIdentity(job);
    this.log = log;
    this.repo = resolve(config.repository);
    this.root = resolve(config.stateRoot, 'releases');
    this.cwd = join(this.root, 'workspace');
    this.branch = 'codex/release-' + job.releaseId;
    this.env = { ...process.env, npm_config_store_dir: join(config.stateRoot, 'package-store') };
    const pathKey = Object.keys(this.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
    this.env[pathKey] = dirname(process.execPath) + delimiter + (this.env[pathKey] || '');
    this.env.CI = 'true';
  }
  async run(file, args, cwd = this.repo, env = this.env) {
    try {
      const out = await exec(file, args, { cwd, env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      await appendFile(this.log, out.stdout + out.stderr);
      return out.stdout.trim();
    } catch (e) {
      await appendFile(this.log, (e.stdout || '') + (e.stderr || '') + '\n' + e.message + '\n');
      throw new ReleaseCheckError(
        `${this.phase || 'Release preparation'} failed. Nothing further was run. Diagnostic output was retained on the development host.`,
      );
    }
  }
  git(...args) {
    return this.run('git', args);
  }
  treeGit(...args) {
    return this.run('git', args, this.cwd);
  }
  docker(...args) {
    return this.run('docker', args);
  }
  async cleanBase(expected) {
    if (await this.git('status', '--porcelain=v1', '--untracked-files=all'))
      throw new ReleaseCheckError(
        'Development changes are still in progress. Commit them before preparing or deploying a release.',
      );
    const head = await this.git('rev-parse', 'HEAD');
    if (expected && head !== expected)
      throw new ReleaseCheckError(
        'The app source changed after preparation. Cancel this release and prepare it again.',
      );
    return head;
  }
  async liveImage() {
    const host = await readJson(join(this.repo, '.local/phone-trial/host.json'));
    if (!host || !same(host.workspace, this.repo))
      throw new ReleaseCheckError('The local household configuration needs review.');
    const info = JSON.parse(await this.docker('inspect', host.container))[0];
    if (
      info.Config.Labels['com.our-place.role'] !== 'phone-trial' ||
      !same(info.Config.Labels['com.our-place.workspace'], this.repo)
    )
      throw new ReleaseCheckError('The running app does not belong to this workspace.');
    return info.Image;
  }
  async pruneImages(keep) {
    const ids = (
      await this.docker(
        'image',
        'ls',
        '--filter',
        'label=com.our-place.release=true',
        '--quiet',
        '--no-trunc',
      )
    )
      .split('\n')
      .filter(Boolean);
    for (const id of new Set(ids)) {
      if (keep.includes(id)) continue;
      // No force and no global prune: an image still tagged or used by a container stays put.
      try {
        await this.docker('image', 'rm', id);
      } catch {
        /* Docker retains referenced images. */
      }
    }
  }
  async workspace(baseCommit) {
    await mkdir(this.root, { recursive: true });
    const previous = await readJson(join(this.root, 'slot.json'));
    const exists = await lstat(this.cwd).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (exists) {
      if (
        !previous ||
        exists.isSymbolicLink() ||
        !same(dirname(await realpath(this.cwd)), await realpath(this.root)) ||
        (await this.treeGit('symbolic-ref', '--short', 'HEAD')) !== previous.branch
      )
        throw new ReleaseCheckError('The release workspace needs inspection before reuse.');
      if (await this.treeGit('status', '--porcelain=v1', '--untracked-files=all'))
        throw new ReleaseCheckError(
          'Uncommitted release work was preserved. Review it on the development host before retrying.',
        );
      const common = resolve(this.cwd, await this.treeGit('rev-parse', '--git-common-dir'));
      if (!same(common, resolve(this.repo, await this.git('rev-parse', '--git-common-dir'))))
        throw new ReleaseCheckError('Release workspace repository mismatch.');
      // Reuse dependency caches without traversing Windows pnpm junction cycles.
      // Refuse to overwrite ignored files if a new source path would collide with them.
      await this.treeGit('checkout', '--no-overwrite-ignore', '-b', this.branch, baseCommit);
    } else {
      await this.git('worktree', 'add', '-b', this.branch, this.cwd, baseCommit);
    }
    await writeJson(join(this.root, 'slot.json'), { releaseId: this.job.releaseId, branch: this.branch });
  }
  async prepare() {
    const baseCommit = await this.cleanBase(),
      previousImageId = await this.liveImage();
    const sources = [];
    for (const member of this.job.members || [this.job]) {
      const publication = await readJson(join(this.config.stateRoot, 'runs', member.runId, 'published.json'));
      if (!publication)
        throw new ReleaseCheckError(
          'An agent result has not yet been reconciled on this host. Retry once the host has published it.',
        );
      const sourceCommit = await this.git('rev-parse', 'refs/heads/codex/suggestion-' + member.suggestionId);
      const mergeBase = await this.git('merge-base', baseCommit, sourceCommit);
      const changed = (await this.git('diff', '--name-only', mergeBase, sourceCommit))
        .split('\n')
        .filter(Boolean);
      if (!changed.length)
        throw new ReleaseCheckError(
          'A suggestion has no new committed source changes. The batch needs review.',
        );
      const approvals = (await readJson(join(this.root, 'reviewed-changes.json'))) || [];
      if (!Array.isArray(approvals) || !reviewPaths(changed, sourceCommit, approvals))
        throw new ReleaseCheckError(
          'A suggestion changes build or host configuration. The batch needs coordinated developer review.',
        );
      sources.push({ suggestionId: member.suggestionId, runId: member.runId, sourceCommit });
    }
    this.phase = 'Integration';
    const reviewed = await readJson(join(this.root, 'reviewed-integration.json'));
    const candidate = reviewedIntegration(reviewed, baseCommit, sources);
    if (candidate) {
      // A developer-resolved merge must contain every exact input. It still
      // undergoes the complete audit, build and test sequence below.
      for (const input of [baseCommit, ...sources.map((s) => s.sourceCommit)])
        await this.git('merge-base', '--is-ancestor', input, candidate);
    }
    await this.workspace(candidate || baseCommit);
    for (const source of candidate ? [] : sources) {
      try {
        await this.treeGit('merge', '--no-ff', '--no-edit', source.sourceCommit);
      } catch {
        await this.treeGit('merge', '--abort');
        throw new ReleaseCheckError(
          'A suggestion conflicts with another change in this update. The batch was held for integration repair; nothing was deployed.',
        );
      }
    }
    await this.run(
      process.execPath,
      [join(this.repo, 'scripts/check-public-source.mjs'), '--staged'],
      this.cwd,
    );
    const candidateCommit = await this.treeGit('rev-parse', 'HEAD');
    this.phase = 'Server build and package tests';
    // Docker build runs the server, contracts, client and Alexa tests in isolated databases.
    await this.docker(
      'build',
      '--label',
      'com.our-place.release=true',
      '--label',
      'org.opencontainers.image.revision=' + candidateCommit,
      '-t',
      'our-place:suggestion-prepared',
      this.cwd,
    );
    const imageId = await this.docker(
      'image',
      'inspect',
      'our-place:suggestion-prepared',
      '--format',
      '{{.Id}}',
    );
    const retained = await this.docker(
      'image',
      'inspect',
      'our-place:suggestion-previous',
      '--format',
      '{{.Id}}',
    ).catch(() => null);
    await this.pruneImages([imageId, previousImageId, retained]);
    if (!this.config.pnpmEntry)
      throw new ReleaseCheckError('The release host needs its package-manager path configured.');
    const pnpm = (...args) => this.run(process.execPath, [this.config.pnpmEntry, ...args], this.cwd);
    this.phase = 'Dependency installation';
    await pnpm('install', '--frozen-lockfile');
    this.phase = 'Type and architecture checks';
    await pnpm('-r', 'typecheck');
    await this.run(process.execPath, ['scripts/check-boundaries.mjs'], this.cwd);
    this.phase = 'Web build';
    await pnpm('--filter', '@our-place/web', 'build');
    await this.run(
      process.execPath,
      ['node_modules/@capacitor/cli/bin/capacitor', 'sync', 'android'],
      this.cwd,
    );
    this.phase = 'Android build and tests';
    // Use the shared SDK, Gradle cache and original signing identity, never copies per suggestion.
    const host = await readJson(join(this.repo, '.local/phone-trial/host.json'));
    await this.run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(this.repo, 'scripts/android-build.ps1'),
      '-SourceRoot',
      this.cwd,
      '-ServerOrigin',
      host.origin,
    ]);
    this.phase = 'Browser regression tests';
    await this.run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], this.cwd, {
      ...this.env,
      OUR_PLACE_BROWSER_CACHE: join(this.repo, '.cache/playwright'),
    });
    if (await this.treeGit('status', '--porcelain=v1', '--untracked-files=all'))
      throw new ReleaseCheckError(
        'A build changed tracked source files. The candidate needs developer review.',
      );
    return {
      baseCommit,
      sourceCommit: sources[0].sourceCommit,
      sources,
      candidateCommit,
      imageId,
      previousImageId,
      apkSha256: hash(
        await readFile(join(this.cwd, 'apps/android/app/build/outputs/apk/debug/app-debug.apk')),
      ),
      checks: [
        'Source privacy audit',
        'Server, contracts and client tests in Docker',
        'Type and module-boundary checks',
        'Android build and unit tests',
        'Browser regression checks',
      ],
      preparedAt: Date.now(),
    };
  }
  async deploy() {
    const m = this.job.manifest;
    if (!m || hash(Buffer.from(JSON.stringify(m))) !== this.job.manifestDigest)
      throw new ReleaseCheckError('The prepared release manifest could not be verified.');
    await this.cleanBase(m.baseCommit);
    if ((await this.liveImage()) !== m.previousImageId)
      throw new ReleaseCheckError(
        'The running app changed after preparation. Cancel this release and prepare it again.',
      );
    if (
      (await this.treeGit('rev-parse', 'HEAD')) !== m.candidateCommit ||
      (await this.treeGit('status', '--porcelain=v1', '--untracked-files=all'))
    )
      throw new ReleaseCheckError('The prepared source changed. Prepare a fresh release.');
    if (
      hash(await readFile(join(this.cwd, 'apps/android/app/build/outputs/apk/debug/app-debug.apk'))) !==
      m.apkSha256
    )
      throw new ReleaseCheckError('The prepared Android package changed. Prepare a fresh release.');
    if ((await this.docker('image', 'inspect', m.imageId, '--format', '{{.Id}}')) !== m.imageId)
      throw new ReleaseCheckError('The tested server image is no longer available.');
    // Only this trusted host program invokes upgrade. It verifies a backup and installation identity.
    const env = { ...this.env, OUR_PLACE_IMAGE: m.imageId, OUR_PLACE_CLIENT_SOURCE: this.cwd };
    await this.docker('tag', m.previousImageId, 'our-place:suggestion-previous');
    await this.run(process.execPath, ['scripts/dev-host.mjs', 'upgrade'], this.repo, env);
    await this.run(process.execPath, ['scripts/dev-host.mjs', 'publish-client'], this.repo, env);
    if ((await this.liveImage()) !== m.imageId)
      throw new ReleaseCheckError(
        'The expected server image is not running; inspect the deployment on the host.',
      );
    // Never reset or overwrite unrelated development changes. If integration cannot finish, report it.
    await this.cleanBase(m.baseCommit);
    await this.git('merge', '--ff-only', m.candidateCommit);
    await this.docker('tag', m.imageId, 'our-place:development');
    // Replication is independent of primary retention; a failure is a visible release failure.
    await this.run(process.execPath, ['--import', 'tsx', 'scripts/replicate-backups.ts']);
    return {};
  }
}
