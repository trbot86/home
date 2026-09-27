# Self-hosted Alexa receiver

2026-09-27. The receiver, Docker image and isolated network rehearsal are implemented.
No public endpoint, live integration credential, capture listener or household
connection has been enabled by this work. The existing development skill can use
an HTTPS endpoint; an AWS account is not needed.

## Container arrangement

Use a separate **Alexa receiver** container, built from `ops/alexa.Dockerfile`.
It has no database, media, backup or Docker-socket mount. Its only application
capability is submitting shared-inbox notes using a revocable integration token.
It reads private configuration from a read-only file and mounts a dedicated
directory containing the capture socket, also read-only.

The **capture helper** uses the household server image but starts through
`sh apps/server/capture-entry.sh`. It owns the private capture listener, opens
the existing household database and submits writes through the same coordinator
and durable receipt logic. Set `CAPTURE_SOCKET` instead of `CAPTURE_PORT` to use
a Unix socket. Both containers use the same unprivileged UID; the socket is mode 0600. The dedicated socket directory must be prepared with that owner. Do not
share the data directory with the receiver or initialize a replacement database.
The normal household app keeps its existing private listener and address.

The launcher holds an exclusive file lock for the helper's lifetime. On restart,
the helper removes a leftover socket only after verifying that it is a socket
with no reachable listener and that its inode has not changed. It refuses regular
files, symlinks, active listeners and uncertain states. Do not bypass the launcher
or remove its lock file while a helper is running. The socket directory must be
writable only by the helper; the receiver mounts it read-only.

Keeping the capture helper in a separate container is operationally simpler than
running two processes in the household app container. It uses the same server
image and the existing data volume; it is not another household installation.
The helper remains disabled unless `CAPTURE_ENABLED=1`, the expected installation
ID matches, and the database is already on the current schema. Schema changes
still go through the existing backup-verifying upgrade procedure.

Planned request path:

```text
Echo / Alexa phone app
  -> Amazon Alexa
  -> dedicated public HTTPS ingress
  -> receiver: POST /alexa
  -> private Unix socket: POST /capture/inbox
  -> household write coordinator and durable receipt
  -> readback after confirmed save
```

## What is implemented

- Strict HTTPS request verification: exact raw-body RSA-SHA256 signature,
  certificate chain to Node's trusted RSA roots, exact DNS SAN
  `echo-api.amazon.com`, certificate validity on every use, and timestamps within
  150 seconds in either direction. Verification uses Node crypto and node-forge
  PKI; no custom cryptographic primitive is implemented.
- Certificate URLs restricted to Amazon's documented HTTPS origin/path;
  redirects, embedded credentials, queries and fragments rejected. Fetching has
  a two-second overall deadline, a 32 KiB body limit, a six-certificate chain
  limit and bounded pending/cache entries. Neither certificate URLs nor request
  bodies are logged. The cache expires no later than the certificate chain.
- Exact skill/account allowlists, existing en-US/en-CA handler, notes only,
  server-selected shared destination and Alexa integration attribution.
- Fixed socket path and `/capture/inbox` route, a three-second overall transport
  deadline and a 16 KiB reply limit. No redirects, arbitrary destinations or
  automatic retries. Final receipts must match the submitted operation ID.
- Receiver accepts only `POST /alexa` with JSON. Bodies are capped at 64 KiB;
  compressed/browser-origin requests are rejected. Rate limit is 60/minute per
  direct peer, without trusting forwarded IP headers; eight active handlers at
  most. The ingress proxy may therefore share one rate budget.
- Private config is bounded and rejects extra fields. There is no runtime option
  to disable signature checking, override trust roots or silently adopt a new
  server epoch. Without explicit enablement the executable exits.

