// Disposable synthetic resources only. Does not inspect, mount or change a live household.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { captureCreateArguments, withCaptureCompanionUpgrade } from './capture-companion.mjs';

const project = 'capture-lifecycle-' + Date.now() + '-' + randomUUID().slice(0, 8);
const workspace = resolve('.local/alexa/lifecycle-rehearsals', project);
mkdirSync(workspace, { recursive: true });
const command = (args, input) =>
  execFileSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
const docker = async (...args) => command(args);
const inspect = async (kind, name) => {
  try {
    return JSON.parse(command([kind, 'inspect', name]))[0];
  } catch (error) {
    if (/No such (container|object|volume|image)/i.test(error.stderr ?? '')) return null;
    throw error;
  }
};
const oldImage = (
  await inspect('image', process.env.CAPTURE_REHEARSAL_FROM ?? 'our-place:alexa-admin-review')
)?.Id;
const newImage = (
  await inspect('image', process.env.CAPTURE_REHEARSAL_TO ?? 'our-place:alexa-companion-review')
)?.Id;
assert.match(oldImage ?? '', /^sha256:[a-f0-9]{64}$/);
assert.match(newImage ?? '', /^sha256:[a-f0-9]{64}$/);
assert.notEqual(
  oldImage,
  newImage,
  'Use two different image builds with compatible schema for this lifecycle rehearsal',
);
const descriptor = {
  enabled: true,
  containerName: project + '-capture',
  socketVolumeName: project + '-sockets',
};
const state = { workspace, container: project + '-app', volume: project + '-data', installationId: '' };
const labels = (role) => [
  '--label',
  `com.our-place.role=${role}`,
  '--label',
  `com.our-place.workspace=${workspace}`,
];
const createdVolumes = [];
const report = { oldImage, newImage, checks: {} };
async function healthy(name) {
  for (let i = 0; i < 80; i++) {
    const item = await inspect('container', name);
    if (item?.State?.Health?.Status === 'healthy') return item;
    if (!item?.State?.Running || item?.State?.Health?.Status === 'unhealthy')
      throw new Error('Synthetic service failed healthcheck');
    await delay(250);
  }
  throw new Error('Synthetic service healthcheck timed out');
}
async function startApp(image) {
  await docker(
    'run',
    '-d',
    '--name',
    state.container,
    ...labels('phone-trial'),
    '--network',
    'none',
    '--read-only',
    '--user',
    '1000:1000',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--mount',
    `type=volume,source=${state.volume},target=/data`,
    '--tmpfs',
    '/tmp:size=16m,mode=1777',
    '--env',
    'PUBLIC_ORIGIN=https://fixture.invalid',
    '--env',
    'BACKUP_ROOT=',
    '--env',
    'DATA_ROOT=/data',
    '--env',
    `EXPECTED_INSTALLATION_ID=${state.installationId}`,
    '--health-interval',
    '1s',
    '--health-start-period',
    '1s',
    image,
  );
  await healthy(state.container);
}
try {
  for (const [name, role] of [
    [state.volume, 'phone-trial'],
    [descriptor.socketVolumeName, 'capture-sockets'],
  ]) {
    assert.equal(await inspect('volume', name), null);
    await docker('volume', 'create', ...labels(role), name);
    createdVolumes.push(name);
  }
  await docker(
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--user',
    '0:0',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'CHOWN',
    '--cap-add',
    'FOWNER',
    '--security-opt',
    'no-new-privileges:true',
    '--mount',
    `type=volume,source=${state.volume},target=/data`,
    '--mount',
    `type=volume,source=${descriptor.socketVolumeName},target=/sockets`,
    '--entrypoint',
    'node',
    oldImage,
    '-e',
    "const fs=require('node:fs');for(const p of ['/data','/sockets']){if(fs.readdirSync(p).length)throw Error('Not empty');fs.chmodSync(p,0o700);fs.chownSync(p,1000,1000)}",
  );
  const people = ['fixture_alpha', 'fixture_beta'].map((username) => ({
    username,
    displayName: username,
    password: randomBytes(32).toString('base64url'),
  }));
  const bootstrap = command(
    [
      'run',
      '--rm',
      '-i',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--mount',
      `type=volume,source=${state.volume},target=/data`,
      '--env',
      'DATA_ROOT=/data',
      '--entrypoint',
      'node',
      oldImage,
      'apps/server/dist/bootstrap.js',
    ],
    JSON.stringify({ people }),
  );
  state.installationId = bootstrap.match(/EXPECTED_INSTALLATION_ID=([a-f0-9-]+)/)?.[1];
  assert.ok(state.installationId);
  await startApp(oldImage);
  const epoch = await docker(
    'exec',
    state.container,
    'node',
    '-e',
    "const D=require('node:module').createRequire('/app/apps/server/package.json')('better-sqlite3');const d=new D('/data/db/household.sqlite',{readonly:true});console.log(d.prepare('SELECT recovery_epoch FROM installation_state').get().recovery_epoch);d.close()",
  );
  await docker(...captureCreateArguments({ descriptor, state, workspace, image: oldImage, epoch }));
  await docker('start', descriptor.containerName);
  const first = await healthy(descriptor.containerName);
  const events = [];
  const loggedDocker = async (...args) => {
    events.push(args[0]);
    return docker(...args);
  };
  await withCaptureCompanionUpgrade({
    descriptor,
    state,
    workspace,
    targetImage: newImage,
    inspect,
    docker: loggedDocker,
    upgrade: async () => {
      events.push('upgrade');
      assert.equal((await inspect('container', descriptor.containerName)).State.Running, false);
      await docker('stop', state.container);
      await docker('rm', state.container);
      await startApp(newImage); // Same schema, different real image; this rehearsal does not migrate live data.
    },
  });
  const next = await healthy(descriptor.containerName);
  assert.notEqual(next.Id, first.Id);
  assert.equal(next.Image, newImage);
  assert.equal(next.HostConfig.NetworkMode, 'none');
  assert.equal(next.Mounts.find((m) => m.Destination === '/sockets').Name, descriptor.socketVolumeName);
  assert.equal(next.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.ok(events.indexOf('stop') < events.indexOf('upgrade'));
  report.checks.imageReplacementAndSocketRetention = true;

  // Simulate the epoch change of a restore, on this newly bootstrapped fixture only.
  await assert.rejects(
    withCaptureCompanionUpgrade({
      descriptor,
      state,
      workspace,
      targetImage: newImage,
      inspect,
      docker,
      upgrade: async () => {
        await docker(
          'exec',
          state.container,
          'node',
          '-e',
          "const D=require('node:module').createRequire('/app/apps/server/package.json')('better-sqlite3');const d=new D('/data/db/household.sqlite');d.prepare('UPDATE installation_state SET recovery_epoch=?').run('changed-fixture-epoch');d.close()",
        );
      },
    }),
    /epoch needs explicit review/,
  );
  assert.equal((await inspect('container', descriptor.containerName)).State.Running, false);
  report.checks.epochChangeLeavesCaptureStopped = true;
  await docker('start', descriptor.containerName);
  let rejected;
  for (let i = 0; i < 40; i++) {
    rejected = await inspect('container', descriptor.containerName);
    if (!rejected.State.Running) break;
    await delay(100);
  }
  assert.equal(rejected.State.Running, false);
  assert.notEqual(rejected.State.ExitCode, 0);
  report.checks.pinnedEpochRefusesManualRestart = true;
  console.log('PASS: synthetic companion image replacement, socket retention and restore-epoch refusal.');
} catch (error) {
  writeFileSync(join(workspace, 'failure.log'), String(error.stack) + '\n' + String(error.stderr ?? ''));
  console.error('Companion rehearsal failed; diagnostics retained in ignored local storage.');
  process.exitCode = 1;
} finally {
  for (const name of [descriptor.containerName, state.container]) {
    const item = await inspect('container', name);
    if (!item) continue;
    assert.equal(item.Config.Labels['com.our-place.workspace'], workspace);
    assert.ok(['phone-trial', 'capture-helper'].includes(item.Config.Labels['com.our-place.role']));
    await docker('rm', '--force', item.Id);
  }
  for (const name of createdVolumes) {
    const item = await inspect('volume', name);
    assert.equal(item.Labels['com.our-place.workspace'], workspace);
    await docker('volume', 'rm', name);
  }
  report.cleanedUp = true;
  writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
}
