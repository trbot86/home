# Suggestion discussions and development host

The household database stores the discussion, current summary, questions,
work requests and precisely which message revisions each agent run received.
Phone replies use the existing Room outbox, including photos, frozen requests,
receipts and restore recovery. Browser replies use the equivalent IndexedDB
outbox. Add note records discussion only; Reply & continue work also requests
another round. Replies arriving during a run remain queued for the next run.

The development host runs `scripts/suggestion-bridge.mjs`. It uses the installed
Codex executable's JSON event stream and structured final output. Each round
starts a fresh conversation with the saved discussion and questions; its Git
worktree is reused across rounds of the same suggestion. This deliberately
keeps recovery independent of a surviving desktop conversation. Questions and
answers remain available after the agent process exits.

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

Worktree branches are `codex/suggestion-<id>` under the ignored state directory.
Only the assigned suggestion and its attached images are supplied. Agents have
no household session or bridge token in their prompt. The bridge publishes
agent-authored progress and final questions through its dedicated API. Recipe
worker authority remains separate.

## Integration and release

An agent can implement, test and commit changes in its worktree. It must leave
deployment, merging and pushing to coordinated review. Ready for review means
the coding round finished; it does not claim a web deployment or Android update.
Retain the worktree for review and future follow-ups. Check its source diff,
tests and public-source audit before integration, then follow AGENTS.md's live
backup, migration and Android preservation rules.

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
There is no automatic merge, deployment, or forced interruption of active work.
Local pending/rejected reply photos remain protected by the existing outbox.

Validation includes `pnpm test:suggestion-bridge`, the server suggestion tests,
browser offline/reload tests, Android Room upgrade/recovery tests, an in-place
emulator update, and a synthetic run through the installed Codex executable.
