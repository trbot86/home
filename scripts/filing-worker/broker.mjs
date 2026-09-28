import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);

export async function dockerJob(config, payload, signal) {
  const name = `our-place-filing-job-${randomUUID()}`;
  const args = [
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
    '35',
    'node',
    '/opt/filing/worker.mjs',
  ];
  try {
    return await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(Error());
        return;
      }
      const child = spawn(config.docker, args, {
        cwd: config.repository,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      let bytes = Buffer.alloc(0),
        done = false;
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) {
          child.kill();
          reject(Error('Filing job failed'));
        } else resolve(bytes.toString('utf8'));
      };
      const abort = () => finish(true),
        timer = setTimeout(abort, 40_000);
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', abort);
      child.stdin.on('error', abort);
      child.stdout.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 4096) abort();
      });
      child.once('close', (code) => finish(code !== 0));
      child.stdin.end(payload);
    });
  } finally {
    // Only this generated job name can be removed. The in-container deadline
    // also terminates the whole job if this host process is forcibly killed.
    await exec(config.docker, ['rm', '--force', name], {
      cwd: config.repository,
      windowsHide: true,
      timeout: 10_000,
    }).catch(() => {});
  }
}

export function createBroker(config, run = dockerJob) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(config.token)) throw Error('Invalid broker configuration');
  let active = false;
  return http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''),
      expected = Buffer.from(`Bearer ${config.token}`);
    if (
      req.method !== 'POST' ||
      req.url !== '/filing' ||
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      res.writeHead(403).end();
      req.resume();
      return;
    }
    if (active) {
      res.writeHead(503).end();
      req.resume();
      return;
    }
    active = true;
    const abort = new AbortController(),
      timer = setTimeout(() => {
        abort.abort();
        req.destroy();
        res.destroy();
      }, 40_000);
    res.once('close', () => abort.abort());
    try {
      let bytes = Buffer.alloc(0);
      for await (const chunk of req) {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > 65536) throw Error();
      }
      const request = JSON.parse(bytes.toString('utf8'));
      if (request.version !== 1 || request.model !== 'gpt-5.6-luna' || request.effort !== 'low')
        throw Error();
      const result = await run(config, bytes, abort.signal);
      const value = JSON.parse(result);
      if (
        !Array.isArray(value.keys) ||
        value.keys.length > 3 ||
        value.keys.some((k) => typeof k !== 'string' || !/^\d{1,2}$/.test(k))
      )
        throw Error();
      res
        .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ keys: value.keys }));
    } catch {
      if (!res.destroyed) res.writeHead(503).end('Filing worker unavailable');
    } finally {
      clearTimeout(timer);
      abort.abort();
      active = false;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (
    !isAbsolute(config.repository) ||
    !isAbsolute(config.docker) ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    throw Error('Invalid broker configuration');
  const server = createBroker(config);
  server.listen(config.port, '127.0.0.1');
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => {
      server.closeAllConnections();
      server.close();
    });
}
