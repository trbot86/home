# Inbox filing suggestions

Inbox cards show up to three ranked suggestions as direct filing buttons. A click
uses the normal revision-checked command, durable receipt and compound undo.
Tasks creates a task; a shopping list creates an item; a project or page creates
a page containing the note and an original-capture link. Existing tasks accept a
reference. A broad Shopping or Projects choice asks only for the missing container
when several are available. Existing edited filing drafts open for review instead
of being discarded. Original text, attachments and source history remain saved.
The server checks source and suggested destination revisions and visibility in
the same transaction as filing. Undo is available immediately after an acknowledged
save, or through the note's History after reconnecting or reloading.

## Setup and processing

Settings > Note suggestions contains the profile-wide controls. Each
profile separately saves whether processing is allowed, which of its shared or
private scopes may be used, whether destination titles may be included, and
whether automatic processing is allowed. All defaults are off. No provider is
connected by default in the production entry point. Saving consent alone cannot send data.

The Filing suggestions control on a note contains only its results and request or
retry button. More options holds Think harder, refresh and the Settings link. Destination titles
are selected automatically within the saved permissions; there is no per-note
context checklist. The filing dialog's Settings link saves the unfinished draft
before navigation. Changing profiles loads that profile's permissions.
Agenda day-range/context and task person/context choices are remembered per
profile and installation on each device; they do not store note contents.

Automatic mode discovers both existing and new unfiled inbox entries in permitted
scopes. The server polls every three seconds after the previous attempt finishes,
with one item per tick and no overlapping automatic dispatch. It discovers at
most 1,000 recently updated destinations with exactly the source visibility when
title context is permitted. It does not enumerate other private scopes. Manual
requests now use the same bounded discovery when destination IDs are omitted.
Tasks need an open, live occurrence: completed/cancelled one-off tasks are excluded,
while recurring tasks with a next open occurrence remain eligible. Saved advice
also becomes stale when its suggested task no longer has an open occurrence.

Think harder makes an explicit new attempt with `search: "all"`, even after a
successful result. It broadens discovery beyond the most recent 1,000. All eligible
titles are included when they fit; hard ceilings are 10,000 destinations and
240,000 title characters in total, with the existing 200-character per-label cap.
Selection stays newest-first if a ceiling is reached. The attempt stores coverage
mode, total eligible count, included count and whether coverage was limited, never
the exported titles. More options displays these counts and calls out omissions.
Repeated delivery of the same expected-attempt request cannot dispatch again;
automatic processing never broadens or retries an already attempted note.

