import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
const exec = promisify(execFile);
const tag = process.env.SMOKE_IMAGE ?? 'our-place:development';
const prefix = `our-place-test-${randomUUID()}`;
const data = `${prefix}-data`, backups = `${prefix}-backups`, restored = `${prefix}-restored`;
const volumes = [], containers = new Set();
const docker = async (...args) => (await exec('docker', args, { maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
const mount = (volume, target) => ['--mount', `type=volume,source=${volume},target=${target}`];
const env = ['-e', 'PUBLIC_ORIGIN=https://household.example.test', '-e', 'BACKUP_HOUR=23'];
let installationId;
async function runApp(name, volume, root = '/data') {
  containers.add(name);
  await docker('run', '-d', '--name', name, '--label', `our-place-test=${prefix}`, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '-p', '127.0.0.1::3000', ...env, '-e', `DATA_ROOT=${root}`, '-e', `EXPECTED_INSTALLATION_ID=${installationId}`, ...mount(volume, '/data'), ...mount(backups, '/backups'), tag);
  const port = (await docker('port', name, '3000/tcp')).split(':').at(-1);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${url}/health`)).ok) return url; } catch {} await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`Container did not start: ${await docker('logs', name)}`);
}
async function login(url) {
  const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://household.example.test' }, body: JSON.stringify({ username: 'alex', password: 'container-smoke-alex-2026', clientKind: 'browser' }) });
  assert.equal(response.status, 200); const session = await response.json();
  return { session, headers: { cookie: response.headers.get('set-cookie').split(';')[0], origin: 'https://household.example.test', 'content-type': 'application/json' } };
}
try {
  for (const volume of [data, backups, restored]) { await docker('volume', 'create', '--label', `our-place-test=${prefix}`, volume); volumes.push(volume); }
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '--rm', '-i', ...mount(data, '/data'), tag, 'node', 'apps/server/dist/bootstrap.js'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; let stdout = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => output += bytes); child.on('error', reject); child.on('exit', code => { installationId = stdout.match(/EXPECTED_INSTALLATION_ID=([a-f0-9-]+)/)?.[1]; code === 0 && installationId ? resolve() : reject(new Error(output || 'Bootstrap identity missing')); });
    child.stdin.end(JSON.stringify({ people: [{ username: 'alex', displayName: 'Alex', password: 'container-smoke-alex-2026' }, { username: 'sam', displayName: 'Sam', password: 'container-smoke-sam-2026' }] }));
  });
  await docker('run', '--rm', ...mount(data, '/data'), ...mount(backups, '/backups'), tag, 'node', 'apps/server/dist/operations.js', 'init-backups', '/backups');
  let url = await runApp(`${prefix}-first`, data); let auth = await login(url);
  const epoch = auth.session.serverEpoch; const scopeId = auth.session.scopes.find(s => s.kind === 'shared').scopeId;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=', 'base64');
  const mediaId = randomUUID(), inboxId = randomUUID(), digest = createHash('sha256').update(png).digest('hex');
  const json = async (path, body) => { const response = await fetch(`${url}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: auth.headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`); return response.json(); };
  await json(`/media/${mediaId}/prepare`, { scopeId, expectedServerEpoch: epoch, digest, byteLength: png.length, mimeType: 'image/png' });
  const upload = await fetch(`${url}/api/media/${mediaId}/bytes`, { method: 'PUT', headers: { ...auth.headers, 'content-type': 'application/octet-stream', 'x-server-epoch': epoch }, body: png }); assert.ok(upload.ok, await upload.text());
  const command = { operationId: randomUUID(), contractVersion: 1, expectedServerEpoch: epoch, arguments: { inboxId, scopeId, text: 'Container replacement proof', capturedAt: Date.now(), source: { kind: 'photo' }, attachments: [{ attachmentId: randomUUID(), mediaId, digest, byteLength: png.length, mimeType: 'image/png', position: 0 }] } };
  assert.equal((await json('/commands/CreateInboxEntry', command)).status, 'Applied');
  await json('/backups', {});
  let complete;
  for (let i = 0; i < 120; i++) { complete = (await json('/backups')).runs.find(run => run.state === 'complete' && run.available); if (complete) break; await new Promise(r => setTimeout(r, 250)); }
  assert.ok(complete, 'Backup did not complete');
  await docker('rm', '-f', `${prefix}-first`); containers.delete(`${prefix}-first`);
  url = await runApp(`${prefix}-replacement`, data); auth = await login(url);
  assert.equal((await json('/cache/inbox')).entries.find(e => e.inboxId === inboxId).text, 'Container replacement proof');
  const original = Buffer.from(await (await fetch(`${url}/api/media/${mediaId}`, { headers: auth.headers })).arrayBuffer()); assert.deepEqual(original, png);
  await docker('rm', '-f', `${prefix}-replacement`); containers.delete(`${prefix}-replacement`);
  await docker('run', '--rm', ...mount(restored, '/data'), ...mount(backups, '/backups'), tag, 'node', 'apps/server/dist/operations.js', 'restore', `/backups/backup-${complete.runId}.tar.gz.complete.json`, '/data/restored');
  url = await runApp(`${prefix}-restored`, restored, '/data/restored'); auth = await login(url);
  assert.notEqual(auth.session.serverEpoch, epoch);
  assert.equal((await json('/cache/inbox')).entries.find(e => e.inboxId === inboxId).text, 'Container replacement proof');
  assert.deepEqual(Buffer.from(await (await fetch(`${url}/api/media/${mediaId}`, { headers: auth.headers })).arrayBuffer()), png);
  console.log('PASS: production container, persisted replacement, online export, verified isolated restore, new epoch, original photo.');
} finally {
  for (const name of containers) await docker('rm', '-f', name).catch(error => console.error(error.message));
  for (const volume of volumes) await docker('volume', 'rm', volume).catch(error => console.error(error.message));
}
