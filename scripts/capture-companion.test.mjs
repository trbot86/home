import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  captureCreateArguments,
  captureHealthCommand,
  readCaptureDescriptor,
  stopCaptureCompanion,
  validateCaptureDescriptor,
  withCaptureCompanionUpgrade,
} from './capture-companion.mjs';

const oldImage = 'sha256:' + '1'.repeat(64),
  newImage = 'sha256:' + '2'.repeat(64);
const descriptor = { enabled: true, containerName: 'fixture-capture', socketVolumeName: 'fixture-sockets' };
function fixture() {
  const workspace = resolve('fixture-workspace');
  const state = {
    workspace,
    container: 'fixture-app',
    volume: 'fixture-data',
    installationId: 'fixture-installation',
  };
  const labels = (role) => ({ 'com.our-place.role': role, 'com.our-place.workspace': workspace });
  const mount = (Name, Destination) => ({ Type: 'volume', Name, Destination, RW: true });
  let app = {
    Id: 'app-before',
    Name: '/fixture-app',
    Image: oldImage,
    Config: { Labels: labels('phone-trial') },
    State: { Running: true, Health: { Status: 'healthy' } },
    Mounts: [mount(state.volume, '/data')],
  };
  const helperShape = () => ({
    Id: 'capture-before',
    Name: '/fixture-capture',
    Image: oldImage,
    Config: {
      Labels: labels('capture-helper'),
      User: '1000:1000',
      WorkingDir: '/app',
      Entrypoint: ['sh', 'apps/server/capture-entry.sh'],
      Cmd: [],
      Env: [
        'CAPTURE_ENABLED=1',
        'DATA_ROOT=/data',
        'EXPECTED_INSTALLATION_ID=fixture-installation',
        'CAPTURE_EXPECTED_SERVER_EPOCH=fixture-epoch',
        'CAPTURE_SOCKET=/sockets/capture.sock',
      ],
      Healthcheck: { Test: ['CMD', 'node', '-e', captureHealthCommand] },
    },
    State: { Running: true, Health: { Status: 'healthy' } },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges:true'],
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: {},
    },
    Mounts: [mount(state.volume, '/data'), mount(descriptor.socketVolumeName, '/sockets')],
  });
  let helper = helperShape(),
    epoch = 'fixture-epoch',
    serial = 0;
  const events = [],
    faults = {},
    volumes = {
      [state.volume]: { Name: state.volume, Labels: labels('phone-trial') },
      [descriptor.socketVolumeName]: { Name: descriptor.socketVolumeName, Labels: labels('capture-sockets') },
    };
  const inspect = async (kind, value) => {
    if (kind === 'container') return structuredClone(value === state.container ? app : helper);
    if (kind === 'volume') return structuredClone(volumes[value]);
    if (kind === 'image') return { Id: newImage };
    throw new Error('Unexpected inspection');
  };
  const docker = async (...args) => {
    events.push(args);
    const [action] = args;
    if (faults[action]) throw new Error('injected failure');
    if (action === 'exec')
      return JSON.stringify({
        installationId: state.installationId,
        epoch,
        normal: true,
        schemaCurrent: !faults.schema,
      });
    if (action === 'update') {
      assert.equal(args.at(-1), helper.Id);
      helper.HostConfig.RestartPolicy.Name = args[1].slice('--restart='.length);
    } else if (action === 'stop') {
      assert.equal(args.at(-1), helper.Id);
      helper.State.Running = false;
    } else if (action === 'rm') {
      assert.equal(args[1], helper.Id);
      assert.equal(helper.State.Running, false);
      assert.equal(args.length, 2);
      helper = null;
    } else if (action === 'create') {
      assert.equal(helper, null);
      helper = helperShape();
      helper.Id = 'capture-after-' + ++serial;
      helper.Image = newImage;
      helper.Config.Entrypoint = ['sh'];
      helper.Config.Cmd = ['apps/server/capture-entry.sh'];
      helper.Config.Healthcheck.Test = ['CMD-SHELL', args[args.indexOf('--health-cmd') + 1]];
      helper.HostConfig.RestartPolicy.Name = 'no';
      helper.State.Running = false;
      const env = [];
      for (let i = 0; i < args.length; i++) if (args[i] === '--env') env.push(args[i + 1]);
      helper.Config.Env = env;
    } else if (action === 'start') {
      assert.equal(args[1], helper.Id);
      helper.State.Running = true;
      helper.State.Health.Status = faults.health ? 'unhealthy' : 'healthy';
    } else throw new Error('Unexpected action');
    return '';
  };
  const upgrade = async () => {
    events.push(['upgrade']);
    if (faults.upgrade) throw new Error('injected upgrade failure');
    app = { ...app, Id: 'app-after', Image: faults.image ? oldImage : newImage };
    if (faults.restore) epoch = 'restored-epoch';
    return 'app-upgraded';
  };
  return {
    workspace,
    state,
    descriptor: structuredClone(descriptor),
    events,
    inspect,
    docker,
    faults,
    volumes,
    get helper() {
      return helper;
    },
    set helper(value) {
      helper = value;
    },
    run(options = {}) {
      return withCaptureCompanionUpgrade({
        descriptor: this.descriptor,
        state,
        workspace,
        targetImage: newImage,
        inspect,
        docker,
        upgrade,
        wait: async () => {},
        ...options,
      });
    },
  };
}

