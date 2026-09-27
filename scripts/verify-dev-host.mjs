import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const root = resolve('.local/phone-trial');
const state = JSON.parse(await readFile(join(root, 'host.json'), 'utf8'));
const base = process.argv.includes('--https') ? state.origin : state.upstream;
const docker = async (...args) =>
  (await exec('docker', args, { maxBuffer: 4 * 1024 ** 2, windowsHide: true })).stdout.trim();
const sessions = [],
  created = [];
const restoreVolume = `our-place-dev-restore-check-${randomUUID()}`;
let madeVolume = false;
let browserCookie;
async function verifyDistribution() {
  const page = await fetch(`${base}/install/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
  const html = await page.text();
  assert.ok(html.includes(state.origin));
  for (const asset of ['install.css', 'install.js', 'theme.css'])
    assert.equal((await fetch(`${base}/install/${asset}`)).status, 200);
  const response = await fetch(`${base}/install/our-place-debug.apk`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/vnd.android.package-archive');
  const bytes = Buffer.from(await response.arrayBuffer());
  const local = await readFile(join(root, 'install/our-place-debug.apk'));
  assert.deepEqual(bytes, local);
  const build = await (await fetch(`${base}/install/build.json`)).json();
  assert.equal(build.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(build.bytes, bytes.length);
  for (const path of [
    '/install/accounts.json',
    '/accounts.json',
    '/backups/',
    '/install/%2e%2e%2faccounts.json',
  ])
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  return build.sha256;
}
async function verifyBrowserSession(profile) {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: state.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: profile.username, clientKind: 'browser' }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /; Secure/i);
  assert.match(setCookie, /; HttpOnly/i);
  assert.match(setCookie, /; SameSite=Strict/i);
  browserCookie = setCookie.split(';')[0];
  const session = await fetch(`${base}/api/session`, { headers: { cookie: browserCookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).installationId, state.installationId);
  for (const [origin, expected] of [
    ['https://unrelated.invalid', 403],
    [undefined, 400],
  ]) {
    const rejected = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: browserCookie, ...(origin ? { origin } : {}) },
    });
    assert.equal(rejected.status, expected);
  }
  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie: browserCookie, origin: state.origin },
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${base}/api/session`, { headers: { cookie: browserCookie } })).status, 401);
  browserCookie = undefined;
}
async function request(path, { session, method = 'GET', body, bytes, epoch } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      ...(session ? { authorization: `Bearer ${session.credential}`, 'x-client-id': session.clientId } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(bytes ? { 'content-type': 'application/octet-stream', 'x-server-epoch': epoch } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : bytes ? { body: bytes } : {}),
  });
  return response;
}
async function json(path, options) {
  const response = await request(path, options);
  assert.ok(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function command(session, kind, args) {
  return json(`/commands/${kind}`, {
    session,
    method: 'POST',
    body: {
      operationId: randomUUID(),
      contractVersion: 1,
      expectedServerEpoch: session.serverEpoch,
      arguments: args,
    },
  });
}
try {
  const installerSha256 = await verifyDistribution();
  const options = await json('/auth/options');
  assert.equal(options.mode, 'trusted-network');
  assert.equal(options.profiles.length, 2);
  await verifyBrowserSession(options.profiles[0]);
  for (const profile of options.profiles)
    sessions.push(
      await json('/auth/login', {
        method: 'POST',
        body: { username: profile.username, clientKind: 'android' },
      }),
    );
  const [you, partner] = sessions;
  assert.equal(you.installationId, state.installationId);
  const scopeId = you.scopes.find((scope) => scope.kind === 'private').scopeId;
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBZkAAAAASUVORK5CYII=',
    'base64',
  );
  const mediaId = randomUUID(),
    inboxId = randomUUID(),
    digest = createHash('sha256').update(bytes).digest('hex');
  await json(`/media/${mediaId}/prepare`, {
    session: you,
    method: 'POST',
    body: {
      scopeId,
      expectedServerEpoch: you.serverEpoch,
      digest,
      byteLength: bytes.length,
      mimeType: 'image/png',
    },
  });
  assert.ok(
    (await request(`/media/${mediaId}/bytes`, { session: you, method: 'PUT', bytes, epoch: you.serverEpoch }))
      .ok,
  );
  const result = await command(you, 'CreateInboxEntry', {
    inboxId,
    scopeId,
    text: 'Temporary host verification photo',
    source: { kind: 'photo' },
    capturedAt: Date.now(),
    attachments: [
      {
        attachmentId: randomUUID(),
        mediaId,
        digest,
        byteLength: bytes.length,
        mimeType: 'image/png',
        position: 0,
      },
    ],
  });
  assert.equal(result.status, 'Applied');
  created.push(inboxId);
  assert.equal((await request(`/media/${mediaId}`, { session: partner })).status, 404);
  assert.equal((await request(`/inbox/${inboxId}/history`, { session: partner })).status, 404);
  assert.equal((await request('/backups', { session: partner })).status, 404);
  assert.deepEqual(
    Buffer.from(await (await request(`/media/${mediaId}`, { session: you })).arrayBuffer()),
    bytes,
  );
  await json('/backups', { session: you, method: 'POST', body: {} });
  let completed;
  for (let i = 0; i < 120; i++) {
    const status = await json('/backups', { session: you });
    if (!status.running) {
      completed = status.runs.find((run) => run.state === 'complete' && run.available);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(completed, 'Trial export did not complete');
  const markerPath = join(state.backupRoot, `backup-${completed.runId}.tar.gz.complete.json`);
  const completion = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.ok(
    completion.manifest.files.some((file) => file.digest === digest),
    'Photo must be in export',
  );
  await docker('volume', 'create', '--label', 'com.our-place.role=trial-restore-check', restoreVolume);
  madeVolume = true;
  const mounts = [
    '--mount',
    `type=volume,source=${restoreVolume},target=/data`,
    '--mount',
    `type=bind,source=${state.backupRoot},target=/backups,readonly`,
  ];
  await docker(
    'run',
    '--rm',
    ...mounts,
    'our-place:development',
    'node',
    'apps/server/dist/operations.js',
    'restore',
    `/backups/backup-${completed.runId}.tar.gz.complete.json`,
    '/data/restored',
  );
  const probe = `const D=require('./apps/server/node_modules/better-sqlite3');const db=new D('/data/restored/db/household.sqlite',{readonly:true});const row=db.prepare('SELECT text FROM inbox_entries WHERE inbox_id=?').get(${JSON.stringify(inboxId)});const epoch=db.prepare('SELECT recovery_epoch FROM installation_state').get().recovery_epoch;console.log(JSON.stringify({text:row.text,epoch,integrity:db.pragma('integrity_check',{simple:true})}));db.close();`;
  const restored = JSON.parse(
    await docker('run', '--rm', ...mounts, 'our-place:development', 'node', '-e', probe),
  );
  assert.equal(restored.text, 'Temporary host verification photo');
  assert.notEqual(restored.epoch, you.serverEpoch);
  assert.equal(restored.integrity, 'ok');
  const report = {
    checkedAt: new Date().toISOString(),
    base,
    installationId: state.installationId,
    browserCookieOrigin: 'passed',
    installerDownload: 'passed',
    installerSha256,
    nativeAuthentication: 'passed',
    passwordFreeProfiles: 'passed',
    partnerPrivacy: 'passed',
    mediaUploadRead: 'passed',
    windowsFolderExport: 'passed',
    isolatedRestore: 'passed',
    backup: completed.runId,
    backupBytes: completed.byteLength,
  };
  await writeFile(
    join(root, process.argv.includes('--https') ? 'https-verification.json' : 'local-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browserCookie)
    await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: browserCookie, origin: state.origin },
    }).catch(() => {});
  if (sessions[0])
    for (const id of created)
      await command(sessions[0], 'DeleteInboxEntry', { inboxId: id, expectedRevision: 1 }).catch(() => {});
  for (const session of sessions)
    await request('/auth/logout', { session, method: 'POST', body: {} }).catch(() => {});
  if (madeVolume) await docker('volume', 'rm', restoreVolume);
}
