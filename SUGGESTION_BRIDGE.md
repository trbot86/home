# Suggestion discussions and development host

The household database stores the discussion, current summary, questions,
work requests and precisely which message revisions each agent run received.
Phone replies use the existing Room outbox, including photos, frozen requests,
receipts and restore recovery. Browser replies use the equivalent IndexedDB
outbox. Add note records discussion only; Reply & continue work also requests
another round. Replies arriving during a run remain queued for the next run.

The development host runs `scripts/suggestion-bridge.mjs`. It uses the installed
Codex executable's local stdio app-server protocol and structured final output. Each round
starts a fresh conversation with the saved discussion and questions; its Git
worktree is reused across rounds of the same suggestion. This deliberately
keeps recovery independent of a surviving desktop conversation. Questions and
answers remain available after the agent process exits.

Resolved questions leave the active Questions list and remain in the discussion
history. A person can also choose No longer relevant to record a resolution
without answering or dispatching work. That action uses the normal per-user
history and can be undone before a subsequent agent consumes it. Future runs
receive the resolved state. Merely starting a later round does not discard a
question; the agent must establish that it has been answered or made obsolete.

## Private setup

After a verified server upgrade, run the server's administrative command
`operations.js init-suggestion-agent <new-private-output-file>` with DATA_ROOT
set. It writes the dedicated credential to that file, never to standard output.
Transfer it to ignored `.local/suggestion-bridge/config.json` on the development
host. Add `origin` (the private household origin), `repository` (the source
checkout), `stateRoot` (an ignored local directory), `codexExecutable` (the
installed executable's absolute path) and `enabled: true`. Preserve the emitted
`serverEpoch` and `installationId`. Do not commit this configuration.

Run `node scripts/suggestion-bridge.mjs <configuration-file> --once` for a
single pass, or omit `--once` to poll. `enabled: false` stops new claims while
existing work is reconciled. The Windows helper
`scripts/setup-suggestion-bridge.ps1 -Start` registers an interactive-user
scheduled task at logon; it uses the existing Codex account, without storing
Windows account credentials. The host must be on and the user signed in.
Use `scripts/setup-suggestion-bridge.ps1 -Restart` when updating the host code.
It verifies and stops any surviving Node worker belonging to this exact
script/configuration before starting the task again. Detached agent supervisors
continue independently and are reconciled from their journals.

Use the current installed Codex runtime (validated with 0.153.4), rather than a
leftover executable from an older installation. The bridge explicitly requests
`workspace-write`, `on-request` approvals and `auto_review`, and on Windows the
`elevated` native sandbox. It verifies the effective settings returned by
`thread/start` before sending the task. Automatic review happens inside Codex;
the bridge declines any approval request that falls back to its unattended
client. It never grants unrestricted execution. The initial `codex exec`
launcher was inadequate: the older installed runtime forced `never` approvals,
and ignoring its Windows configuration downgraded its filesystem to read-only.

Worktree branches are `codex/suggestion-<id>` under the ignored state directory.
Only the assigned suggestion and its attached images are supplied. Agents have
no household session or bridge token in their prompt. The bridge publishes
agent-authored progress and final questions through its dedicated API. Recipe
worker authority remains separate.

## Integration and release

Implementation agents default to `gpt-6-astra` with medium reasoning. Ignored host
configuration can override `implementationModel` and `implementationReasoningEffort`.
The choice is recorded in each durable launch specification; existing runs retain
their settings. These defaults do not change the user's global Codex preferences.
Agents run focused tests for the behavior they changed and report what ran and
what is deferred. They still audit public source before committing. Broad regression
suites and complete distribution builds run once against the integrated release.

Finished suggestions enter an update automatically after a 30-second quiet period
(maximum two minutes from the oldest eligible completion). A batch contains up to
20 suggestions from one visibility scope. Private and shared suggestions are never
mixed. The authenticated host schedules batches; merely opening the list has no
scheduling side effects. An unfinished coding round is not interrupted.

The App suggestions list shows one **Update ready** panel with its included
suggestions and one **Deploy update** button. Preparation merges each committed
suggestion into one separate release checkout. It audits source, builds and tests
the Docker image, runs type/boundary/browser checks, and builds/tests Android with
the shared SDK/cache and existing signing identity. Host or build control changes
still need developer review. No live files are mounted in tests.

Membership freezes when preparation starts. Later completions enter the next
batch after the current update is deployed or cancelled. The manifest pins every
included suggestion/run/source commit, the base and candidate commits, image
identities and APK hash. Deployment approval names that exact manifest. Changes
to the source, live image or prepared artifacts invalidate it. Deployment uses the
existing guarded backup/upgrade command, publishes the Android update, fast-forwards
the clean development checkout and verifies secondary backup replication. Git
pushing remains a developer action. Phones install the update from the existing
private download page; deployment does not force installation. Deployed suggestions
remain visible until a person marks them completed.

A preparation failure holds the batch with its diagnostic summary; it never causes
an automatic retry loop. **Retry update checks** in an included suggestion's
discussion retries the entire batch after the cause is addressed. Requesting a new
coding round produces a new eligible run. Merge conflicts currently hold the whole
batch: the coordinator does not assume that remaining suggestions are independent
or silently omit changes. Cancelled batches also require an explicit retry.

Enable the host coordinator with ignored configuration `releasesEnabled: true`
and `pnpmEntry` pointing to the installed package manager's JavaScript entry.
The app server does not receive a Docker socket or repository mount. The bridge
credential stays outside coding sessions and release supervisors. Requests carry
identifiers and approval of an immutable manifest, never shell commands or paths.
There is one active release slot and one retained release checkout. Source branches
remain in Git. The checkout is reused without traversing dependency junctions;
ignored local files are retained and collisions with incoming source are refused.
SDKs and caches are shared. Unused coordinator-built images are
removed without force; live and previous images are retained. Journals and shared
build caches still occupy storage. Preparation failures leave the running app
unchanged. An interrupted process or failed deployment remains uncertain and
blocks another release until the host is inspected; it is never blindly retried.

Cards show a one-line latest update and a per-person **New update** marker. Opening
a connected foreground discussion acknowledges only the revisions shown there;
loading the list does not. A delayed acknowledgement cannot hide newer work.
Read positions are shared across that person's devices, separate from content
history and from the other person's read position.

The existing weekly review helper includes the current discussion, all question
states and recent work requests alongside each shared suggestion. Read that
context before asking questions or starting overlapping work. The cached export
contains the latest 100 messages per suggestion; the authenticated messages
endpoint provides older pages. Automatic pickup only follows an explicit work
request, so saving a suggestion alone does not start a coding process.

## Recovery and limits

Before dispatch, the bridge durably records the exact server request and local
launch intent. A detached supervisor retains Codex session events and the final
structured result across bridge restarts. An existing launch intent is never
executed twice. A missing supervisor or ambiguous launch remains uncertain;
inspect the retained process/session and worktree before deciding how to proceed.
An expired server lease fences new reports and does not release the active-run
slot. Reconciliation rotates that lease only for the owning bridge.

The private state directory contains `health.json`, request journals, scoped
conversation snapshots, event logs, results and worktrees. Keep it on persistent
local storage. If it is lost, do not point a new empty state directory at pending
runs: reconcile the old processes first. After a household restore, the changed
server epoch stops the bridge. Inspect old processes and recovered requests
before establishing new authority. Revoked credentials also stop the bridge.

The first runner is serial on this development host. It reports a start milestone
and a structured result; it does not stream individual tools or private reasoning.
Coding sessions never deploy. Preparation is automatic; deployment requires
the explicit in-app action. Active work is not forcibly interrupted.
Local pending/rejected reply photos remain protected by the existing outbox.

At most three suggestion worktrees are retained by default (`maxWorktrees`,
configurable from 1 to 20). Before creating another, the bridge can remove an
idle, clean checkout with only recognized build caches and its own copied
inputs. It verifies its path, repository and exact branch first. Git commits
and branches remain in the shared repository; a later follow-up recreates the
checkout from that branch. Git history is not duplicated per checkout.
Uncommitted source, unknown ignored files, active runs and uncertain/unpublished
runs prevent recycling. If they occupy every slot, the request fails visibly
without deleting work or creating another checkout. This caps checkout count,
not total bytes: retained Git changes, journals and caches still use storage.
Dependencies share one pnpm package store selected by `npm_config_store_dir`;
agents must not copy SDKs into each worktree. Recycling does not delete the app's
discussion or original attachments.

Validation includes `pnpm test:suggestion-bridge`, the server suggestion tests,
browser offline/reload tests, Android Room upgrade/recovery tests, an in-place
emulator update, and a synthetic run through the installed Codex executable.
