# A09: Committed record history and media retention

Date: 2026-09-25. Status: the user wants read-only record history for recovering old text and per-user undo/redo primarily for recent accidental actions. Reject reversal when subsequent changes conflict; elaborate selective undo or merge dialogs are outside the initial scope. Media uses whole-object replacement and delayed collection of old bytes, while retaining source URIs where available. Roughly 24 hours is the starting grace period, which may shorten under storage pressure. Host media files are now selected; [A13](0003-file-media-and-container-storage.md) supersedes the earlier BLOB preference and defines filesystem/SQL boundaries. The mechanics below are proposed, not implemented.

Read with [ARCHITECTURE.md](../ARCHITECTURE.md), [DATA_MODEL.md](../DATA_MODEL.md), and [A04](0001-offline-capture-submission.md).

## 1. Purpose and storage mechanics

Committed change history serves a different purpose from upload progress or idempotency receipts. The main historical workflow is browsing earlier versions and copying old text into a normal edit. Undo/redo primarily repairs recent accidental deletion, submission, or editing by the current user. These requirements apply even with a single server and two people; deep selective reversal across intervening work is not a prerequisite.

SQLite uses B-trees and fixed-size pages, not an LSM tree. In WAL mode it appends revised pages to a write-ahead log and later checkpoints them into the database; the log is recycled. That mechanism does not retain application-level history. Application deltas are a feature choice, not evidence of reduced physical copying: inserts and updates both incur page/index work. No storage-performance advantage has been measured here. [SQLite architecture](https://www.sqlite.org/arch.html), [WAL operation](https://www.sqlite.org/wal.html)

## 2. Proposed representation

Keep current domain state in ordinary relational tables and append logical changes in the same transaction. Normal queries use current tables. Historical queries reconstruct a record at a selected committed revision from its creation/baseline plus changes, or by reversing changes from a consistent current snapshot. This reconstruction produces a read-only view; browsing history never rewinds the live database.

| Relation or responsibility | Proposed contents |
| --- | --- |
| Current domain tables | Current typed records and relationships, with their revisions and constraints. |
| `change_sets` | Stable ID, database-assigned ordering sequence, recorded time, authenticated caller and attributed person/source, operation kind, and optional link to the change being undone/redone. Person attribution determines whose undo history contains the action. |
| `record_changes` | Change-set ID and order within the set, stable target identity, insert/update/delete kind, before/after revisions, versioned payload containing old/new changed values or inserted/deleted record contents. |
| Operation receipts | Retry identity, request digest, outcome, and a link to the committed change set where applicable. This is not a second copy of the deltas. |

This is a logical schema, not DDL. The whole-app identity/reference decision must give history targets a constrained identity that survives deletion. Versioned payloads can use JSON without turning core current-state relationships into untyped JSON. A field delta initially means storing its old and new values; character-level text differencing is optional and unnecessary initially. Insert/delete history retains enough non-binary data to reconstruct the record and its relationships.

Group all changes committed by one application operation into one change set. For example, completing maintenance can add a completion, update the actionable occurrence, and create the next occurrence. The history should describe that action as a group. Later asynchronous work commits its own linked change set; do not hold a transaction open while fetching a recipe or calling a calendar API.

Commit current-state mutations, the logical change set, any idempotency receipt, and required durable jobs atomically. A retry returns the original outcome and does not append another change set. Failed transactions leave none of these committed. Change order uses database ordering rather than wall-clock timestamps alone.

Capture boundaries follow committed actions, independently of the person. For an interleaved note history `v0 -> v1 (user) -> v2 (wife) -> v3 (user) -> v4 (wife)`, retain four ordered change sets. The second edit by each person starts from a state that includes the other's preceding edit. Combining the user's two edits into one net delta and the wife's two into another would lose intermediate states and their interleaving, even when every save succeeded without a merge conflict. Personal history is a filtered view of this shared sequence; reconstructing a historical version includes all changes up to that point, regardless of author.

If SQLite's Session Extension is used, create a short capture session on the connection executing one application write transaction, export its changes before commit, persist the change set and attribution atomically with the operation, then dispose of the capture session. Exclude the history/receipt/job tables and binary content from domain capture. A SQLite session observes changes through a database connection, not an authenticated person; it must not be treated as a long-running login or per-person editing session. The extension coalesces row edits and obtains final values when exporting. [SQLite session capture](https://www.sqlite.org/sessionintro.html#changeset_construction)

A Save/Submit, completed chore, or grouped shopping addition is a meaningful historical step. Local keystrokes before a save need not be committed separately. If autosave is introduced, keep each persisted revision in order and let the UI group adjacent edits or offer action/day navigation without discarding their boundaries. No timer-based or per-author grouping may silently absorb an intervening change by another person. Coarser navigation is a presentation choice, not a reason to flatten the durable chronology.

Track durable user-visible record changes, including relevant automatic imports and scheduling changes. Retry counters, cache refreshes, credentials, and transient worker progress do not become the user's record history. Domain facts such as actual completion and cooking records keep their own typed meaning; they may be described by change history but are not replaced by an opaque log.

Start with retained deltas from record creation. If histories become long enough to make reconstruction costly, introduce occasional snapshots at known change-set boundaries. If retention is later bounded, preserve a baseline at the retention boundary. Snapshotting, history compaction, and full event replay are not required for the first implementation.

## 3. Per-user undo, redo, and read-only history

Keep two interactions separate: History browses authorised old versions and offers Copy text; Undo/Redo targets the current person's own recent actions. Viewing the other person's permitted edits does not put those actions in one's undo stack. Shared-speaker actions without reliable person attribution remain outside personal undo until attribution is explicitly established; an integration credential must not imply a human author.

The initial interaction is an Undo affordance after a successful action, plus access to recent personal actions. Do not offer a global rewind or arbitrary bulk restoration to a selected time. If an older text value is useful, copying it into a normal edit preserves normal concurrency checks. Exact undo depth/duration remains open and need not match retained history duration.

Undo and redo are new authorised operations that commit their own change sets and advance revisions. They never erase the original history, restore old concurrency tokens, or delete idempotency receipts. Redo targets an action this person actually undid, using the state/revisions established by that undo. An incompatible later action can invalidate redo. Repeated undo, if offered, must use current expected revisions along the validated undo chain rather than resetting revisions to historical values.

The subsequent [application contracts](../APPLICATION_CONTRACTS.md#8-history-and-personal-inverse-operations) make the proposed reference convention explicit: Undo names the action it reverses; Redo names the committed Undo changeset, through which the original action is known. Availability queries are hints; execution repeats all permission/revision/dependency checks.

Conservatively require that the affected records and relevant dependencies still match the expected revisions/state for the action being reversed. Intervening writes by either person or an automatic job can block undo; a change to another unrelated record does not. Initially any later edit to the same row can count as a conflict, even if it changes a different field. Matching text alone does not establish that a record was unchanged.

Example: the user changes a recipe title from A to B. If the wife then edits that recipe, reject the user's undo with a short explanation such as "This recipe changed afterward. View history to copy the old text." If she instead edits an unrelated shopping entry, the recipe undo can still proceed. Do not open a merge dialog, silently skip to another action, or overwrite later work.

Domain operations declare the dependency checks needed for reversal. Undoing a completion must check subsequent work on the next occurrence; undoing creation must check later references. Relationship checks must detect newly added rows as well as edits to existing ones, using a parent/collection revision or transactionally checked predicates as appropriate. Check these conditions and apply the entire reversal in one transaction. Either the whole action reverses or nothing changes. Domain-specific reversal can be deferred for actions without a simple safe rule while their read-only history remains available.

Once an external notification is delivered it cannot be unsent. Cancel still-pending work when appropriate, and represent any supported external correction as new work. Operational receipts and deliveries are not rewound with user data.

History access follows both current authorisation and the visibility of the historical content. Publishing a formerly private record must not implicitly expose earlier private values. Filter change-set summaries and linked history too; a shared activity feed is a curated view, not direct access to the full journal.

## 4. Whole-object media and deferred collection

Keep media bytes out of the delta payload. A replacement creates a complete immutable media object and changes the attachment's reference to it. History records the old/new media identities and useful metadata, not binary diffs or another embedded copy of the bytes. The old object remains only while live references or the grace period retain it.

Proposed relations are `media_objects` for stable identity/metadata and storage key/generation, plus `attachments` and authorised parent links for how objects appear in the app. Bytes are immutable files managed by `FileMediaStore` under the app-owned host mount. Metadata remains in the single host database, allowing collection of files while keeping historical references valid. Physical publication/deletion is recoverable work outside SQL atomicity; see A13.

Retain source provenance at import time: the original media URI, a source-page URI when applicable, retrieval time, and a content hash for the downloaded bytes. Preserve this with the particular media object after bytes are collected; changing the current recipe source must not overwrite an older object's provenance. Apply the media's visibility policy to URLs as well as images.

1. Stage and durably publish the new file, protected from cleanup, before the database transaction that makes its metadata ready and switches the live attachment reference with the change set. A failed finalisation leaves a pending/unreferenced file for retry or cleanup. Never hold a write transaction open while receiving an upload.
2. When an object loses its last live reference, record `unreferenced_at` and schedule collection for approximately 24 hours later. Replacement alone is insufficient if another live attachment still uses the object. References only from history or deleted records do not preserve bytes indefinitely.
3. Reattaching an available object before deletion is claimed cancels its collection eligibility. If it later becomes unreferenced again, start a new grace period. An active deletion claim blocks reattachment until resolved.
4. The collector rechecks eligibility/live references in a transaction and commits a deletion claim for the specific storage key/generation. It then unlinks that file and records completion in a later transaction. Both steps can resume after interruption. Attachment/finalisation operations coordinate with the claim; SQL rollback is never assumed to restore a deleted file. A stale job cannot delete a newly reattached or republished generation.
5. Under storage pressure, the collector may shorten the grace period for unreferenced objects, oldest first. It never evicts media used by live records. Exact thresholds remain configurable design work.
6. After collection, retain a small metadata tombstone with `collected_at`, source provenance, and content hash, and remove associated retained image variants under the same policy. Historical screens show that the saved bytes are no longer available and offer a source link or recovery attempt where usable.

Undo of a media replacement is conditional on old bytes being available, either still retained or successfully recovered. A "Try fetching from source" action may recover collected media outside the database transaction, using the app's normal import rules; history browsing alone need not contact the remote host. URIs may expire, require credentials, identify device-local content, or return different bytes. The URI is a recovery lead, not a guarantee of the historical image.

Compare recovered bytes with the retained hash. An exact match can restore content for the same logical media ID using a fresh physical storage key after prior deletion is resolved; retention starts from the current recovery/reference state, not a stale collection job. Different bytes become a new object offered as a replacement and must not silently change the historical object. After fetching, recheck normal undo preconditions before restoring the attachment. If recovery fails, history/copy remains useful; do not claim complete media undo. An explicit replacement image or normal text edit is separate from Undo. The grace period is best effort under pressure, not a guaranteed 24-hour undo window.

This policy concerns retained application objects. Backup copies and already downloaded client caches have their own retention; collecting the host object is not an immediate erasure guarantee for all copies.

Media collection now removes files; SQLite vacuum is not its reclamation mechanism. Database free-page/WAL management remains a separate operational concern. Database and media must be backed up together under the coordinated procedure in A13. Settings reports database storage and media-file storage separately.

## 5. Implementation options and review gates

The starting proposal is an application-level journal with versioned logical fields and action grouping. Its main cost is ensuring every relevant write produces complete history; feature write paths and representative transaction checks must enforce that contract. Keep history encoding behind a small persistence capability, with domain-specific undo validation owned by the relevant modules.

SQLite's optional Session Extension is a change-capture mechanism, not a short-lived commit/rollback boundary. Extracted changesets can be retained and later applied/inverted. One long session coalesces repeated edits to a row, so preserving each action would require separately capturing and storing its changeset. It does not supply our history UI, person-scoped undo policy, or schema-evolution contract. Keep the explicit application journal as the starting proposal; evaluating the extension later as an internal capture aid is optional. Exclude operational upload/cleanup progress from user-facing history; binary media is outside the database. [Session Extension introduction](https://www.sqlite.org/sessionintro.html)

Before implementation, resolve the history target identity, exact recent undo depth and supported actions, migration/read compatibility for historical payloads, deletion semantics, and storage-pressure thresholds. Preserve a decoder or migrate historical payloads deliberately when schema names/types evolve; raw SQL from an old release is not a durable domain contract.

Acceptance scenarios: a lost response and retry creates one change set; alternating edits by both people preserve every committed intermediate version and correct attribution; author-filtered history does not omit the other person's edits during reconstruction; browsing/copying a prior recipe revision does not mutate current state; one person's Undo never targets the other's action; undo/redo advances revisions and preserves history; a same-row edit blocks stale undo while an unrelated edit does not; new conflicting references block reversal; maintenance reversal checks dependent occurrences; private values and source URLs stay absent from shared history; replacement retains an object still used elsewhere; reattachment defeats stale collection; collection leaves navigable history with an unavailable-media indication; an exact source recovery preserves media identity; a changed/unavailable source does not fabricate historical bytes; and fetching media does not bypass later undo conflicts.

Revisit current-state-plus-history storage only if a concrete query or recovery need justifies a different authority model. File placement is agreed in A13; revisit its policy or retention after measuring media volume, backup/restore cost, and cleanup behaviour on the actual host.
