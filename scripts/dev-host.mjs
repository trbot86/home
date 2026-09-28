import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { acquireLock } from './suggestion-bridge/journal.mjs';
import {
  readCaptureDescriptor,
  withCaptureCompanionUpgrade,
  stopCaptureCompanion,
} from './capture-companion.mjs';

const exec = promisify(execFile);
const workspace = resolve(import.meta.dirname, '..');
const root = join(workspace, '.local/phone-trial');
const statePath = join(root, 'host.json');
const accountPath = join(root, 'accounts.json');
const envPath = join(root, 'host.env');
const volume = 'our-place-dev-data',
  container = 'our-place-dev',
  image = process.env.OUR_PLACE_IMAGE || 'our-place:development';
const port = 8443,
  upstream = 'http://127.0.0.1:3174';
const docker = async (...args) =>
  (await exec('docker', args, { cwd: workspace, maxBuffer: 4 * 1024 ** 2, windowsHide: true })).stdout.trim();
const tailscale = async (...args) =>
  (
    await exec('tailscale', args, { cwd: workspace, timeout: 20000, maxBuffer: 1024 ** 2, windowsHide: true })
  ).stdout.trim();
const mounts = ['--mount', `type=volume,source=${volume},target=/data`];
const labels = [
  '--label',
  'com.our-place.role=phone-trial',
  '--label',
  `com.our-place.workspace=${workspace}`,
];
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
async function optionalJson(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function inspect(kind, name) {
  try {
    return JSON.parse(await docker(kind, 'inspect', name))[0];
  } catch (error) {
    if (/No such (volume|object|container)/i.test(error.stderr ?? '')) return null;
    throw error;
  }
}
function requireOwned(resource) {
  const value = resource?.Labels ?? resource?.Config?.Labels;
  if (
    value?.['com.our-place.role'] !== 'phone-trial' ||
    value?.['com.our-place.workspace']?.replaceAll('\\', '/') !== workspace.replaceAll('\\', '/')
  )
    throw new Error('An existing resource is not owned by this workspace; refusing to alter it.');
}
async function requireState() {
  const state = await readJson(statePath);
  if (state.workspace !== workspace || !state.installationId)
    throw new Error('Incomplete or foreign trial configuration');
  return state;
}
async function compose(...args) {
  const filing = await optionalJson(join(root, 'filing-worker.json'));
  if (filing && (filing.repository !== workspace || filing.isolationReviewed !== true))
    throw new Error('Invalid local filing worker activation');
  return docker(
    'compose',
    '--env-file',
    envPath,
    '-f',
    'ops/compose.dev.yaml',
    ...(filing ? ['-f', 'ops/filing-worker/app.compose.yaml'] : []),
    ...args,
  );
}
async function provision(config) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      'docker',
      ['run', '--rm', '-i', ...mounts, image, 'node', 'apps/server/dist/bootstrap.js'],
      { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (bytes) => (stdout += bytes));
    child.stderr.on('data', (bytes) => (stderr += bytes));
    child.on('error', reject);
    child.on('exit', (code) => {
      const id = stdout.match(/EXPECTED_INSTALLATION_ID=([a-f0-9-]+)/)?.[1];
      code === 0 && id ? resolvePromise(id) : reject(new Error(stderr || 'Bootstrap identity missing'));
    });
    child.stdin.end(JSON.stringify(config));
  });
}
async function installationId() {
  const script =
    "const fs=require('node:fs');const p='/data/db/household.sqlite';if(!fs.existsSync(p)){console.log('');process.exit(0)};const D=require('./apps/server/node_modules/better-sqlite3');const db=new D(p,{readonly:true});const table=db.prepare(\"SELECT 1 FROM sqlite_master WHERE name='installation_state'\").get();console.log(table?(db.prepare('SELECT installation_id FROM installation_state WHERE singleton=1').get()?.installation_id??''):'');db.close();";
  return docker('run', '--rm', ...mounts, image, 'node', '-e', script);
}
async function prepare() {
  await mkdir(root, { recursive: true });
  const previous = await optionalJson(statePath);
  if (previous && previous.workspace !== workspace) throw new Error('Trial belongs to a different workspace');
  const network = JSON.parse(await tailscale('status', '--json'));
  if (network.BackendState !== 'Running' || !network.Self?.DNSName)
    throw new Error('Connect this PC to Tailscale first');
  const hostname = network.Self.DNSName.replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.ts\.net$/.test(hostname)) throw new Error('Unexpected Tailscale hostname');
  const origin = `https://${hostname}:${port}`;
  if (previous?.origin && previous.origin !== origin)
    throw new Error('Tailscale hostname changed; review the existing trial before changing its origin');
  const existingVolume = await inspect('volume', volume);
  if (existingVolume) requireOwned(existingVolume);
  else await docker('volume', 'create', ...labels, volume);
  let accounts = await optionalJson(accountPath);
  if (!accounts) {
    if (existingVolume && (await installationId()))
      throw new Error('Existing household has no local trial account file; refusing to invent replacements');
    accounts = {
      people: [
        { username: 'you', displayName: 't', password: randomBytes(18).toString('base64url') },
        { username: 'partner', displayName: 'b', password: randomBytes(18).toString('base64url') },
      ],
    };
    await writeFile(accountPath, JSON.stringify(accounts, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  const identity = (await installationId()) || (await provision(accounts));
  if (previous?.installationId && previous.installationId !== identity)
    throw new Error('Household identity changed');
  const backupRoot = join(root, 'backups');
  await mkdir(backupRoot, { recursive: true });
  const marker = await optionalJson(join(backupRoot, '.our-place-backups.json'));
  if (marker && marker.installationId !== identity)
    throw new Error('Backup directory belongs to a different installation');
  if (!marker)
    await docker(
      'run',
      '--rm',
      ...mounts,
      '--mount',
      `type=bind,source=${backupRoot},target=/backups`,
      image,
      'node',
      'apps/server/dist/operations.js',
      'init-backups',
      '/backups',
    );
  const state = {
    workspace,
    origin,
    installationId: identity,
    volume,
    container,
    backupRoot,
    port,
    upstream,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n');
  const envValue = (value) => JSON.stringify(value.replaceAll('\\', '/'));
  await writeFile(
    envPath,
    `OUR_PLACE_WORKSPACE=${envValue(workspace)}\nPUBLIC_ORIGIN=${origin}\nEXPECTED_INSTALLATION_ID=${identity}\nBACKUP_OUTPUT_DIR=${envValue(backupRoot)}\n`,
  );
  await publishClient(state);
  console.log(`Prepared private phone trial at ${origin}. Account details remain in ${accountPath}.`);
}
async function publishClient(state) {
  const directory = join(root, 'install');
  await mkdir(directory, { recursive: true });
  const source = join(
    process.env.OUR_PLACE_CLIENT_SOURCE || workspace,
    'apps/android/app/build/outputs/apk/debug/app-debug.apk',
  );
  const bytes = await readFile(source);
  const digest = createHash('sha256').update(bytes).digest('hex');
  await copyFile(source, join(directory, 'our-place-debug.apk'));
  const templates = join(workspace, 'scripts/phone-trial');
  const html = (await readFile(join(templates, 'index.html'), 'utf8'))
    .replaceAll('{{origin}}', state.origin)
    .replaceAll('{{digest}}', digest)
    .replaceAll('{{updatedAt}}', new Date().toISOString());
  await writeFile(join(directory, 'index.html'), html);
  for (const asset of ['install.css', 'install.js'])
    await copyFile(join(templates, asset), join(directory, asset));
  await copyFile(join(workspace, 'apps/web/src/ui/tokens.css'), join(directory, 'theme.css'));
  await writeFile(
    join(directory, 'build.json'),
    JSON.stringify(
      { sha256: digest, bytes: bytes.length, builtAt: (await stat(source)).mtime.toISOString() },
      null,
      2,
    ),
  );
}
async function start() {
  const state = await requireState();
  const existing = await inspect('container', container);
  if (existing) requireOwned(existing);
  requireOwned(await inspect('volume', volume));
  console.log(await compose('up', '-d'));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${upstream}/health`)).ok) {
        console.log(`Backend healthy; expected public origin ${state.origin}`);
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Trial did not become healthy; inspect docker logs our-place-dev');
}
async function upgrade() {
  const unlock = await acquireLock(join(root, 'upgrade.lock'));
  try {
    await upgradeLocked();
  } finally {
    await unlock();
  }
}
async function upgradeLocked() {
  return withCaptureCompanionUpgrade({
    descriptor: await readCaptureDescriptor(join(root, 'capture-companion.json')),
    state: await requireState(),
    workspace,
    targetImage: image,
    inspect,
    docker,
    upgrade: upgradeAppLocked,
  });
}
async function upgradeAppLocked() {
  const state = await requireState();
  const existing = await inspect('container', container);
  if (existing) requireOwned(existing);
  requireOwned(await inspect('volume', volume));
  if ((await installationId()) !== state.installationId)
    throw new Error('Live installation identity differs from this trial; refusing to upgrade.');
  console.log(await compose('stop', 'household'));
  try {
    console.log(
      await compose(
        'run',
        '--rm',
        '--no-deps',
        'household',
        'node',
        'apps/server/dist/operations.js',
        'upgrade',
      ),
    );
  } catch (error) {
    throw new Error(
      `Upgrade did not complete. Data is preserved and the app remains stopped for inspection. ${error.stderr ?? error.message}`,
    );
  }
  await start();
}
async function enableHttps() {
  const state = await requireState();
  const config = JSON.parse(await tailscale('serve', 'status', '--json'));
  if (!(await fetch(`${upstream}/health`)).ok)
    throw new Error('Start the healthy trial backend before enabling HTTPS');
  const key = `${new URL(state.origin).hostname}:${port}`;
  if (config.AllowFunnel?.[key])
    throw new Error('That endpoint has Funnel enabled; choose a different private endpoint');
  const handlers = config.Web?.[key]?.Handlers ?? {};
  if (config.TCP?.[port] && !handlers['/']) throw new Error('Port already belongs to another Serve service');
  if (handlers['/'] && handlers['/'].Proxy !== upstream)
    throw new Error('Existing Serve route belongs to another app');
  const installHandler = handlers['/install/'] ?? handlers['/install'];
  if (installHandler)
    throw new Error('A separate Serve install route exists; review it before using the app install route');
  if (!(await fetch(`${upstream}/install/`)).ok)
    throw new Error('Publish the Android client and start the updated backend before enabling HTTPS');
  console.log(await tailscale('serve', '--bg', `--https=${port}`, upstream));
  console.log(`Install on Android: ${state.origin}/install/`);
}
async function main() {
  const action = process.argv[2] ?? 'status';
  if (action === 'prepare') await prepare();
  else if (action === 'start') await start();
  else if (action === 'upgrade') await upgrade();
  else if (action === 'enable-https') await enableHttps();
  else if (action === 'publish-client') {
    await publishClient(await requireState());
    console.log('Refreshed the private Android download.');
  } else if (action === 'stop') {
    const unlock = await acquireLock(join(root, 'upgrade.lock'));
    try {
      const state = await requireState();
      const existing = await inspect('container', container);
      if (existing) requireOwned(existing);
      await stopCaptureCompanion({
        descriptor: await readCaptureDescriptor(join(root, 'capture-companion.json')),
        state,
        workspace,
        inspect,
        docker,
      });
      if (existing) console.log(await compose('stop'));
    } finally {
      await unlock();
    }
  } else if (action === 'status') {
    const state = await requireState();
    const existing = await inspect('container', container);
    if (existing) requireOwned(existing);
    const config = JSON.parse(await tailscale('serve', 'status', '--json'));
    const handlers = config.Web?.[`${new URL(state.origin).hostname}:${port}`]?.Handlers;
    console.log(
      JSON.stringify(
        {
          intendedOrigin: state.origin,
          httpsRouteConfigured: handlers?.['/']?.Proxy === upstream,
          installationId: state.installationId,
          container: existing?.State?.Status ?? 'absent',
          backupRoot: state.backupRoot,
          intendedInstallPage: `${state.origin}/install/`,
        },
        null,
        2,
      ),
    );
  } else throw new Error('Use prepare, start, upgrade, enable-https, publish-client, stop or status.');
}
await main().catch((error) => {
  const activation = error.stdout?.match(
    /https:\/\/login\.tailscale\.com\/f\/serve\?node=[A-Za-z0-9_-]+/,
  )?.[0];
  if (activation)
    console.error(
      `The local app is ready. Tailscale account activation is required: ${activation}\nAfter enabling Serve/HTTPS, rerun: node scripts/dev-host.mjs enable-https`,
    );
  else console.error(error.message);
  process.exitCode = activation ? 2 : 1;
});
