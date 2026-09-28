import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SuggestionWorktrees, WorktreeCapacityError } from './worktrees.mjs';
import { writeJson } from './journal.mjs';
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    windowsHide: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function fixture(t, limit = 2) {
  const root = await mkdtemp(join(tmpdir(), 'suggestion-worktrees-'));
  const verifiedRoot = await realpath(root);
  t.after(async () => {
    assert.equal(await realpath(root), verifiedRoot);
    assert.ok(verifiedRoot.toLowerCase().startsWith((await realpath(tmpdir())).toLowerCase()));
    await rm(root, { recursive: true, force: true });
  });
  const repository = join(root, 'repository');
  await mkdir(repository);
  git(repository, 'init');
  await writeFile(join(repository, '.gitignore'), '.local/\nnode_modules/\n*.sqlite\n');
  await writeFile(join(repository, 'source.txt'), 'original');
  git(repository, 'add', '.');
  git(repository, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
  const stateRoot = join(root, 'state');
  const config = { repository, stateRoot, maxWorktrees: limit };
  return { config, pool: new SuggestionWorktrees(config), repository, stateRoot };
}

test('many suggestions retain bounded checkouts and recreate committed branches', async (t) => {
  const f = await fixture(t);
  const first = await f.pool.acquire('suggestion-0');
  await writeFile(join(first, 'source.txt'), 'implemented');
  git(first, 'add', '.');
  git(first, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Change');
  await mkdir(join(first, 'node_modules'), { recursive: true });
  await writeFile(join(first, 'node_modules', 'cache.bin'), 'reproducible');
  await mkdir(join(first, '.local', 'suggestion-input', 'run-one'), { recursive: true });
  await writeFile(join(first, '.local', 'suggestion-input', 'run-one', 'prompt.txt'), 'scoped input');
  for (let i = 1; i <= 12; i++) {
    await f.pool.acquire('suggestion-' + i);
    assert.ok((await readdir(join(f.stateRoot, 'worktrees'))).length <= 2);
  }
  assert.equal(
    await readFile(join(await f.pool.acquire('suggestion-0'), 'source.txt'), 'utf8'),
    'implemented',
  );
  assert.equal(git(f.repository, 'show', 'codex/suggestion-suggestion-0:source.txt'), 'implemented');
});

test('dirty and unfamiliar ignored data pin checkouts instead of being discarded', async (t) => {
  const f = await fixture(t);
  const first = await f.pool.acquire('suggestion-a'),
    second = await f.pool.acquire('suggestion-b');
  await writeFile(join(first, 'source.txt'), 'unfinished');
  await writeFile(join(second, 'precious.sqlite'), 'retained');
  await assert.rejects(f.pool.acquire('suggestion-c'), WorktreeCapacityError);
  assert.equal(await readFile(join(first, 'source.txt'), 'utf8'), 'unfinished');
  assert.equal(await readFile(join(second, 'precious.sqlite'), 'utf8'), 'retained');
});

test('recycling handles dependency paths beyond the Windows legacy limit', async (t) => {
  const f = await fixture(t, 1);
  git(f.repository, 'config', 'core.longpaths', 'false');
  const first = await f.pool.acquire('suggestion-long');
  const nested = join(first, 'node_modules', ...Array(8).fill('long-dependency-directory'));
  await mkdir(nested, { recursive: true });
  const cached = join(nested, 'cache.bin');
  assert.ok(cached.length > 260);
  await writeFile(cached, 'reproducible');
  const next = await f.pool.acquire('suggestion-next');
  assert.equal(await readFile(join(next, 'source.txt'), 'utf8'), 'original');
  assert.equal(next, first);
  assert.equal(await readFile(cached, 'utf8'), 'reproducible');
  assert.equal((await readdir(join(f.stateRoot, 'worktrees'))).length, 1);
  assert.equal(git(f.repository, 'config', 'core.longpaths'), 'false');
});

test('an uncertain launch pins even a clean checkout until publication', async (t) => {
  const f = await fixture(t, 1);
  const first = await f.pool.acquire('suggestion-a');
  const runRoot = join(f.stateRoot, 'runs', 'run-one');
  await writeJson(join(runRoot, 'launch.json'), { cwd: first });
  await assert.rejects(f.pool.acquire('suggestion-b'), WorktreeCapacityError);
  await writeJson(join(runRoot, 'terminal.json'), { exitCode: 0 });
  await assert.rejects(f.pool.acquire('suggestion-b'), WorktreeCapacityError);
  await writeJson(join(runRoot, 'published.json'), { at: Date.now() });
  assert.ok(await f.pool.acquire('suggestion-b'));
});

test('foreign branches and traversal cannot become deletion targets', async (t) => {
  const f = await fixture(t, 1);
  await assert.rejects(f.pool.acquire('../outside'));
  const first = await f.pool.acquire('suggestion-a');
  git(first, 'checkout', '-b', 'unrelated-work');
  await assert.rejects(f.pool.acquire('suggestion-b'), /identity mismatch/);
  assert.equal(await realpath(first), resolve(first));
});

test('reused slots start new branches from current repository HEAD and survive pool restart', async (t) => {
  const f = await fixture(t, 1);
  const first = await f.pool.acquire('suggestion-old');
  await writeFile(join(f.repository, 'source.txt'), 'latest integrated source');
  git(f.repository, 'add', '.');
  git(
    f.repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'New base',
  );
  const next = await f.pool.acquire('suggestion-new');
  assert.equal(next, first);
  assert.equal(await readFile(join(next, 'source.txt'), 'utf8'), 'latest integrated source');
  assert.equal(await new SuggestionWorktrees(f.config).acquire('suggestion-new'), next);
  assert.equal(
    await readFile(join(await f.pool.acquire('suggestion-old'), 'source.txt'), 'utf8'),
    'original',
  );
});

test('branch reuse refuses to overwrite ignored cache files with target source', async (t) => {
  const f = await fixture(t, 1);
  const first = await f.pool.acquire('suggestion-old');
  await mkdir(join(first, 'node_modules'), { recursive: true });
  await writeFile(join(first, 'node_modules', 'collision.txt'), 'keep cache');
  await mkdir(join(f.repository, 'node_modules'), { recursive: true });
  await writeFile(join(f.repository, 'node_modules', 'collision.txt'), 'target source');
  git(f.repository, 'add', '-f', 'node_modules/collision.txt');
  git(
    f.repository,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Collision fixture',
  );
  await assert.rejects(f.pool.acquire('suggestion-new'), /overwritten/);
  assert.equal(await readFile(join(first, 'node_modules', 'collision.txt'), 'utf8'), 'keep cache');
  assert.equal(git(first, 'symbolic-ref', '--short', 'HEAD'), 'codex/suggestion-suggestion-old');
});