test('unconfigured host stays unchanged; descriptor is bounded and rejects extra authority', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capture-descriptor-'));
  try {
    assert.equal(await readCaptureDescriptor(join(root, 'absent.json')), null);
    await writeFile(join(root, 'valid.json'), JSON.stringify(descriptor));
    assert.deepEqual(await readCaptureDescriptor(join(root, 'valid.json')), descriptor);
    for (const value of [
      { ...descriptor, token: 'forbidden' },
      { ...descriptor, enabled: 'true' },
      { ...descriptor, containerName: '../other' },
      { ...descriptor, socketVolumeName: 'x,y' },
      null,
    ])
      assert.throws(() => validateCaptureDescriptor(value));
    await writeFile(join(root, 'oversize.json'), ' '.repeat(4097));
    await assert.rejects(readCaptureDescriptor(join(root, 'oversize.json')));
    let called = false;
    assert.equal(
      await withCaptureCompanionUpgrade({
        descriptor: null,
        upgrade: async () => {
          called = true;
          return 7;
        },
      }),
      7,
    );
    assert.ok(called);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('upgrade stops the old writer before app changes and recreates with the immutable current image', async () => {
  const f = fixture();
  assert.equal(await f.run(), 'app-upgraded');
  const actions = f.events.map((x) => x[0]);
  assert.ok(actions.indexOf('stop') < actions.indexOf('upgrade'));
  assert.ok(actions.indexOf('upgrade') < actions.indexOf('rm'));
  assert.ok(actions.indexOf('rm') < actions.indexOf('create'));
  assert.equal(f.helper.Image, newImage);
  assert.equal(f.helper.State.Running, true);
  assert.equal(f.helper.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.deepEqual(
    f.helper.Mounts.map((m) => m.Name),
    ['fixture-data', 'fixture-sockets'],
  );
  const create = f.events.find((x) => x[0] === 'create');
  assert.deepEqual(create.slice(-3), ['sh', newImage, 'apps/server/capture-entry.sh']);
  assert.ok(!f.events.some((x) => x[0] === 'volume' || x.includes('--force')));
  // The generated Docker entrypoint/command/healthcheck remains valid on subsequent upgrades.
  assert.equal(await f.run(), 'app-upgraded');
});

test('disabled companion is stopped and never recreated; missing enabled companion is not auto-provisioned', async () => {
  const f = fixture();
  f.descriptor.enabled = false;
  await f.run();
  await f.run(); // A disabled old-image helper must not obstruct later app upgrades.
  assert.equal(f.helper.State.Running, false);
  assert.equal(f.helper.HostConfig.RestartPolicy.Name, 'no');
  assert.ok(!f.events.some((x) => ['create', 'start', 'rm'].includes(x[0])));
  const missing = fixture();
  missing.helper = null;
  await assert.rejects(missing.run(), /missing/);
  assert.deepEqual(missing.events, []);
});

test('foreign ownership is never altered', async () => {
  const f = fixture();
  f.helper.Config.Labels['com.our-place.workspace'] = resolve('other-workspace');
  await assert.rejects(f.run(), /ownership/);
  assert.deepEqual(f.events, []);
});

test('runtime, image, mount, identity and volume mismatches stop owned capture and block upgrade', async () => {
  const mutations = [
    (f) => {
      f.helper.Image = newImage;
    },
    (f) => {
      f.helper.HostConfig.NetworkMode = 'host';
    },
    (f) => {
      f.helper.HostConfig.Privileged = true;
    },
    (f) => {
      f.helper.HostConfig.CapAdd = ['NET_ADMIN'];
    },
    (f) => {
      f.helper.HostConfig.PortBindings = { '3000/tcp': [{}] };
    },
    (f) => {
      f.helper.Mounts.push({ Type: 'bind', Destination: '/extra', RW: true });
    },
    (f) => {
      f.helper.Config.Env.push('CAPTURE_PORT=3000');
    },
    (f) => {
      f.helper.Config.Env[2] = 'EXPECTED_INSTALLATION_ID=other';
    },
    (f) => {
      f.helper.Config.Env[3] = 'CAPTURE_EXPECTED_SERVER_EPOCH=old-epoch';
    },
    (f) => {
      f.helper.Config.Entrypoint = ['node', 'apps/server/dist/capture-main.js'];
    },
    (f) => {
      f.volumes['fixture-sockets'].Labels['com.our-place.role'] = 'unrelated';
    },
    (f) => {
      f.faults.schema = true;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.run());
    assert.equal(f.helper.State.Running, false);
    assert.equal(f.helper.HostConfig.RestartPolicy.Name, 'no');
    assert.ok(!f.events.some((x) => x[0] === 'upgrade'));
  }
});

test('app upgrade, restore epoch, image and helper startup failures leave capture stopped', async () => {
  for (const fault of ['upgrade', 'restore', 'image', 'health', 'start', 'create']) {
    const f = fixture();
    f.faults[fault] = true;
    await assert.rejects(f.run());
    if (f.helper) {
      assert.equal(f.helper.State.Running, false, fault);
      assert.equal(f.helper.HostConfig.RestartPolicy.Name, 'no', fault);
    }
    assert.ok(!f.events.some((x) => x[1] === '--restart=unless-stopped'));
  }
});

test('cannot proceed if stopping capture fails', async () => {
  const f = fixture();
  f.faults.stop = true;
  await assert.rejects(f.run(), /stop could not be verified/);
  assert.ok(!f.events.some((x) => x[0] === 'upgrade'));
});

test('explicit stop/restore hook disables restart and never starts an owned helper', async () => {
  const f = fixture();
  await stopCaptureCompanion({
    descriptor,
    state: f.state,
    workspace: f.workspace,
    inspect: f.inspect,
    docker: f.docker,
  });
  assert.equal(f.helper.State.Running, false);
  assert.equal(f.helper.HostConfig.RestartPolicy.Name, 'no');
  assert.deepEqual(
    f.events.map((x) => x[0]),
    ['update', 'stop'],
  );
  const other = fixture();
  other.helper.Config.Labels['com.our-place.role'] = 'unrelated';
  await assert.rejects(
    stopCaptureCompanion({
      descriptor,
      state: other.state,
      workspace: other.workspace,
      inspect: other.inspect,
      docker: other.docker,
    }),
  );
  assert.deepEqual(other.events, []);
});

test('creation arguments cannot alias the data volume or app name, or select mutable images', () => {
  const f = fixture(),
    args = { descriptor, state: f.state, workspace: f.workspace, image: newImage, epoch: 'fixture-epoch' };
  assert.throws(() => captureCreateArguments({ ...args, image: 'app:latest' }));
  assert.throws(() =>
    captureCreateArguments({ ...args, descriptor: { ...descriptor, containerName: f.state.container } }),
  );
  assert.throws(() =>
    captureCreateArguments({ ...args, descriptor: { ...descriptor, socketVolumeName: f.state.volume } }),
  );
});
