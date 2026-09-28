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

## Remaining activation decision

A real provider adapter and host activation are deliberately absent. The injected
provider interface has no database/tool access; a future adapter must preserve
that boundary, structured choice validation, bounded input, cancellation and no
prompt/error logging. Selecting an account/model and authorizing real processing
remain separate from this source change. The synthetic browser fixture is the
only host in this change that configures a provider. No real household content is
sent during tests. No daily bulk exporter or unrestricted Codex session is added.

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
