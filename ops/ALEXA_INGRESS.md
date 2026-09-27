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

References:

- https://tailscale.com/docs/features/containers/docker/docker-params
- https://tailscale.com/docs/reference/tailscale-cli/up
- https://tailscale.com/docs/features/tags
