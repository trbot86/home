#!/usr/local/bin/node
import { readFile } from 'node:fs/promises';
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => abort.abort());
const timer = setTimeout(() => {
  abort.abort();
  process.stdin.destroy();
}, 24_000);
try {
  const config = JSON.parse(await readFile('/run/filing/client.json', 'utf8'));
  const url = new URL(config.url);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== 'host.docker.internal' ||
    url.pathname !== '/filing' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_-]{43}$/.test(config.token)
  )
    throw Error();
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > 2 * 1024 * 1024) throw Error();
  }
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: bytes,
    redirect: 'error',
    signal: abort.signal,
  });
  if (!response.ok) throw Error();
  let output = Buffer.alloc(0);
  for await (const chunk of response.body) {
    output = Buffer.concat([output, chunk]);
    if (output.length > 4096) throw Error();
  }
  process.stdout.write(output);
} catch {
  process.stderr.write('Filing worker unavailable\n');
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  abort.abort();
}
