import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './journal.mjs';
const exec = promisify(execFile);
const git = async (cwd, ...args) =>
  // Dependency trees routinely exceed Windows' legacy path limit. Apply this to
  // inspection and removal alike, without changing the user's global Git config.
  (
    await exec('git', ['-c', 'core.longpaths=true', ...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const safeId = (id) => {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid suggestion identity');
  return id;
};
// Only known, reproducible output and the bridge's own copied inputs may be discarded.
// In particular, an arbitrary ignored note, database, key or .local file pins the checkout.
const disposable = (path) =>
  /^(?:node_modules|\.pnpm-store|\.cache|dist|coverage|playwright-report|test-results)\/$/.test(path) ||
  /^(?:apps|packages)\/[^/]+\/(?:node_modules|dist|build)\/$/.test(path) ||
  /^apps\/android\/(?:\.gradle|build|app\/build)\/$/.test(path) ||
  /^apps\/android\/app\/src\/main\/assets\/(?:public\/|capacitor\.(?:config|plugins)\.json)$/.test(path) ||
  /^\.local\/suggestion-input\//.test(path);

export class WorktreeCapacityError extends Error {
  constructor() {
    super(
      'All development workspace slots contain active, uncertain or uncommitted work. Their files are preserved. Review or commit that work before retrying.',
    );
  }
}

export class SuggestionWorktrees {
  constructor(config) {
    this.config = config;
    this.root = resolve(config.stateRoot, 'worktrees');
    this.limit = config.maxWorktrees ?? 3;
    if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 20)
      throw new Error('maxWorktrees must be an integer from 1 to 20');
  }
  async verify(directory, id) {
    if (
      (await lstat(directory)).isSymbolicLink() ||
      !samePath(dirname(await realpath(directory)), await realpath(this.root))
    )
      throw new Error('Worktree path is outside the managed directory');
    const common = resolve(directory, await git(directory, 'rev-parse', '--git-common-dir'));
    const expected = resolve(
      this.config.repository,
      await git(this.config.repository, 'rev-parse', '--git-common-dir'),
    );
    if (
      !samePath(common, expected) ||
      (await git(directory, 'symbolic-ref', '--short', 'HEAD')) !== 'codex/suggestion-' + safeId(id)
    )
      throw new Error('Worktree identity mismatch');
  }
  async protectedDirectories() {
    const protectedPaths = new Set();
    const runs = join(this.config.stateRoot, 'runs');
    for (const entry of await readdir(runs, { withFileTypes: true }).catch((e) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    })) {
      if (!entry.isDirectory()) continue;
      const directory = join(runs, entry.name);
      const launch = await readJson(join(directory, 'launch.json'));
      if (!launch) continue;
      // A final result does not free a checkout until the server publication is acknowledged.
      if (!(await readJson(join(directory, 'published.json')))) protectedPaths.add(resolve(launch.cwd));
    }
    return protectedPaths;
  }
  async recyclable(directory, id, protectedPaths) {
    if ([...protectedPaths].some((p) => samePath(p, directory))) return false;
    await this.verify(directory, id);
    // First reject tracked changes and any non-ignored untracked files.
    if (await git(directory, 'status', '--porcelain=v1', '--untracked-files=all')) return false;
    // Enumerate ignored files individually: a broad ignored .local directory cannot hide user work.
    const ignored = (await git(directory, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'))
      .split('\0')
      .filter(Boolean);
    return ignored.every(
      (path) =>
        disposable(path) ||
        path.split('/').some((_, i, parts) => disposable(parts.slice(0, i + 1).join('/') + '/')),
    );
  }
  async acquire(id) {
    safeId(id);
    await mkdir(this.root, { recursive: true });
    const branch = 'codex/suggestion-' + id;
    const entries = await readdir(this.root, { withFileTypes: true });
    const slots = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{8,80}$/.test(entry.name)) continue;
      const directory = join(this.root, entry.name);
      const current = await git(directory, 'symbolic-ref', '--short', 'HEAD');
      if (!current.startsWith('codex/suggestion-')) throw new Error('Worktree identity mismatch');
      const currentId = safeId(current.slice('codex/suggestion-'.length));
      await this.verify(directory, currentId);
      if (currentId === id) return directory;
      slots.push({ directory, currentId });
    }
    const exists = await git(this.config.repository, 'branch', '--list', branch);
    if (entries.length >= this.limit) {
      const protectedPaths = await this.protectedDirectories();
      for (const { directory, currentId } of slots) {
        if (!(await this.recyclable(directory, currentId, protectedPaths))) continue;
        await writeJson(join(this.config.stateRoot, 'retained-branches', currentId + '.json'), {
          branch: 'codex/suggestion-' + currentId,
          revision: await git(directory, 'rev-parse', 'HEAD'),
          recycledAt: Date.now(),
        });
        // Reuse the physical slot and caches. Git handles tracked files only;
        // Windows dependency junctions and open cache files are never deleted.
        // Refuse any target source file that would overwrite an ignored file.
        await this.verify(directory, currentId);
        if (exists) await git(directory, 'checkout', '--no-overwrite-ignore', branch);
        else
          await git(
            directory,
            'checkout',
            '--no-overwrite-ignore',
            '-b',
            branch,
            await git(this.config.repository, 'rev-parse', 'HEAD'),
          );
        await this.verify(directory, id);
        return directory;
      }
      throw new WorktreeCapacityError();
    }
    const directory = join(this.root, 'slot-' + randomUUID());
    if (exists) await git(this.config.repository, 'worktree', 'add', directory, branch);
    else await git(this.config.repository, 'worktree', 'add', '-b', branch, directory, 'HEAD');
    await this.verify(directory, id);
    return directory;
  }
}
