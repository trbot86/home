# Isolated filing worker setup

The authentication boundary is implemented in `ops/filing-worker/compose.yaml`.
It is a separate Compose project; it does not attach to household networks,
mount household data, expose ports, or mount the Docker socket. The only worker
volume is its new credential store. It never imports desktop authentication.

The unprivileged, read-only worker shares a dedicated network namespace with a
firewall guard. The guard alone has NET_ADMIN; the worker has no capabilities.
Outbound traffic is denied except to the authentication proxy. External DNS has
no resolver and direct external DNS packets are blocked. The proxy permits only
CONNECT to `auth.openai.com:443`, resolves it itself, and rejects non-public DNS
answers. Authentication TLS is not decrypted. A separate HTTP handler on the same
internal service accepts only `POST /responses`, forwarding to one fixed official
subscription inference endpoint. It reconstructs the full request from the bounded
note and offered destinations; CLI instructions, tools, history and attachments
are discarded. Model and effort are pinned to Luna low. Tools are empty and tool
choice is none. A complete bounded SSE response must pass event/item validation
before reaching the CLI; tool calls and unknown events fail closed. No traffic is
logged. Arbitrary URLs, CONNECT to model endpoints, and WebSockets are rejected.

The worker image pins Codex CLI `0.126.0-alpha.8`. Build contexts are generated
from an explicit file list plus the bundled worker entry point, never by copying
the repository or a user's home directory. Runtime mounts are bounded tmpfs and
the dedicated auth volume. Container logs are disabled. Device login has a
15-minute deadline followed by forced termination; the credential volume persists.

From the repository root:

```powershell
node scripts/filing-worker/build.mjs
docker compose -f ops/filing-worker/compose.yaml --profile manual build
docker compose -f ops/filing-worker/compose.yaml up -d --wait auth-egress network-guard
Get-Content scripts/filing-worker/probe.mjs -Raw | docker compose -f ops/filing-worker/compose.yaml run --rm --no-deps -T worker node --input-type=module
powershell -NoProfile -File scripts/filing-worker/login.ps1
```

Complete the displayed device-code link personally. Keep the one-time code out
of source, reports and app discussions. If device login requires an account
setting change, the user must authorize or make that change themselves. See the
[official authentication documentation](https://learn.chatgpt.com/docs/auth).

After completion, `docker compose -f ops/filing-worker/compose.yaml run --rm
--no-deps -T worker codex login status` reports login state without printing tokens.
Do not inspect or copy the auth file. Never run `down --volumes` as routine cleanup.

## Host connection

`scripts/filing-worker/setup.ps1 -Start` creates a distinct random broker token in
ignored local storage and registers the host broker at sign-in. It binds only to
host loopback. Docker Desktop's host bridge lets the app client reach it. The
application gets only that token and a fixed launcher configuration via a read-only
mount; it gets neither the Docker socket nor ChatGPT credentials. The broker has
one concurrent slot, accepts no executable names or Docker options from requests,
and launches only the fixed isolated worker service. Its private token is never
passed to the model worker. Preparing the broker does not activate app processing.

The worker receives one request, has a 25-second application deadline, and runs
under a separate 35-second container deadline with a two-second forced-kill grace.
Disconnect cancels upstream inference and the broker removes only its generated
container name. The container deadline survives forced death of the host broker.
The gateway remembers job identifiers for two minutes, rejecting uncertain retries
before another upstream call. App-level durable attempt records remain authoritative
across gateway restarts. Reuse the credential volume; do not clean it with jobs.

After verification, activation uses an ignored
`.local/phone-trial/filing-worker.json` containing this repository's absolute path
as `repository` and `isolationReviewed: true`. The existing verified-backup upgrade
command then adds `ops/filing-worker/app.compose.yaml`. Scope consent in app
settings is still required; the host configuration does not grant it. Remove the
activation file and repeat the normal upgrade to disconnect the provider.

## Verification

`node --test scripts/filing-worker/auth-proxy.test.mjs` checks authority rejection
and DNS rebinding restrictions with synthetic data. The container probe checks
the actual user, read-only filesystem, absence of household paths, blocked direct
TCP/DNS, rejected general-web CONNECT, and allowed authentication CONNECT.

The adjacent gateway and broker tests cover context reconstruction, response
rejection, authentication, concurrency, upstream cancellation and retry suppression.
The explicit real-model rehearsal (never part of routine CI) uses a temporary
application database, the actual adapter, host broker, isolated CLI and gateway:

```powershell
node --test scripts/filing-worker/*.test.mjs
node --import tsx scripts/filing-worker/rehearse.ts (Get-Command docker).Source
node scripts/filing-worker/rehearse-cleanup.mjs (Get-Command docker).Source
```

It verifies a synthetic grocery note, duplicate suppression, explicit shopping
filing and undo, and Secure exclusion. The cleanup rehearsal uses a shortened
deadline and deliberately loses its Docker transport while the worker ignores
SIGTERM. Never replace these synthetic fixtures with household data. Verify the
container-to-host client separately before activating the provider in the app.


The Windows broker task starts through `run-hidden.ps1` with PowerShell hidden.
It launches Node with `-WindowStyle Hidden` and waits for its exit code, so the task
stays running and restart/duplicate controls work without opening a terminal.
Docker subprocesses also use `windowsHide`. Re-run setup after stopping an idle
broker to update an older task that launches Node directly. Never close unrelated
terminal windows as part of this update.