Amazon's [HTTPS requirements](https://developer.amazon.com/en-US/docs/alexa/custom-skills/host-a-custom-skill-as-a-web-service.html)
and [SDK verification documentation](https://developer.amazon.com/en-US/docs/alexa/alexa-skills-kit-sdk-for-nodejs/host-web-service.html)
define the signing certificate, signature and timestamp checks. Like Amazon's
Node SDK, this implementation's PKI library supports RSA certificate chains.
Certificate revocation checking is not implemented. No weaker signature fallback
is enabled; changes to Amazon's signing requirements need a code review.

## Local build and private configuration

From the repository root:

```powershell
pnpm --filter @our-place/alexa test
pnpm --filter @our-place/alexa build
docker build -f ops/alexa.Dockerfile -t our-place-alexa:review .
```

The image runs as `node`, contains only the receiver/runtime dependencies, and
exposes internal port 3000. Building it neither runs it nor publishes a port.
At deployment, use a read-only filesystem, no added capabilities, no-new-privileges
and bounded memory/process resources. Do not attach it to the household app's
ordinary Docker network. The kernel network boundary has passed a rehearsal on
the deployment host. The Tailscale identity and tailnet policy still need review
before preparing the live Compose configuration.

The executable requires `ALEXA_ENABLED=1`, `ALEXA_PORT`, and `ALEXA_CONFIG_FILE`
pointing to a private mounted JSON file containing exactly:

| Field                 | Purpose                                        |
| --------------------- | ---------------------------------------------- |
| `skillId`             | Exact development skill ID                     |
| `alexaUserIds`        | Explicit array of authorized Alexa account IDs |
| `expectedServerEpoch` | Pinned epoch of the authorized household       |
| `captureSocketPath`   | Absolute path of the dedicated mounted socket  |
| `captureToken`        | Capture-only integration credential            |

Keep real values and runtime files under ignored `.local/alexa/`. Never put
tokens in a command line, Docker image, Git or a transcript. The Alexa account ID
is not the speaker's name or email; obtain it during a controlled console trial
and review the exact allowlist before enabling household writes.

## Implemented network boundary

`ops/alexa-network.Dockerfile` builds the dedicated namespace guard. The rehearsal
below exercises it without enrolling a Tailscale node or publishing a port.
Docker explicitly permits access to the bridge
gateway and appropriately configured host services even on an internal network.
Consequently, `internal: true` alone cannot establish the required boundary.
[Docker internal-network behavior](https://docs.docker.com/reference/cli/docker/network/create/#network-internal-mode---internal).

The arrangement uses a dedicated network namespace for the receiver
and its planned userspace Tailscale ingress. A setup process installs a deny-by-default
firewall **inside that new namespace**, then drops its privileges and network
administration capability. The receiver and Tailscale containers join the
namespace only after setup succeeds; neither receives `NET_ADMIN`. Failure to
install or verify the rules must prevent both services from starting. This must
not alter the host firewall or any existing container's namespace.

The namespace permits loopback traffic, established replies, public IPv4 TCP
ports 443 and 53, and public IPv4 UDP for DNS and Tailscale transports. Incoming
UDP port 41641 is allowed. Non-public IPv4 destinations are rejected before the
established-connection rule, including LAN, carrier-grade NAT/tailnet,
link-local and Docker private ranges. All external IPv6 traffic is dropped;
only IPv6 loopback is allowed. DNS answers do not bypass destination filtering.
This is a boundary against private-network access, not an Amazon-only outbound
allowlist: public HTTPS and UDP remain reachable. Runtime process capabilities
are dropped, including the capability bounding set.

The Tailscale container has its own persistent identity/state, no SOCKS/HTTP
outbound proxy, and no control socket mounted into the receiver. Its tailnet
policy must also grant no main-app destinations: userspace overlay traffic is a
separate path from ordinary kernel routing. Funnel terminates only into the
receiver's loopback port. The capture helper needs `network_mode: none`, because
its application traffic uses the dedicated Unix socket. Docker supports shared
container network namespaces and disabled networking; Tailscale supports
userspace networking without a TUN device.
[Docker network modes](https://docs.docker.com/reference/compose-file/services/#network_mode),
[Tailscale container settings](https://tailscale.com/docs/features/containers/docker/docker-params#ts_userspace).

Existing wildcard tailnet grants may also apply to a newly tagged node. Review
the effective policy before enrollment; assigning a tag alone does not establish
isolation. No Tailscale node or policy was changed during the rehearsal.

## Repeatable isolated rehearsal

With Docker running, execute:

```powershell
node scripts/rehearse-alexa-network.mjs
```

The runner builds the guard and a separate **test-only** image, creates uniquely
labelled temporary volumes and an IPv4/IPv6 Docker network, runs the checks, then
removes only its own labelled resources. Its capture helper uses a synthetic
household database on a new volume. The receiver test harness injects a generated
certificate authority; this entry point and its test roots are never shipped in
the production receiver. Reports and logs stay under ignored
`.local/alexa/rehearsals/`.

Optional `--household-container NAME` and `--host-config PATH` add connection-only
probes for the known app listener and the address resolved from the private host
configuration. They do not send HTTP requests, read household records or mount
household data. `--skip-build` reuses the two locally built rehearsal images.

The deployment-host rehearsal passed on 2026-09-27:

- Positive IPv4, IPv6 and Docker-DNS neighbor controls established reachability
  outside the restricted namespace; all corresponding restricted probes failed.
- All eight selected protected routes were denied: main app container, host
  published listener, tailnet address, synthetic IPv4/DNS/IPv6 neighbor, Docker
  gateway, and IPv4-mapped IPv6. These are tested targets, not a scan of the LAN.
- A real Amazon signing certificate fetched successfully over public HTTPS.
  A synthetic signed capture committed once; a deliberately dropped reply and
  repeated delivery returned the same receipt without another note.
- Receiver had zero effective/bounding capabilities, no database mount and a
  read-only socket mount. Capture helper had only loopback networking; socket
  permissions were 0600. Invalid guard setup prevented receiver startup.
- A second capture helper failed its lifetime lock. SIGKILL left a stale socket;
  restarting recovered it and preserved the original receipt and one note.
  Receiver restart retained the network restrictions.
- Existing household container identity, image, start time and mounts were
  unchanged. All disposable containers, volumes and the network were removed.

The production Linux image build also passed all 74 tests (55 server, 14 Alexa,
5 contracts), including the socket safety checks. The rehearsal does not verify
Tailscale overlay policy, public Funnel ingress, genuine Amazon-signed skill
traffic, or device/account phrase recognition.

## Deployment work still required

1. Review the tailnet policy and prepare a dedicated restricted ingress identity.
   Amazon requires a
   publicly reachable TLS endpoint on port 443. A dedicated Tailscale Funnel
   identity is an option; never enable Funnel on the app's existing private
   Serve port. Tailscale documents that changing a Serve port to Funnel makes
   that port public. [Funnel limitations](https://tailscale.com/docs/features/tailscale-funnel).
2. Add the userspace Tailscale sidecar behind the tested namespace guard. Verify
   its effective overlay access restrictions and restart ordering. No outbound
   proxy or receiver access to its control socket is permitted. Never reuse the
   household app's Tailscale identity or enable Funnel on its private listener.
3. Exercise the public ingress against a synthetic household with a genuine
   Amazon request, trusted TLS and bounded response latency. The separate capture
   process must use the main app's complete current record registry and image;
   the rehearsal image must never mount live household data. Override the normal
   server image's HTTP healthcheck for the socket-only helper.
4. Review the concrete live configuration before enabling the public ingress or
   provisioning a household credential. Then set Build > Endpoint to HTTPS in
   the existing skill and enter the dedicated URL with a trusted TLS certificate.
5. Confirm the model build and account ID, test the console, then the actual Echo
   and phone on mobile data. Save first and read back without a confirmation turn.

Local tests use generated certificates/keys and isolated databases only. They
cover valid/tampered signatures, untrusted roots, SAN checks, stale/future
timestamps, certificate expiry, request bounds, route isolation, stable retries,
socket timeouts and lost acknowledgements. A signed receiver-to-socket-to-SQLite
test proves one committed note after an acknowledgement is dropped and the same
delivery is retried. These tests complement the network rehearsal; actual
Tailscale policy and device/account behavior still require deployment tests.
