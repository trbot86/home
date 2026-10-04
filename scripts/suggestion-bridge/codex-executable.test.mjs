import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexExecutable } from './codex-executable.mjs';

test('desktop updates recover a missing managed runtime but preserve explicit executables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-runtime-'));
  try {
    const options = { platform: 'win32', localAppData: root };
    const bin = join(root, 'OpenAI', 'Codex', 'bin');
    const old = join(bin, 'aaaaaaaaaaaaaaaa', 'codex.exe');
    const current = join(bin, 'bbbbbbbbbbbbbbbb', 'codex.exe');
    await mkdir(join(bin, 'bbbbbbbbbbbbbbbb'), { recursive: true });
    await writeFile(current, 'synthetic executable');
    assert.equal(await resolveCodexExecutable(old, options), current);
    assert.equal(await resolveCodexExecutable(old, { ...options, platform: 'linux' }), old);
    const custom = join(root, 'custom', 'codex.exe');
    assert.equal(await resolveCodexExecutable(custom, options), custom);
    await mkdir(join(bin, 'aaaaaaaaaaaaaaaa'));
    await writeFile(old, 'retained executable');
    assert.equal(await resolveCodexExecutable(old, options), old);
    await rm(old);
    const newer = join(bin, 'cccccccccccccccc', 'codex.exe');
    await mkdir(join(bin, 'cccccccccccccccc'));
    await writeFile(newer, 'newer executable');
    await utimes(current, 1, 1);
    assert.equal(await resolveCodexExecutable(old, options), newer);
    await rm(newer); await rm(current);
    assert.equal(await resolveCodexExecutable(old, options), old);
  } finally { await rm(root, { recursive: true, force: true }); }
});
