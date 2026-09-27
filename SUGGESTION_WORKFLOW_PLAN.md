# Suggestion discussions and agent work

Status: implemented with a serial development-host runner. Operational setup and
recovery are documented in SUGGESTION_BRIDGE.md; release evidence is recorded in
BUILD_PROGRESS.md. The household app is the authoritative place to
follow this work. A separate visible Codex desktop task is optional, not an
acceptance requirement. An agent session can be resumed or replaced while the
suggestion's discussion, decisions and unanswered questions remain intact.

## User workflow

Opening a suggestion shows the original request, a current summary, status,
outstanding questions and a chronological discussion. Keep content-version
history separate from discussion messages. The summary describes the current
understanding, completed work and next step without requiring the user to read
the entire timeline. Attribute messages to the actual person, agent or system.

Saving a new suggestion adds it to the backlog. Keep the existing weekly review.
Work on this requests earlier attention. A reply offers Reply & continue work
and Add note. Additional replies queue behind a running turn; answering a waiting
question makes the next turn eligible. Do not interrupt active work implicitly.
Either household profile can participate in shared suggestions. Discussion and
attachment access inherit the suggestion's visibility.

Show suggestion statuses such as New, Queued, Working, Needs your input, Ready
for review and Released. Keep these separate from transport and process states.
A saved reply can be waiting for a development host even when earlier work is
ready for review. Distinguish a tested implementation from an available release,
and a published Android update from installation on someone's phone.

Post meaningful findings, decisions, questions, test results and release updates.
Avoid a stream of individual tool calls. Keep the initial request and discussion
available after completion; allow a later follow-up to reopen the work.

## Domain and storage boundaries

Extend the current suggestion category without replacing existing inbox IDs,
photos, history or receipt records. Add a Suggestions module, with explicit
relationships in the same SQLite database. Do not turn the household Tasks
module into an agent scheduler.

| Record              | Responsibility                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| Suggestion workflow | Links the existing suggestion to its status, current summary and workflow revision.                     |
| Discussion message  | Stores author, body, timestamp, optional photos and optional agent-run/question association.            |
| Question            | Gives a question stable identity, optional choices and explicit unanswered, answered or resolved state. |
| Work request        | Captures the user's intent to begin or continue work, its originating reply and durable delivery state. |
| Agent run           | Records host/session identity, attempt state, ownership and which messages were supplied to that run.   |

Register user-visible records with the existing history and attachment machinery
where those semantics apply. Keep operational dispatch state separate from
user undo. In particular, undoing or retracting a message cannot undo code that an
agent has already changed. Preserve the message version supplied to an agent;
later corrections must remain visible as new input. Resolve exact mutation and
retention commands before writing the migration.

A suggestion's initial text is not the agent's scratchpad. Updating a summary or
posting a milestone must not replace that text or invalidate an open editor for
it. Moving a suggestion to Inbox retains its discussion but suppresses new
automatic dispatch; deletion also prevents dispatch and retains history for
restoration. Completion and archiving retain discussions.

## Durable replies and questions

Draft replies and their photos are stored locally. Reuse the existing outbox,
stable operation IDs, receipts and recovery-epoch checks rather than introducing
a second unrelated retry mechanism. Freeze a submission's payload before its
first transmission; subsequent edits are new messages or explicit corrections.

On the server, save a reply and its requested work in one transaction. Retrying
the same operation returns the existing result. A reply to a question carries
that question's ID, so late delivery cannot answer a different question.
Receiving an answer and accepting it as resolving the question are distinct.
Keep both people's answers if they respond independently.

Capture a stable sequence boundary when preparing a turn. Record exactly which
messages and versions were supplied. Messages arriving after that boundary stay
pending for the next turn; finishing the earlier run cannot consume them.
Repeated clicks can join an already queued request without losing the new
messages or starting concurrent turns for the same suggestion.

