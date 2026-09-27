import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.partial',
    file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}
export async function createOnce(path, value) {
  await mkdir(dirname(path), { recursive: true });
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  return true;
}
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}
export async function acquireLock(path) {
  const old = await readJson(path);
  if (old) {
    if (alive(old.pid)) throw new Error('A suggestion bridge is already running');
    await unlink(path);
  }
  const identity = { pid: process.pid, nonce: randomUUID() };
  if (!(await createOnce(path, identity))) throw new Error('Another bridge acquired the lock');
  return async () => {
    if ((await readJson(path))?.nonce === identity.nonce) await unlink(path);
  };
}
/** Persist exact request bytes before network I/O. A lost acknowledgement repeats that operation. */
export async function deliver(path, makeRequest, send) {
  let entry = await readJson(path);
  if (!entry) {
    entry = { request: makeRequest() };
    await writeJson(path, entry);
  }
  if (Object.hasOwn(entry, 'response')) return entry.response;
  const response = await send(entry.request);
  await writeJson(path, { ...entry, response });
  return response;
}
