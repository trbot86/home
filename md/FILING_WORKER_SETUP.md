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
answers. It does not log traffic, decrypt TLS or accept arbitrary URLs. No model
endpoint is allowed yet. Do not broaden the network as a login workaround.

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

## Verification and remaining activation work

`node --test scripts/filing-worker/auth-proxy.test.mjs` checks authority rejection
and DNS rebinding restrictions with synthetic data. The container probe checks
the actual user, read-only filesystem, absence of household paths, blocked direct
TCP/DNS, rejected general-web CONNECT, and allowed authentication CONNECT.

These checks establish the pre-login boundary, not a tool-free model runtime.
After login, finish the tightly scoped inference transport, independently enforce
the model tool boundary, and verify caller-disconnect/forced-death cleanup of a
whole model job. Then exercise the real adapter against synthetic notes in an
isolated application database, including Secure exclusions, explicit filing,
undo, and deduplication. Confirm the requested model is available without silently
substituting one. Keep production `FILING_WORKER_CONFIG_FILE` unset until those
checks pass and household processing is explicitly enabled with scope consent.