Read-only cached discussions remain useful offline. Distinguish Waiting to
upload, Saved for review, Waiting for agent and Agent started. Show an actual
failure or uncertain delivery explicitly. A green saved indicator confirms
durable storage, not that an agent has read or completed the request.

## Development-host bridge

Run the bridge on a development PC, separate from the household server. It
pulls eligible work through the private network and posts updates through a
restricted agent API. Repository and Codex credentials stay on the development
host. The server owns durable requests and discussion records; a streaming
connection is only an optional responsiveness improvement.

Use a runner adapter so the workflow is not tied to desktop UI internals. The
first implementation may manage its own persistent Codex conversations. Store
session IDs as operational metadata, never as the identity of the discussion.
Before resuming or replacing a session, supply the current summary, original
request, decisions, open questions and unconsumed replies. An agent reads these
records before asking for information again.

There is a documented Codex interface for starting/resuming conversations,
submitting turns and receiving events. The installed command's exact schema and
restart behavior must be exercised before selecting the adapter. Desktop task
visibility is not a gate. See the official
[App Server documentation](https://learn.chatgpt.com/docs/app-server) and
[non-interactive mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).

Give an agent a distinct identity and access to the assigned suggestion's
discussion and intentionally supplied context. The current internal recipe
worker's grant is recipe-specific; do not reuse it as broad coding-agent
authority. Bind each update to the permitted suggestion, run and current server
epoch. An agent cannot impersonate a household profile by choosing its author.

Permit one active run per suggestion. Keep concurrent coding work in separate
worktrees and integrate/releases through the existing coordinated workflow.
Agent output describing successful tests is distinct from verification of what
was integrated and deployed.

## Recovery contract

Idempotent app messages do not by themselves make an external agent launch
exactly-once. Persist dispatch intent before launching, then persist the accepted
session/turn identity. If the bridge loses the acknowledgement, inspect the
external run and its correlation metadata before retrying. If it cannot determine
whether work started, retain an uncertain state for reconciliation rather than
launching another agent blindly.

An expired lease prevents stale workers from publishing updates; it does not
prove that an old process stopped editing its worktree. Reclaim work only after
reconciling that process/session. A host going offline leaves requests durable.
On restore, require the existing recovery-epoch handshake before accepting old
bridge writes or resuming queued work.

Questions must survive an agent process ending. Persist a question in the app
and let the run wait or finish; a later answer can start a fresh turn. Do not
make an unanswered question depend on keeping one live protocol request open
for days. Permission approvals remain distinct from ordinary product questions
and retain the existing development authority and approval boundaries.

## Implementation and acceptance

First implement the schema/commands, discussion UI, summary/status/questions,
durable replies and an agent read/write interface. Wire normal suggestion review
to use that interface. Until automatic pickup is connected, accurately label
replies Saved for review.

Then implement dispatch and the development-host runner, including recovery.
Enable automatic pickup only after an isolated end-to-end rehearsal demonstrates
the following:

- A phone reply survives app termination and offline/reconnect, appears once in
  the shared discussion, and is supplied to the intended run.
- A new reply during active work remains pending until actually supplied; two
  profiles replying do not overwrite one another.
- Losing the launch acknowledgement, restarting the bridge and reconnecting to
  a running agent do not blindly create duplicate work.
- An unanswered question survives a stopped/replaced agent; an answered question
  remains visible as answered in subsequent turns.
- Failed or paused work, host unavailability and uncertain execution have truthful
  UI states. A completed coding turn does not automatically imply deployment.
- Private discussions/photos and agent credentials remain scoped appropriately;
  revoked, deleted or restored state cannot accept stale agent writes.
- Migration/restore rehearsal preserves existing household rows, attachments,
  receipts and identity. Web and in-place Android updates preserve drafts and
  pending submissions, with responsive phone/tablet/desktop verification.

Live upgrades and backups follow AGENTS.md. Historical review notes may be
imported as explicitly dated summaries with source provenance; do not invent
conversations that did not take place.
