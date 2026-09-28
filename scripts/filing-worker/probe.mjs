// Synthetic boundary checks; executed on stdin inside the isolated container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import tls from 'node:tls';
import { Resolver } from 'node:dns/promises';
assert.equal(process.getuid(), 1000);
const ca = fs.readFileSync('/etc/ssl/certs/ca-certificates.crt');
for (const path of ['/data', '/backups', '/var/run/docker.sock', '/app', '/root/.codex'])
  assert.equal(fs.existsSync(path), false, `Unexpected accessible path: ${path}`);
assert.throws(() => fs.writeFileSync('/forbidden', 'probe'));
const externalDNS = new Resolver({ timeout: 800, tries: 1 });
await assert.rejects(externalDNS.resolve4('example.com'));
externalDNS.setServers(['1.1.1.1']);
await assert.rejects(externalDNS.resolve4('example.com'));
for (const host of ['1.1.1.1', 'host.docker.internal']) {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect({ host, port: 443 });
      socket.setTimeout(1200, () => socket.destroy(Error('blocked')));
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    }),
  );
}
const proxy = new URL(process.env.HTTPS_PROXY);
for (const [target, expected] of [
  ['example.com:443', 403],
  ['auth.openai.com:443', 200],
]) {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target });
    req.setTimeout(8000, () => req.destroy(Error('proxy timeout')));
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve(res.statusCode);
        return;
      }
      const secure = tls.connect({ socket, servername: 'auth.openai.com', ca });
      secure.setTimeout(8000, () => secure.destroy(Error('TLS timeout')));
      secure.on('error', reject);
      secure.once('secureConnect', () => {
        secure.destroy();
        resolve(res.statusCode);
      });
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, expected);
}
console.log(
  'PASS: unprivileged, root filesystem read-only, no household mounts, direct network/DNS blocked, only authentication CONNECT allowed.',
);
