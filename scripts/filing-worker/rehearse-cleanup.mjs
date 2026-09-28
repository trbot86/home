import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve, isAbsolute } from 'node:path';
const docker = process.argv[2],
  exec = promisify(execFile);
if (!docker || !isAbsolute(docker)) throw Error('Pass the absolute Docker executable path');
const name = `our-place-filing-cleanup-${randomUUID()}`,
  cwd = resolve(import.meta.dirname, '../..');
const child = spawn(
  docker,
  [
    'compose',
    '-f',
    'ops/filing-worker/compose.yaml',
    'run',
    '--rm',
    '--no-deps',
    '--name',
    name,
    '-T',
    'worker',
    'timeout',
    '--signal=TERM',
    '--kill-after=2s',
    '5',
    'node',
    '-e',
    'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
  ],
  { cwd, windowsHide: true, stdio: 'ignore' },
);
const inspect = async () => {
  try {
    return JSON.parse(
      (await exec(docker, ['inspect', name], { windowsHide: true, timeout: 5000 })).stdout,
    )[0];
  } catch {
    return null;
  }
};
try {
  let running = false;
  for (let i = 0; i < 30; i++) {
    if ((await inspect())?.State.Running) {
      running = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!running) throw Error('Cleanup rehearsal did not start');
  child.kill(); // Lose the host transport without issuing a container stop.
  await new Promise((r) => setTimeout(r, 8500));
  const remaining = await inspect();
  if (remaining?.State.Running) throw Error('Container survived its independent deadline');
  console.log(
    'PASS: whole worker container terminates after transport death, even when its process ignores SIGTERM (shortened rehearsal deadline).',
  );
} finally {
  child.kill();
  await exec(docker, ['rm', '--force', name], { windowsHide: true, timeout: 10000 }).catch(() => {});
}
