# Inbox filing suggestions

Filing suggestions are advisory. Inbox cards show saved-result counts, pending,
stale and failed states. Review opens the existing filing form; selecting a
suggestion does not file anything. File note uses the normal revision-checked
command, receipt and compound undo. Suggested existing destinations also carry
their expected revision. Original text, attachments and source history remain
unchanged by categorization.

## Setup and processing

The Filing suggestions control on an inbox card opens Suggestion setup. Each
profile separately saves whether processing is allowed, which of its shared or
private scopes may be used, whether destination titles may be included, and
whether automatic processing is allowed. All defaults are off. No provider is
connected in the production entry point. Saving consent alone cannot send data.

Automatic mode discovers both existing and new unfiled inbox entries in permitted
scopes. The server polls every three seconds after the previous attempt finishes,
with one item per tick and no overlapping automatic dispatch. It discovers at
most 20 recently updated destinations with exactly the source visibility when
title context is permitted. It does not enumerate other private scopes. Manual
requests can select up to 20 destinations explicitly. The provider sees only the
source text (at most 8,000 JavaScript characters), category choices and permitted
destination titles truncated to 200 characters. Complete titles stay in app data.
Photos, captions, page bodies, source metadata, history, other inbox entries,
record IDs, credentials and database access are not given to the provider.

Automatic consent is bound to the session that saved it, using only its credential
identifier, never its secret. Logout, expiry, account/client disablement or consent
revocation stops dispatch. Save permissions again in an active session to resume.
Automatic dispatch is suspended in database recovery mode. Turning permission off
cannot recall an already transmitted request; changed consent prevents publishing
its result. Access, consent and source revision are checked again on completion.

A durable per-item attempt is committed before calling the provider. Polling,
concurrent requests, duplicate HTTP delivery and restart do not automatically send
an attempted item again, including failed, edited or interrupted items. An explicit
retry carries the last attempt number so retrying the same HTTP request does not
create another send. Pending attempts have a one-minute retry guard. Calls time out
after 30 seconds and signal cancellation; a provider must honor that signal, and
an interrupted call may already have been transmitted. The UI explains that risk.

Only up to three distinct offered choice keys are accepted from the provider.
Arbitrary model prose, commands and unknown targets are discarded. Errors and raw
prompts are not persisted in the advice table or logged. Results persist category
codes or destination references/revisions, not source text or model reasoning.
Changed/deleted/inaccessible destinations invalidate saved advice; changed source
revisions hide it. Failed/stale attempts can be explicitly retried. Nothing in
this design guarantees that a remote model will avoid retention, disclosure or
training; provider/account policy must be reviewed before connecting it.

## Provider boundary and remaining decision

A real provider adapter and host activation are deliberately absent. The injected
provider interface has no database/tool access; a future adapter must preserve
that boundary, structured choice validation, bounded input, cancellation and no
prompt/error logging. Selecting an account/model and authorizing real processing
remain separate from this source change. The synthetic browser fixture is the
only host in this change that configures a provider. No real household content is
sent during tests. No daily bulk exporter or unrestricted Codex session is added.

Data scope is a deferred runtime choice in Suggestion setup, not a prerequisite
for developing the adapter with synthetic data. Keep the production provider
disconnected until both host configuration and saved scope consent are present.

The Codex app-server protocol offers structured output (`turn/start.outputSchema`),
interruption (`turn/interrupt`) and ephemeral threads. These cover parts of the
adapter contract, but do not by themselves establish a tool-free inference
boundary. In the 0.126.0-alpha.8 generated experimental protocol, `dynamicTools`
supplies tool definitions, rather than a global allow-list of built-in tools.
`environments: []` disables environment access, not every integration. The thread
start response reports permissions and instruction-source paths, but does not
attest an empty effective tool inventory or the absence of inherited context.
Reproduce this protocol inspection without starting a model request using:

```
codex app-server generate-ts --experimental --out .cache/codex-protocol
```

Inspect `v2/ThreadStartParams.ts`, `v2/ThreadStartResponse.ts`,
`v2/TurnStartParams.ts` and `v2/ToolsV2.ts`. Generated files are disposable and
must not be committed. This is a version-specific interface review, not proof
that all Codex versions lack a suitable interface.

The [app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the request lifecycle. The
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
provides individual tool and integration controls. The
[security documentation](https://learn.chatgpt.com/docs/agent-approvals-security)
explains that the command network sandbox does not govern MCP, connectors,
browser tools or model/authentication traffic. Consequently a read-only sandbox,
an empty dynamic-tool list and a prompt saying not to use tools are insufficient
evidence for reusing a general-purpose authenticated app-server safely here.
No existing app-server session or account configuration should be changed to
try to make this adapter work.

Choose the provider isolation approach before implementing its transport:

- A dedicated Codex worker with its own explicitly authorized authentication and
  independently enforced host isolation. Prove with synthetic adversarial input
  that it cannot read household files, inherited memories, plugins or unrelated
  services. Do not copy credentials from the desktop account. Source work can
  precede activation, but host isolation and authentication require separate setup.
- A direct inference API adapter with no tools supplied. This is a different
  credential/billing path and requires an explicit provider choice; do not
  silently substitute it for the requested Codex backend or enable billing.
- Keep the provider disconnected.

Whichever path is selected must retain the existing durable pre-dispatch claim,
bounded choice-only output, timeout/cancellation, and explicit acceptance. Model
and reasoning effort should be configurable; Luna with low effort is the proposed
starting configuration, subject to availability through the selected provider.
Do not infer account entitlement or data-retention policy from the model name.

Schema 029 is additive. Production upgrades must use the existing verified-backup
upgrade command. Android adds online bridge methods only; Room schema and frozen
offline requests are unchanged. Advice metadata travels with normal inbox refresh
on both clients, so a saved result appears without editing its note. The normal
open-app sync interval is 15 seconds.

## Focused verification

- Server: `inbox-filing-suggestions.test.ts`, `inbox-filing.test.ts`, `upgrades.test.ts`.
  Covers consent and authentication, scope isolation, bounded data, no-provider
  defaults, automatic discovery, long titles, durable deduplication, explicit
  retries, timeout, staleness, filing privacy/undo, and upgrade preservation.
- Browser: `filing-suggestions.spec.ts` and `inbox-filing.spec.ts`, with the synthetic
  provider and temporary database. Covers setup, automatic card updates, selected
  destinations, explicit acceptance, reload, retries, widths down to 320 pixels,
  source photos, offline drafts, lost replies, partner edits and private backlinks.
- Type checks for server, web, contracts and client; package boundary check; staged
  public-source audit. Android `:app:compileDebugKotlin` runs offline using shared
  toolchains, without assembling or installing an APK. Distribution builds and combined release regression remain
  the release coordinator's responsibility. Native device behavior and real model
  quality are not established by browser tests.
