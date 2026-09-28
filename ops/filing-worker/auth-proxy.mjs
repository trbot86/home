import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

export function publicAddress(address) {
  if (net.isIP(address) !== 4) return false;
  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0)
  );
}

// Authentication only. No model, general web, host, or LAN access is enabled here.
export function createAuthProxy(resolve = lookup, connect = net.connect) {
  const server = http.createServer((_req, res) => res.writeHead(403).end());
  server.on('connect', async (req, downstream, head) => {
    if (req.url !== 'auth.openai.com:443' || head.length) {
      downstream.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    downstream.on('error', () => {});
    try {
      const answers = await resolve('auth.openai.com', { all: true, family: 4 });
      if (!answers.length || answers.some(({ address }) => !publicAddress(address))) throw Error();
      if (downstream.destroyed) return;
      const upstream = connect({ host: answers[0].address, port: 443 });
      const close = () => {
        upstream.destroy();
        downstream.destroy();
      };
      upstream.setTimeout(60_000, close);
      downstream.setTimeout(60_000, close);
      upstream.on('error', close);
      downstream.on('close', () => upstream.destroy());
      upstream.on('close', () => downstream.destroy());
      upstream.once('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        downstream.pipe(upstream).pipe(downstream);
      });
    } catch {
      downstream.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createAuthProxy().listen(3128, '0.0.0.0');
