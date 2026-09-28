# Capture companion lifecycle

The capture helper must use the same complete server image as the household app.
`scripts/capture-companion.mjs` manages its lifecycle around the existing host
upgrade procedure. It does not provision credentials, activate ingress, create a
household, run a migration, or restore data. Those remain explicit operations.

## Private descriptor and ownership

The main host workspace may contain
`.local/phone-trial/capture-companion.json` with exactly these fields:

```json
{
  "enabled": true,
  "containerName": "capture-helper",
  "socketVolumeName": "capture-sockets"
}
```

These are example names. Actual names, installation IDs, receiver configuration,
credentials and reports stay in ignored local storage. A missing descriptor
preserves the existing app-only upgrade behavior; malformed/unreadable content
aborts the operation. The descriptor contains no credentials or executable paths.

The helper has `com.our-place.role=capture-helper` and a
`com.our-place.workspace` label matching the main host workspace. Its socket
volume has role `capture-sockets` and the same workspace label. The data volume
retains its existing `phone-trial` role/workspace labels. The helper mounts only
the existing data volume at `/data` and the dedicated socket volume at `/sockets`;
the receiver mounts only the socket volume read-only, never the data volume.
Never relabel/adopt an unrelated existing resource.

The helper uses UID/GID 1000, a read-only root filesystem, no network, no added
capabilities, no published ports and `no-new-privileges`. It starts through
`sh apps/server/capture-entry.sh`, preserving the socket lifetime lock. Required
bindings are `CAPTURE_ENABLED=1`, `DATA_ROOT=/data`,
`EXPECTED_INSTALLATION_ID`, `CAPTURE_EXPECTED_SERVER_EPOCH`, and
`CAPTURE_SOCKET=/sockets/capture.sock`. The epoch variable makes a manually
restarted managed helper refuse a restored database until reviewed. The generic
launcher still accepts older callers without this variable, but the managed
lifecycle hook requires it.

## Host wiring

Call the wrapper **inside the existing exclusive `upgrade.lock`**, and hold that
same lock for initial activation, explicit stop, restore and descriptor changes.
The existing `inspect(kind, name)` adapter must return null only for genuinely
missing resources; Docker/permission/parse failures must throw. `docker(...args)`
must execute argument arrays directly, without a shell, and reject failures.

The main task owns `scripts/dev-host.mjs`. Its existing upgrade body can become
`upgradeAppLocked`, with the wrapper inserted as follows:

```javascript
import {
  readCaptureDescriptor,
  withCaptureCompanionUpgrade,
  stopCaptureCompanion,
} from './capture-companion.mjs';

async function upgradeLocked() {
  const state = await requireState();
  const descriptor = await readCaptureDescriptor(join(root, 'capture-companion.json'));
  return withCaptureCompanionUpgrade({
    descriptor,
    state,
    workspace,
    targetImage: image,
    inspect,
    docker,
    upgrade: upgradeAppLocked,
  });
}
```

`upgradeAppLocked` must retain all existing ownership/installation checks,
backup-verifying upgrade behavior, and app-health verification. It must not
recursively acquire the lock. The wrapper resolves the target image to an
immutable ID, then requires the resulting app and helper to use that exact image.

Before an explicit host stop or restore, call `stopCaptureCompanion` with
`{ descriptor, state, workspace, inspect, docker }` under the same lock, before
stopping the app or changing its data. Do not resume capture automatically after
restore. The restored epoch and receiver binding require explicit review; restore
mode must have been resolved before activation. This module does not add a new
restore command or authorize overwriting data.

The upgrade wrapper disables the helper's Docker restart policy and stops its
writer before the app's backup/upgrade callback. It checks current schema
checksums, installation and epoch both before and after the app upgrade. It then
removes only the verified stopped container, retaining both volumes, and recreates
it from the new app image. Restart policy stays disabled until socket health is
verified. Failures leave capture stopped; no automatic rollback or replay occurs.
The app may already have upgraded successfully if helper startup fails, so report
that partial state accurately instead of claiming the whole release rolled back.

An explicitly disabled descriptor stops an existing owned helper and never
recreates it. Its retained older image does not obstruct subsequent app upgrades.
An enabled descriptor with a missing helper fails rather than silently activating
a new writer. Initial activation remains a separate, reviewed operation.

## Initial activation and validation

Use the current complete app image, not an image built from the older Alexa-only
branch. Verify a backup and perform an isolated restore rehearsal first. Provision
the integration using `capture-admin`, preserving the installation and epoch, and
prepare a newly owned socket volume with owner 1000 and mode 0700.

Under the upgrade lock, durably write an **enabled:false** descriptor before
creating or starting the helper. This lets a later upgrade stop a helper even if
activation crashes midway. `captureCreateArguments` constructs the restricted
container with restart disabled; it does not create volumes or write the
descriptor. Verify its image, mounts, pinned identity/epoch, socket mode 0600 and
health, then durably switch the descriptor to enabled:true before enabling
`unless-stopped` restart and connecting the receiver. Do not mount administrator
credentials into either listener. Retain the old receiver configuration for
reversible disconnection, and do not copy synthetic notes into the household.

Run the deterministic failure-path tests with:

```powershell
node --test scripts/capture-companion.test.mjs
```

The optional Docker rehearsal uses uniquely labelled synthetic volumes and no
live mounts or published ports. Set `CAPTURE_REHEARSAL_FROM` and
`CAPTURE_REHEARSAL_TO` to two locally available, different server images with the
same schema; the target must include the epoch guard. Defaults are the local
Alexa admin/companion review image tags:

```powershell
node scripts/rehearse-capture-companion.mjs
```

It verifies actual image replacement, socket-volume retention, startup and an
epoch-change refusal, then cleans only its owned synthetic resources. Its epoch
change is a simulation on a freshly bootstrapped test database, **not a complete
backup/restore rehearsal**. The main app integration must separately exercise its
current complete image against an isolated restore before live activation.
