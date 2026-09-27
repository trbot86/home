# Self-hosted Alexa receiver

2026-09-27. The receiver and its Docker image are implemented for local review.
No public endpoint, live integration credential, capture listener or household
connection has been enabled by this work. The existing development skill can use
an HTTPS endpoint; an AWS account is not needed.

## Container arrangement

Use a separate **Alexa receiver** container, built from `ops/alexa.Dockerfile`.
It has no database, media, backup or Docker-socket mount. Its only application
capability is submitting shared-inbox notes using a revocable integration token.
It reads private configuration from a read-only file and mounts a dedicated
directory containing the capture socket, also read-only.

The **capture helper** uses the household server image but runs
`apps/server/dist/capture-main.js`. It owns the private capture listener, opens
the existing household database and submits writes through the same coordinator
and durable receipt logic. Set `CAPTURE_SOCKET` instead of `CAPTURE_PORT` to use
a Unix socket. Both containers use the same unprivileged UID; the socket is mode
0600. The dedicated socket directory must be prepared with that owner. Do not
share the data directory with the receiver or initialize a replacement database.
The normal household app keeps its existing private listener and address.

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
ordinary Docker network. No deployable Compose file is supplied yet because the
network boundary has not been verified on the real host.

The executable requires `ALEXA_ENABLED=1`, `ALEXA_PORT`, and `ALEXA_CONFIG_FILE`
pointing to a private mounted JSON file containing exactly:

| Field | Purpose |
| --- | --- |
| `skillId` | Exact development skill ID |
| `alexaUserIds` | Explicit array of authorized Alexa account IDs |
| `expectedServerEpoch` | Pinned epoch of the authorized household |
| `captureSocketPath` | Absolute path of the dedicated mounted socket |
| `captureToken` | Capture-only integration credential |

Keep real values and runtime files under ignored `.local/alexa/`. Never put
tokens in a command line, Docker image, Git or a transcript. The Alexa account ID
is not the speaker's name or email; obtain it during a controlled console trial
and review the exact allowlist before enabling household writes.

## Deployment work still required

1. Prepare the specific ingress and egress configuration. Amazon requires a
   publicly reachable TLS endpoint on port 443. A dedicated Tailscale Funnel
   identity is an option; never enable Funnel on the app's existing private
   Serve port. Tailscale documents that changing a Serve port to Funnel makes
   that port public. [Funnel limitations](https://tailscale.com/docs/features/tailscale-funnel).
2. Prove that the receiver and ingress cannot reach **any** main-app listener,
   including host gateways, LAN addresses and other Docker networks. A separate
   container and fixed application socket alone do not enforce network egress
   isolation. The receiver also needs bounded outbound HTTPS certificate
   retrieval from Amazon; that allowance must not expose the trusted-network app.
3. Run the container arrangement against a synthetic household first. Check
   read-only mounts, socket permissions, restart behavior, resource limits,
   TLS chain, genuine Amazon signatures and response latency. The separate
   capture process must use the main app's complete current record registry.
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
delivery is retried. These tests do not establish deployed network isolation or
actual device/account phrase recognition.
