import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';

const execute = promisify(execFile);
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const project = `alexa-rehearsal-${Date.now()}-${randomBytes(3).toString('hex')}`;
const label = 'com.our-place.alexa-rehearsal';
const reportDir = resolve('.local/alexa/rehearsals', project);
await mkdir(reportDir, { recursive: true });
const resources = { containers: [], networks: [], volumes: [] };
const report = {
  project,
  checks: {},
  resources,
  targets: [],
  failures: [],
  startedAt: new Date().toISOString(),
};
const image = 'our-place-alexa-rehearsal:review';
const guardImage = 'our-place-alexa-network:review';
async function docker(...command) {
  try {
    const result = await execute('docker', command, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
    return (command[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
  } catch (error) {
    // Private target addresses, fixture credentials and daemon diagnostics stay local.
    await writeFile(
      join(reportDir, `command-error-${report.failures.length}.log`),
      String(error.stderr ?? error.message),
    );
    throw new Error(`Docker ${command[0]} failed; see private rehearsal report`);
  }
}
async function inspect(name) {
  return JSON.parse(await docker('inspect', name))[0];
}
function safeName(name) {
  assert.ok(name.startsWith(project + '-'));
}
async function create(name, options, command) {
  safeName(name);
  await docker('create', '--name', name, '--label', `${label}=${project}`, ...options, ...command);
  resources.containers.push(name);
  const state = await inspect(name);
  assert.equal(state.Config.Labels[label], project);
  assert.notEqual(state.HostConfig.NetworkMode, 'host');
  assert.equal(state.HostConfig.Privileged, false);
  assert.ok(state.Mounts.every((mount) => mount.Type === 'volume' && mount.Name.startsWith(project + '-')));
  return name;
}
async function start(name) {
  await docker('start', name);
}
async function waitFor(name, predicate, message, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const state = await inspect(name);
    if (predicate(state)) return state;
    if (state.State.Status === 'exited' || state.State.Status === 'dead') throw new Error(message);
    await delay(150);
  }
  throw new Error(message);
}
async function waitGuard(name) {
  return waitFor(
    name,
    (state) => state.State.Health?.Status === 'healthy',
    'Network guard did not become healthy',
  );
}
const constrained = [
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--memory',
  '384m',
  '--pids-limit',
  '64',
  '--tmpfs',
  '/tmp:size=64m,mode=1777',
];
async function execMode(container, mode, env = {}) {
  const values = Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const output = await docker(
    'exec',
    ...values,
    container,
    'node',
    '--import',
    'tsx',
    'scripts/alexa-rehearsal-service.ts',
    mode,
  );
  return JSON.parse(output);
}
const fingerprint = (state) => ({
  id: state.Id,
  image: state.Image,
  started: state.State.StartedAt,
  mounts: state.Mounts,
});
let householdBefore;
const household = option('--household-container');
const guard = `${project}-guard`,
  sentinel = `${project}-sentinel`,
  receiver = `${project}-receiver`,
  capture = `${project}-capture`;
const network = `${project}-network`;
const volumes = Object.fromEntries(
  ['sockets', 'fixture', 'requests', 'data'].map((name) => [name, `${project}-${name}`]),
);
const helperOptions = [
  ...constrained,
  '--network',
  'none',
  '--volume',
  `${volumes.sockets}:/sockets`,
  '--volume',
  `${volumes.fixture}:/fixture`,
  '--volume',
  `${volumes.data}:/test-data`,
];
try {
  if (!args.includes('--skip-build')) {
    console.log('Building isolated rehearsal images...');
    await docker('build', '-f', 'ops/alexa-network.Dockerfile', '-t', guardImage, '.');
    await docker('build', '-f', 'ops/alexa-rehearsal.Dockerfile', '-t', image, '.');
  }
  if (household) {
    const live = await inspect(household);
    assert.equal(live.Config.Labels['com.our-place.role'], 'phone-trial');
    householdBefore = fingerprint(live);
    for (const [name, endpoint] of Object.entries(live.NetworkSettings.Networks)) {
      if (endpoint.IPAddress)
        report.targets.push({ name: `household-container-${name}`, host: endpoint.IPAddress, port: 3000 });
      if (endpoint.GlobalIPv6Address)
        report.targets.push({
          name: `household-container-ipv6-${name}`,
          host: endpoint.GlobalIPv6Address,
          port: 3000,
          family: 6,
        });
    }
    for (const ports of Object.values(live.NetworkSettings.Ports))
      for (const port of ports ?? [])
        report.targets.push({
          name: 'household-host-port',
          host: 'host.docker.internal',
          port: Number(port.HostPort),
        });
  }
  if (option('--host-config')) {
    const config = JSON.parse(await readFile(option('--host-config'), 'utf8'));
    const url = new URL(config.origin);
    for (const address of await lookup(url.hostname, { all: true }))
      report.targets.push({
        name: `household-tailnet-v${address.family}`,
        host: address.address,
        port: Number(url.port || 443),
        family: address.family,
      });
  }
  await docker('network', 'create', '--ipv6', '--label', `${label}=${project}`, network);
  resources.networks.push(network);
  for (const volume of Object.values(volumes)) {
    await docker('volume', 'create', '--label', `${label}=${project}`, volume);
    resources.volumes.push(volume);
  }
  const guardOptions = [
    ...constrained,
    '--network',
    network,
    '--dns',
    '1.1.1.1',
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'SETUID',
    '--cap-add',
    'SETGID',
    '--cap-add',
    'SETPCAP',
    '--tmpfs',
    '/run/guard:size=1m,mode=0755',
  ];
  const badGuard = `${project}-bad-guard`;
  await create(badGuard, guardOptions, [guardImage]);
  await start(badGuard);
  await assert.rejects(waitGuard(badGuard), /did not become healthy/);
  report.checks.failedGuardBlocksStartup = true;
  await create(guard, [...guardOptions, '--env', 'ALEXA_NETWORK_GUARD=isolated-namespace'], [guardImage]);
  await start(guard);
  await waitGuard(guard);
  console.log('Network guard healthy; testing positive controls and denied routes...');
  await create(
    sentinel,
    [...constrained, '--network', network, '--network-alias', 'rehearsal-sentinel'],
    [image, 'sentinel'],
  );
  await start(sentinel);
  const sentinelState = await inspect(sentinel);
  const endpoint = sentinelState.NetworkSettings.Networks[network];
  const positive = [
    { name: 'synthetic-neighbor-ipv4', host: endpoint.IPAddress, port: 8443 },
    { name: 'synthetic-neighbor-dns', host: 'rehearsal-sentinel', port: 8443 },
    { name: 'synthetic-neighbor-ipv6', host: endpoint.GlobalIPv6Address, port: 8443, family: 6 },
  ];
  assert.ok(positive.every((target) => target.host));
  await waitFor(sentinel, (state) => state.State.Running, 'Sentinel did not start');
  await delay(500);
  const control = await execMode(sentinel, 'probe', { REHEARSAL_TARGETS: JSON.stringify(positive) });
  assert.ok(control.results.every((result) => result.connected));
  report.checks.positiveControls = control;
  await create(capture, helperOptions, [image, 'capture']);
  await start(capture);
  await waitGuard(guard); // The receiver is never created before successful guard setup.
  await create(
    receiver,
    [
      ...constrained,
      '--network',
      `container:${guard}`,
      '--volume',
      `${volumes.sockets}:/sockets:ro`,
      '--volume',
      `${volumes.fixture}:/fixture:ro`,
      '--volume',
      `${volumes.requests}:/requests`,
    ],
    [image, 'receiver'],
  );
  await start(receiver);
  for (let i = 0; i < 60; i++) {
    const ready = await execMode(receiver, 'probe', {
      REHEARSAL_TARGETS: JSON.stringify([{ name: 'loopback', host: '127.0.0.1', port: 3000 }]),
    });
    if (ready.results[0].connected) break;
    if (i === 59) throw new Error('Receiver startup timed out');
    await delay(100);
  }
  const guardState = await inspect(guard);
  const gateway = guardState.NetworkSettings.Networks[network].Gateway;
  report.targets.push(
    ...positive,
    { name: 'docker-gateway', host: gateway, port: 443 },
    { name: 'mapped-ipv4', host: `::ffff:${endpoint.IPAddress}`, port: 8443 },
  );
  const denied = await execMode(receiver, 'probe', { REHEARSAL_TARGETS: JSON.stringify(report.targets) });
  assert.ok(
    denied.results.every((result) => !result.connected),
    'Protected namespace reached a denied target',
  );
  report.checks.deniedRoutes = denied;
  report.checks.amazonCertificate = await execMode(receiver, 'outbound');
  report.checks.captureNoNetwork = await execMode(capture, 'capture-network');
  report.checks.capture = await execMode(receiver, 'exercise');
  const capabilities = await docker(
    'exec',
    receiver,
    'node',
    '-e',
    String.raw`const fs=require('node:fs'); console.log(fs.readFileSync('/proc/self/status','utf8').split('\n').filter(x=>/^(Uid|CapEff|CapBnd):/.test(x)).join('\n'))`,
  );
  assert.match(capabilities, /CapEff:\s+0+\s/);
  assert.match(capabilities, /CapBnd:\s+0+\s*$/);
  report.checks.receiverCapabilitiesDropped = true;
  report.firewall = await docker('exec', guard, 'iptables-save', '-c', '-t', 'filter');
  report.ipv6Firewall = await docker('exec', guard, 'ip6tables-save', '-c', '-t', 'filter');
  console.log('Capture, certificate fetch and denied routes passed; testing abrupt helper restart...');
  const duplicate = `${project}-duplicate-capture`;
  await create(duplicate, helperOptions, [image, 'capture']);
  await start(duplicate);
  await waitFor(duplicate, (state) => state.State.Status === 'exited', 'Duplicate helper did not exit');
  assert.equal((await inspect(duplicate)).State.ExitCode, 1);
  assert.equal((await inspect(duplicate)).State.Running, false);
  report.checks.duplicateHelperRejected = true;
  await docker('kill', '--signal', 'KILL', capture);
  const stale = await docker(
    'exec',
    receiver,
    'node',
    '-e',
    "const fs=require('node:fs'); console.log(fs.lstatSync('/sockets/capture.sock').isSocket())",
  );
  assert.equal(stale, 'true');
  await start(capture);
  await delay(600);
  report.checks.afterKill = await execMode(receiver, 'exercise', { EXPECT_REPLAY: '1' });
  report.checks.staleSocketRecovered = true;
  // A receiver restart keeps the same namespace restrictions; this probe does not resubmit a note.
  await docker('restart', receiver);
  await delay(500);
  const afterRestart = await execMode(receiver, 'probe', {
    REHEARSAL_TARGETS: JSON.stringify(report.targets),
  });
  assert.ok(afterRestart.results.every((result) => !result.connected));
  report.checks.receiverRestartStillIsolated = true;
  if (household) assert.deepEqual(fingerprint(await inspect(household)), householdBefore);
  report.checks.liveContainerUnchanged = Boolean(household);
  report.success = true;
  console.log('PASS: isolated rehearsal, signed capture/retry, SIGKILL recovery and network denials.');
} catch (error) {
  report.failures.push(String(error.message));
  process.exitCode = 1;
  console.error(`FAIL: ${error.message}`);
} finally {
  for (const name of resources.containers) {
    try {
      await writeFile(join(reportDir, `${name}.log`), await docker('logs', name));
    } catch {
      /* keep primary failure */
    }
  }
  // Every deletion is restricted to a resource created by this run and carrying its exact label.
  for (const name of [...resources.containers].reverse()) {
    try {
      safeName(name);
      assert.equal((await inspect(name)).Config.Labels[label], project);
      await docker('rm', '--force', name);
    } catch (error) {
      report.failures.push(`Container cleanup failed: ${name}`);
      process.exitCode = 1;
    }
  }
  for (const name of resources.volumes) {
    try {
      safeName(name);
      const item = JSON.parse(await docker('volume', 'inspect', name))[0];
      assert.equal(item.Labels[label], project);
      await docker('volume', 'rm', name);
    } catch {
      report.failures.push(`Volume cleanup failed: ${name}`);
      process.exitCode = 1;
    }
  }
  for (const name of resources.networks) {
    try {
      safeName(name);
      const item = JSON.parse(await docker('network', 'inspect', name))[0];
      assert.equal(item.Labels[label], project);
      await docker('network', 'rm', name);
    } catch {
      report.failures.push(`Network cleanup failed: ${name}`);
      process.exitCode = 1;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Private report: .local/alexa/rehearsals/${project}/report.json`);
}
