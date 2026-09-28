# Dedicated Alexa Tailscale identity

This is the enrollment stage of ALEXA_SELF_HOSTING.md. The Compose project runs
only the namespace guard and an unprivileged userspace Tailscale daemon. It has
no receiver, public listener, household data, capture token or host port binding.
The daemon's state volume belongs only to this identity and must be retained.

Before enrollment, review the tailnet policy. It must define
`tag:our-place-alexa` with appropriate owners and Funnel permission, and no
network grant may permit that tag to initiate connections to household devices.
For a tailnet containing only user-owned devices, narrowing a wildcard source
grant to `autogroup:member` preserves those devices' access while excluding the
new tagged identity. Existing tagged services, subnet routes and shared devices
need their own review. Save the previous and proposed policies in ignored local
storage. Do not retag an existing computer or reuse its Tailscale state.

Inspect existing Docker names/labels before first startup; never adopt unrelated
resources under these project names. Build and start from the repository root:

```powershell
docker compose -f ops/alexa-ingress.compose.yaml build
docker compose -f ops/alexa-ingress.compose.yaml up -d --wait
```

The guard's healthcheck must pass before the ingress starts. The guard replaces
its privileged setup process with an unprivileged process whose effective and
bounding capabilities are zero. The ingress has no capabilities, TUN device,
SOCKS/HTTP outbound proxy, TCP debug listener or receiver-shared control socket.
Its socket is private to its own container. Logs stay in the bounded local
Docker log store; daemon log uploads are disabled.

Request enrollment using the explicit tag and disabled route/DNS adoption:

```powershell
docker compose -f ops/alexa-ingress.compose.yaml exec -T ingress tailscale --socket=/run/tailscale/tailscaled.sock up --hostname=our-place-alexa --advertise-tags=tag:our-place-alexa --accept-dns=false --accept-routes=false --ssh=false --timeout=30s --json
```

Open the resulting authorization URL using the intended tailnet administrator.
Keep the URL, device details and enrollment output in ignored local storage.
A timeout while waiting for the human sign-in is not evidence of successful
enrollment. Inspect status after sign-in; the new device must be Running and
carry exactly the intended tag before any receiver/Funnel setup.

```powershell
docker compose -f ops/alexa-ingress.compose.yaml exec -T ingress tailscale --socket=/run/tailscale/tailscaled.sock status --json
```

Before publishing, verify the tag's effective outbound policy, disabled proxies,
guard rules, process capabilities and actual denied connections. User-owned
devices can still initiate connections to the ingress under a member-to-all
grant; that does not grant the ingress permission to initiate the reverse flow.
Funnel traffic needs its own test and targets only the receiver's loopback port.
Use a synthetic household for the first genuine Amazon request. Enabling live
capture requires the current complete server image and the normal backup-verified
schema upgrade path, independently of this enrollment configuration.

If the guard image/configuration changes, recreate the guard and dependent
ingress together through Compose. Never join the host or household network.
Stopping these services is reversible; deleting the state volume loses the
identity. Do not run volume-removal commands as part of routine updates.

## Account setup receiver

After the enrolled identity and its effective policy have been checked, add
`ops/alexa-receiver.compose.yaml` as a second Compose file. It adds only the
production receiver on loopback port 3000 in the guarded namespace. Its private
configuration directory is mounted read-only; no capture socket is mounted yet.

Create `.local/alexa/receiver-config/receiver.json` using the strict format in
`md/ALEXA_SELF_HOSTING.md`. For initial account setup, use the actual skill ID, a
random non-Amazon placeholder account ID, an unlinked epoch, an unprovisioned
random token, and the future socket path `/sockets/capture.sock`. This gives the
receiver no capture authority. Do not add an allow-all account mode or log request
bodies. The first genuine Amazon request should receive the account-not-connected
response. The user can obtain their account ID from the simulator's JSON Input
and explicitly bind that account for the next synthetic-inbox test.

```powershell
docker compose -f ops/alexa-ingress.compose.yaml -f ops/alexa-receiver.compose.yaml build receiver
docker compose -f ops/alexa-ingress.compose.yaml -f ops/alexa-receiver.compose.yaml up -d --wait receiver
```

Before publishing, verify the receiver's UID, zero capabilities, loopback binding,
read-only config mount and rejection of unsigned requests. Check that the ingress
has no existing Serve/Funnel configuration. Then publish only this receiver:

```powershell
docker compose -f ops/alexa-ingress.compose.yaml exec -T ingress tailscale --socket=/run/tailscale/tailscaled.sock funnel --bg --https=443 http://127.0.0.1:3000
```

Verify the resulting URL using a client outside the tailnet with normal TLS
certificate validation. `POST /alexa` without an Amazon signature must fail;
household/profile/data routes must not be present. Set the skill's HTTPS endpoint
to the resulting URL plus `/alexa`, selecting the trusted-CA certificate option.
This publishes only the account setup receiver; enabling actual capture remains
a separate step with a synthetic inbox first.

References:

- https://tailscale.com/docs/features/containers/docker/docker-params
- https://tailscale.com/docs/reference/tailscale-cli/up
- https://tailscale.com/docs/features/tags