The API still accepts an explicit list of up to 20 IDs, or an empty list for
category-only requests. The provider sees only the
source text (at most 8,000 JavaScript characters), category choices and permitted
destination titles with type labels, truncated to 200 characters. Complete titles stay in app data.
Photos, captions, page bodies, source metadata, history, other inbox entries,
record IDs, credentials and database access are not given to the provider.
The isolated transport accepts at most 2 MiB of request bytes (the gateway allows
4 MiB for the CLI envelope). The adapter and gateway independently enforce title
count and character limits. The output schema uses bounded numeric-string keys
rather than a large enum: [Structured Outputs limits enum values to 1,000](https://developers.openai.com/api/docs/guides/structured-outputs#limitations-on-enum-size).
The worker and server still reject keys absent from the offered choices, duplicates,
or more than three results. No tools or database access are added to the model.

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

## Secure items

Secure defaults off and is an additional exclusion, never a grant of scope or
provider access. Saved-item editors expose the flag. Inbox capture (including
Android quick capture) can set it before submission; it persists in offline
drafts and is committed atomically with the note, before automatic discovery.
Existing-item changes require a connection, current recovery epoch, authorization
and the current security revision. A failed/uncertain save must be checked again.

Projects protect all their pages, nested pages and notes filed into them. A Secure
page protects its nested pages and filed notes; shopping lists protect their
entries. Returning a note to the inbox retains its filing links and protection
until those links are removed. Moving a page changes its inherited protection;
its own flag remains. Ordinary links and pins are references, not containment.
Filing a protected note into newly created records copies its protection, including
an inline-created project and its page.

Flags are separate from content history, so edits, delete/restore and undo cannot
clear them. Clearing a child's own flag cannot override a protected container.
The server excludes protected sources before claiming an attempt and omits
protected destination labels. Secure changes invalidate affected saved advice
and conservatively discard pending advice; completion and review recheck current
protection. Already transmitted content cannot be recalled. Secure is a model
context exclusion, not encryption or a replacement for household visibility.

Secure app suggestions or protected discussion records also block development-agent
claims, replayed claims, status context, steering and media exports. Existing host
copies cannot be recalled.

The additive server migration preserves existing records, receipts and history.
Android Room migration 4 to 5 defaults existing draft flags off while preserving
frozen request bytes and hashes; it does not recreate the local database.

## Dedicated Codex worker

The separate authentication boundary and fresh-login procedure are now available
in [FILING_WORKER_SETUP.md](FILING_WORKER_SETUP.md), including the enforced inference
gateway, localhost broker, bounded whole-container lifecycle, and opt-in synthetic
real-model rehearsal. Production activation remains an explicit host configuration
step and never grants per-profile scope consent.

The server adapter and standalone `filing-worker-main` entry point implement a
dedicated Codex worker transport. Routine automated tests use synthetic
data and substitute the model subprocess; they do not authenticate or send model
requests. No daily bulk exporter or unrestricted desktop session is added.

The server entry point reads `FILING_WORKER_CONFIG_FILE` only when explicitly set.
The host-owned JSON file has `launcher` (absolute executable path),
`workingDirectory` (absolute empty directory), `isolationReviewed: true`, and
optional `model` and `effort`. Defaults are `gpt-5.6-luna` and `low`; this is a
requested initial choice; the setup rehearsal checks actual account availability.
The file belongs in ignored host configuration and must never contain household
content. The setup helper creates it without activating app processing.

The launcher is trusted deployment infrastructure, not model-controlled text.
It receives no arguments and one bounded JSON request on stdin; it must enter the
dedicated OS/container isolation boundary and run `filing-worker-main`. Forward
only the worker's JSON stdout. Do not implement the launcher as a direct call to
desktop Codex. The server does not pass its environment, credentials, data root,
PATH, or Codex home (Windows SystemRoot is the sole inherited platform value).
Configure any transport endpoint/authentication inside the host-owned launcher,
not source code. Do not expose a general command-execution or database endpoint.

Inside the isolated worker, explicitly set absolute `FILING_CODEX_EXECUTABLE`,
`FILING_CODEX_HOME` and `FILING_WORKER_TEMP`. Provision authentication independently;
never extract or copy desktop account secrets. The worker uses a fresh temporary
directory with only a choice-output schema, a fresh `codex exec --ephemeral` run,
read-only sandbox, no approval prompts, disabled known tool/integration features,
and no inherited user configuration. Prompts travel through stdin, never process
arguments. Only up to three offered keys are returned. Temporary schemas are
removed on ordinary completion/failure; use disposable storage for crash cleanup.
The worker does not save prompt files, raw model output or stderr.

The [non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
documents ephemeral runs, stdin input and structured output. The installed CLI's
`exec --help` and `features list` were also inspected. Configuration flags are
defense in depth, not proof of a tool-free runtime. Before activation, independently
enforce and test no household/desktop mounts, no inherited skills/memories/plugins,
no unrelated network services, and inference/authentication-only egress. Pin and
revalidate the supported CLI version. A fresh directory alone is not isolation.

Each request has a 25-second subprocess deadline, output byte limit, generic
failure and no automatic retry. Cancellation sends termination, then forces the
launcher process to exit after a one-second grace period. The launcher must also
terminate the entire isolated job on caller disconnect/death, including forced
termination; killing a transport process alone cannot guarantee remote teardown.
The worker has its own deadline. Test both disconnect and process-death cleanup
when provisioning the actual host. An interrupted model request may already have
been sent, so the existing durable attempt stays consumed until explicit retry.

Data scope is a deferred runtime choice in Settings > Note suggestions, not a prerequisite
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

Keep this dedicated-worker adapter disconnected until the independent host
isolation/authentication rehearsal passes and activation is configured. Do not substitute a
direct API or change account/billing settings. Account entitlement and retention
policy are not established by the model name or by these synthetic tests.

Server migrations 029 and 030 are additive. Production upgrades must use the existing
verified-backup upgrade command. Advice metadata travels with normal inbox refresh
on both clients, so a saved result appears without editing its note. The normal
open-app sync interval is 15 seconds.
Migration 031 adds nullable coverage metadata to existing attempts; old results,
attempt numbers, records and receipts remain intact.

## Focused verification

- Adapter: `filing-codex-provider.test.ts` covers bounded/stripped wire input,
  choice-only output, real synthetic subprocess failures/cancellation, environment
  isolation, Codex argument/schema construction, temporary cleanup and disabled
  configuration defaults. These unit tests do not exercise a real model; the
  separate opt-in worker rehearsal does, using only a temporary synthetic database.

- Server: `inbox-filing-suggestions.test.ts`, `inbox-filing.test.ts`, `upgrades.test.ts`.
  Covers consent and authentication, scope isolation, bounded data, no-provider
  defaults, automatic discovery, long titles, durable deduplication, explicit
  retries, timeout, staleness, filing privacy/undo, and upgrade preservation.
- Browser: `filing-suggestions.spec.ts` and `inbox-filing.spec.ts`, with the synthetic
  provider and temporary database. Covers setup, automatic card updates, direct
  filing, missing-container selection, saved drafts, reload, failed-provider retries, widths down to 320 pixels,
  source photos, offline drafts, lost replies, partner edits and private backlinks.
- Type checks for server, web, contracts and client; package boundary check; staged
  public-source audit. Android `:app:compileDebugKotlin` runs offline using shared
  toolchains, without assembling or installing an APK. Distribution builds and combined release regression remain
  the release coordinator's responsibility. Native device behavior and real model
  quality are not established by browser tests.
