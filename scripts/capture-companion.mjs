import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const fail = (message) => {
  throw new Error(`Capture companion: ${message}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const imageId = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const name = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value);
const workspaceKey = (value) => (typeof value === 'string' ? resolve(value).replaceAll('\\', '/') : '');
export const captureHealthCommand =
  "const s=require('node:net').connect('/sockets/capture.sock');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(1000,()=>process.exit(1))";

export function validateCaptureDescriptor(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), ['containerName', 'enabled', 'socketVolumeName']) ||
    typeof value.enabled !== 'boolean' ||
    !name(value.containerName) ||
    !name(value.socketVolumeName)
  )
    fail('invalid descriptor; expected enabled, containerName and socketVolumeName only');
  return { ...value };
}

/** Missing means unconfigured. An unreadable/malformed file is never treated as disabled. */
export async function readCaptureDescriptor(path) {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) fail('descriptor must be a regular file');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) fail('descriptor is too large');
    return validateCaptureDescriptor(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally {
    await file.close();
  }
}

function owned(resource, role, workspace) {
  const labels = resource?.Config?.Labels ?? resource?.Labels;
  if (
    labels?.['com.our-place.role'] !== role ||
    workspaceKey(labels?.['com.our-place.workspace']) !== workspaceKey(workspace)
  )
    fail('resource ownership does not match');
}

function hostState(state, workspace, descriptor) {
  if (
    workspaceKey(state.workspace) !== workspaceKey(workspace) ||
    !name(state.container) ||
    !name(state.volume) ||
    typeof state.installationId !== 'string' ||
    !state.installationId ||
    state.container === descriptor.containerName ||
    state.volume === descriptor.socketVolumeName
  )
    fail('host state does not match the descriptor');
}

function appState(app, state, workspace, expectedImage) {
  owned(app, 'phone-trial', workspace);
  if (
    !imageId(app.Image) ||
    (expectedImage && app.Image !== expectedImage) ||
    app.Name !== '/' + state.container ||
    !app.State?.Running ||
    app.State?.Health?.Status !== 'healthy'
  )
    fail('household app image or health is not verified');
  const mounts = app.Mounts.filter((m) => m.Destination === '/data');
  if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== state.volume || !mounts[0].RW)
    fail('household data mount does not match');
}

export function validateCaptureContainer(container, descriptor, state, workspace, expectedImage) {
  owned(container, 'capture-helper', workspace);
  const config = container.Config,
    host = container.HostConfig;
  const launcher =
    (same(config.Entrypoint, ['sh', 'apps/server/capture-entry.sh']) && !(config.Cmd ?? []).length) ||
    (same(config.Entrypoint, ['sh']) && same(config.Cmd, ['apps/server/capture-entry.sh']));
  const health =
    same(config.Healthcheck?.Test, ['CMD', 'node', '-e', captureHealthCommand]) ||
    same(config.Healthcheck?.Test, ['CMD-SHELL', 'node -e "' + captureHealthCommand + '"']);
  if (
    container.Name !== '/' + descriptor.containerName ||
    container.Image !== expectedImage ||
    !imageId(expectedImage) ||
    config.User !== '1000:1000' ||
    config.WorkingDir !== '/app' ||
    !launcher ||
    host.NetworkMode !== 'none' ||
    !host.ReadonlyRootfs ||
    host.Privileged ||
    (host.CapAdd ?? []).length ||
    !same(host.CapDrop, ['ALL']) ||
    !same(host.SecurityOpt, ['no-new-privileges:true']) ||
    Object.keys(host.PortBindings ?? {}).length ||
    (host.Devices ?? []).length ||
    (host.DeviceRequests ?? []).length ||
    (host.VolumesFrom ?? []).length ||
    (host.Links ?? []).length ||
    host.PidMode ||
    host.IpcMode === 'host' ||
    !['no', 'unless-stopped'].includes(host.RestartPolicy?.Name) ||
    !health
  )
    fail('helper runtime differs from the restricted configuration');
  const mounts = container.Mounts.filter((m) => m.Type !== 'tmpfs');
  if (
    mounts.length !== 2 ||
    mounts.some((m) => m.Type !== 'volume' || !m.RW) ||
    !mounts.some((m) => m.Destination === '/data' && m.Name === state.volume) ||
    !mounts.some((m) => m.Destination === '/sockets' && m.Name === descriptor.socketVolumeName)
  )
    fail('helper mounts do not match');
  const entries = (config.Env ?? []).map((item) => {
    const i = item.indexOf('=');
    return [item.slice(0, i), item.slice(i + 1)];
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) fail('duplicate environment keys');
  const env = Object.fromEntries(entries);
  if (
    env.CAPTURE_ENABLED !== '1' ||
    env.DATA_ROOT !== '/data' ||
    env.EXPECTED_INSTALLATION_ID !== state.installationId ||
    env.CAPTURE_SOCKET !== '/sockets/capture.sock' ||
    Object.hasOwn(env, 'CAPTURE_PORT') ||
    typeof env.CAPTURE_EXPECTED_SERVER_EPOCH !== 'string' ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(env.CAPTURE_EXPECTED_SERVER_EPOCH)
  )
    fail('helper installation or epoch binding does not match');
  return env.CAPTURE_EXPECTED_SERVER_EPOCH;
}

// Reads only deployment metadata, never household notes, people, media or credentials.
const identityScript = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const D=require('node:module').createRequire('/app/apps/server/package.json')('better-sqlite3');
const db=new D('/data/db/household.sqlite',{readonly:true});
try{
 const root='/app/apps/server/migrations';
 const applied=db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
 const files=fs.readdirSync(root).filter(x=>/^\d+_[\w-]+\.sql$/.test(x)).sort();
 const schemaCurrent=JSON.stringify(files)===JSON.stringify(applied.map(x=>x.version))&&applied.every(x=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,x.version))).digest('hex')===x.checksum);
 const row=db.prepare('SELECT installation_id,recovery_epoch,recovery_mode FROM installation_state WHERE singleton=1').get();
 console.log(JSON.stringify({installationId:row.installation_id,epoch:row.recovery_epoch,normal:row.recovery_mode==='normal',schemaCurrent}));
}finally{db.close()}
`;

export function captureCreateArguments({ descriptor, state, workspace, image, epoch }) {
  hostState(state, workspace, validateCaptureDescriptor(descriptor));
  if (!imageId(image) || !/^[A-Za-z0-9_-]{1,200}$/.test(epoch)) fail('image or epoch is invalid');
  return [
    'create',
    '--name',
    descriptor.containerName,
    '--label',
    'com.our-place.role=capture-helper',
    '--label',
    `com.our-place.workspace=${workspace}`,
    '--network',
    'none',
    '--user',
    '1000:1000',
    '--workdir',
    '/app',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--restart',
    'no',
    '--memory',
    '256m',
    '--pids-limit',
    '32',
    '--mount',
    `type=volume,source=${state.volume},target=/data`,
    '--mount',
    `type=volume,source=${descriptor.socketVolumeName},target=/sockets`,
    '--tmpfs',
    '/tmp:size=16m,uid=1000,gid=1000,mode=0700',
    '--env',
    'CAPTURE_ENABLED=1',
    '--env',
    'DATA_ROOT=/data',
    '--env',
    `EXPECTED_INSTALLATION_ID=${state.installationId}`,
    '--env',
    `CAPTURE_EXPECTED_SERVER_EPOCH=${epoch}`,
    '--env',
    'CAPTURE_SOCKET=/sockets/capture.sock',
    '--log-driver',
    'json-file',
    '--log-opt',
    'max-size=5m',
    '--log-opt',
    'max-file=2',
    '--health-cmd',
    `node -e "${captureHealthCommand}"`,
    '--health-interval',
    '2s',
    '--health-timeout',
    '2s',
    '--health-retries',
    '5',
    '--entrypoint',
    'sh',
    image,
    'apps/server/capture-entry.sh',
  ];
}

/** Stop/restore hook. Caller holds the host upgrade lock; this never resumes capture. */
export async function stopCaptureCompanion({ descriptor, state, workspace, inspect, docker, expectedId }) {
  if (descriptor === null) return;
  descriptor = validateCaptureDescriptor(descriptor);
  hostState(state, workspace, descriptor);
  const helper = await inspect('container', descriptor.containerName);
  if (!helper && !expectedId) return;
  if (!helper || (expectedId && helper.Id !== expectedId)) fail('helper changed before stop');
  owned(helper, 'capture-helper', workspace);
  try {
    await docker('update', '--restart=no', helper.Id);
    await docker('stop', '--time', '10', helper.Id);
  } catch {
    fail('helper stop failed; inspect before changing household data');
  }
  const stopped = await inspect('container', descriptor.containerName);
  if (stopped?.Id !== helper.Id || stopped.State.Running || stopped.HostConfig.RestartPolicy?.Name !== 'no')
    fail('helper stop could not be verified');
}

/** Caller holds the same exclusive host upgrade lock used for activation and restore. */
export async function withCaptureCompanionUpgrade({
  descriptor,
  state,
  workspace,
  targetImage,
  inspect,
  docker,
  upgrade,
  wait = delay,
}) {
  if (descriptor === null) return upgrade();
  descriptor = validateCaptureDescriptor(descriptor);
  hostState(state, workspace, descriptor);
  const run = async (...args) => {
    try {
      return await docker(...args);
    } catch {
      fail('Docker operation failed; capture remains stopped pending inspection');
    }
  };
  let helper = await inspect('container', descriptor.containerName);
  if (!helper) {
    if (descriptor.enabled) fail('enabled helper is missing; activation is a separate operation');
    return upgrade();
  }
  owned(helper, 'capture-helper', workspace);
  let managedId = helper.Id;
  const pause = () =>
    stopCaptureCompanion({ descriptor, state, workspace, inspect, docker, expectedId: managedId });
  try {
    const oldApp = await inspect('container', state.container);
    appState(oldApp, state, workspace);
    const epoch = validateCaptureContainer(
      helper,
      descriptor,
      state,
      workspace,
      descriptor.enabled ? oldApp.Image : helper.Image,
    );
    owned(await inspect('volume', state.volume), 'phone-trial', workspace);
    owned(await inspect('volume', descriptor.socketVolumeName), 'capture-sockets', workspace);
    // Disable daemon restart before stopping, so a host restart during migration stays closed.
    await pause();
    if (!descriptor.enabled) return upgrade();
    const identity = async (app) => {
      const value = JSON.parse(await run('exec', app.Id, 'node', '-e', identityScript));
      if (
        value.installationId !== state.installationId ||
        value.epoch !== epoch ||
        !value.normal ||
        !value.schemaCurrent
      )
        fail('schema, installation or epoch needs explicit review');
    };
    await identity(oldApp);
    const target = await inspect('image', targetImage);
    if (!imageId(target?.Id)) fail('target image is not available');
    const result = await upgrade();
    const nextApp = await inspect('container', state.container);
    appState(nextApp, state, workspace, target.Id);
    await identity(nextApp);
    const current = await inspect('container', descriptor.containerName);
    if (current?.Id !== managedId || current.State.Running) fail('helper changed while the app upgraded');
    validateCaptureContainer(current, descriptor, state, workspace, oldApp.Image);
    owned(await inspect('volume', state.volume), 'phone-trial', workspace);
    owned(await inspect('volume', descriptor.socketVolumeName), 'capture-sockets', workspace);
    await run('rm', managedId); // No force, no volume removal; only the verified stopped container.
    managedId = '';
    await run(...captureCreateArguments({ descriptor, state, workspace, image: target.Id, epoch }));
    helper = await inspect('container', descriptor.containerName);
    owned(helper, 'capture-helper', workspace);
    managedId = helper.Id;
    // Accept only the fixed launcher and healthcheck forms generated above.
    validateCaptureContainer(helper, descriptor, state, workspace, target.Id);
    await run('start', managedId);
    for (let attempt = 0; attempt < 40; attempt++) {
      const live = await inspect('container', descriptor.containerName);
      if (live?.Id !== managedId) fail('helper changed during startup');
      validateCaptureContainer(live, descriptor, state, workspace, target.Id);
      if (live.State.Running && live.State.Health?.Status === 'healthy') {
        await run('update', '--restart=unless-stopped', managedId);
        return result;
      }
      if (!live.State.Running || live.State.Health?.Status === 'unhealthy') break;
      await wait(250);
    }
    fail('new helper did not become healthy');
  } catch (error) {
    if (managedId) {
      try {
        await pause();
      } catch {
        fail('upgrade failed and helper stop could not be verified; inspect before retrying');
      }
    }
    throw error;
  }
}
