import { stat, readdir } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';

async function file(path) {
  try { const info = await stat(path); return info.isFile() ? info : null; }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Desktop updates replace their hashed runtime directory. Recover only within
// that managed installation; never silently replace a custom executable.
export async function resolveCodexExecutable(configured, {
  platform = process.platform, localAppData = process.env.LOCALAPPDATA,
} = {}) {
  if (!configured || await file(configured)) return configured;
  if (platform !== 'win32' || !localAppData) return configured;
  const root = resolve(localAppData, 'OpenAI', 'Codex', 'bin');
  const parts = relative(root, resolve(configured)).split(sep);
  if (parts.length !== 2 || !/^[a-f0-9]{16,64}$/i.test(parts[0]) || parts[1].toLowerCase() !== 'codex.exe') return configured;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return configured; throw error; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-f0-9]{16,64}$/i.test(entry.name)) continue;
    const path = join(root, entry.name, 'codex.exe');
    const info = await file(path);
    if (info) candidates.push({ path, time: info.mtimeMs });
  }
  candidates.sort((a, b) => b.time - a.time || a.path.localeCompare(b.path));
  return candidates[0]?.path ?? configured;
}
