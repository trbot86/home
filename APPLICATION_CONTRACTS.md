# Household app — application contracts, first pass

Date: 2026-09-26. Status: **proposed contracts**. The user has authorised continued planning; individual choices remain revisable. Working runtime/client choices now appear in [STACK_SELECTION.md](STACK_SELECTION.md); these contracts remain separate from framework-specific transport code.

Read with [the database model](DATA_MODEL.md), [worked transactions](WORKED_TRANSACTIONS.md), [architecture](ARCHITECTURE.md) and [restore reconciliation](RESTORE_RECONCILIATION.md). This pass makes the common write/result contract concrete, then applies it to representative features. Stack-specific validation/transaction execution is specified separately.

## 1. Contract vocabulary

| Concept | Meaning |
| --- | --- |
| `Command` | One requested application action; explicit verb and typed arguments. |
| `Query` | Authorised read returning a screen/use-case projection, not mutable database entities. |
| `OperationId` | Stable identity of one submitted request, scoped to an authenticated logical client. Retry the same ID and same payload. A changed request needs a new ID. |
| `RecordId` / typed IDs | Stable identity of content; a `RecipeId` is not interchangeable with a `TaskId`. Generic IDs are used only by genuinely generic facilities such as history. |
| `Revision` | Monotonically increasing content version of a record, including owned-child changes. It is not a timestamp, database commit number or revision of an entire household. |
| `ChangeSetId` | Identity of one committed content action. A request that changes nothing need not create one. |
| `RequestContext` | Server-derived client, optional authenticated human, permissions and correlation data. Not supplied as an editable command body. |

Use desired-state names (`SetTaskOccurrenceTarget`, `SetRecordPinned`) or meaningful actions (`CompleteTaskOccurrence`). Avoid toggles, a universal `UpdateItem`, and exposing raw SQL patches as the public write API. A transport adapter can translate HTTP/native calls into ordinary typed functions; no command-bus framework is required.

## 2. Common command and outcome

Language-neutral shape:

```text
Command<TArguments> {
    operationId: OperationId
    contractVersion: 1
    expectedServerEpoch: ServerEpoch
    arguments: TArguments
}

execute(context: RequestContext, command: Command<T>) -> CommandOutcome<TResult>
```

The route or handler identifies command kind. Canonical request identity covers kind, contract version, expected server recovery epoch, stable authenticated client/person identity and semantic arguments, including expected revisions and media manifests. It excludes changing transport credentials, correlation IDs and retry headers. The server owns a versioned canonical encoder. Clients persist exact frozen request bytes/arguments; a local byte-integrity hash is distinct from the server's canonical digest, which is stored with the final receipt. Media byte hashes match end to end.

| Outcome | Durable receipt? | Meaning / client action |
| --- | --- | --- |
| `Applied { receipt, changeSetId?, result }` | Yes | Requested state committed. A changeset is present when tracked content changed; preference/operational writes need none. Result contains stable IDs and revisions **at this action**, not a promise they remain current. |
| `Unchanged { receipt, reason, result }` | Yes | Accepted request had no content effect. Examples are an already-pinned record or a plain completion request after another person completed it. |
| `Rejected { receipt, code, safeDetails }` | Yes | This exact operation is terminally rejected and cannot create/update content on retry. Corrected input gets a new operation ID. |
| `Deferred { code, retryAfter? }` | No final receipt | Same immutable request may succeed later: media not ready, temporary contention or provider-independent server recovery. Keep it pending. |
| `RecoveryRequired { currentServerEpoch, restorePoint? }` | No new final receipt | Server was restored and no matching receipt survives. Pause automatic replay; retain payload/media for explicit reconciliation. Never rewrite the frozen epoch and resubmit it. |
| Transport/authentication/protocol failure | Not evidence of finality | The caller may not know the outcome. Preserve the submitted request and resolve it; a timeout, HTTP status alone or failed authentication does not unlock it. |

The receipt identifies the operation and canonical digest and stores its final outcome. An authenticated replay returns the same receipt/outcome, with `replayed = true` as response metadata. Reusing an ID with different arguments is a protocol conflict, never a replacement of the original receipt. Query current record content separately; stored receipts contain no titles, notes, private thumbnails or other stale content. Safe rejection details contain field paths/reason codes rather than copies of sensitive values.

`GetOperationOutcome(operationId, expectedServerEpoch)` returns `Final(receipt)`, `Unresolved`, or `RecoveryRequired` when no receipt survives an epoch change. Unresolved never means an old request is guaranteed not to commit. Receipt queries are bound to the authenticated client; another client cannot choose an arbitrary namespace. Shared speaker actions can have a known client with no known human. A matching existing receipt resolves before the epoch guard because replaying a result performs no mutation; a new mutation requires a matching epoch.

### Making rejection truly terminal

For well-formed authenticated commands, final outcome arbitration is serialised with the domain action. Inside one write transaction, check the existing receipt, establish a savepoint for domain changes, then either commit success or roll back those changes and insert the rejection receipt before committing. Validation before any mutation needs no savepoint rollback.

Do not roll back, tell the phone “rejected,” and insert the receipt later: an identical in-flight request could win in that gap. If a database failure forces the whole transaction to abort, report no terminal rejection until a fresh transaction resolves any winner or safely records a final rejection. Rejected operations have no content changeset. Malformed/unauthenticated requests outside this contract are not durable rejections.

This adds no server-side uploaded/waiting-for-ack stages. Server receipts describe final results; network uncertainty remains a client concern.

Transport integration must not bypass this contract: syntactically invalid command arguments inside a valid authenticated operation envelope must reach durable rejection arbitration. Ordinary automatic framework validation errors are not sufficient evidence of finality. Unparseable JSON or an invalid envelope cannot receive this guarantee; clients validate envelopes before freezing. [The stack-specific validation plan](STACK_SELECTION.md#5-wire-schema-validation-and-request-identity) makes this distinction explicit.

## 3. Local editing and submission

| State | May edit original payload? | Resolution |
| --- | --- | --- |
| `DRAFT` | Yes | Explicit submit intent plus ready local media makes it eligible to freeze. |
| `SUBMITTED` | No | Retry exact payload or resolve operation outcome. |
| `ACKNOWLEDGED` | No | Accepted creation is server-owned; later edits are new online commands. |
| `REJECTED` | No | Durable rejection received. Copy its recoverable content into a new editable draft/operation; retain old immutable request and receipt. |

`REJECTED` is an explicit terminal branch added by this contract pass; it is not a timeout/error synonym. Draft content remains recoverable in every branch. Never silently change an old submission's operation ID and resend it when its outcome is uncertain.

`SaveFormDraft` and `DiscardFormDraft` use local revision/state checks. `SubmitCaptureDraft` freezes once and is idempotent for the same draft revision. Multiple taps or Ctrl+Enter plus a button click resolve to the same submission. Editing between submissions creates a genuinely new intent only after the previous outcome is resolved. Ctrl+Enter invokes the active form's normal submit action and validation; Enter remains a newline in multiline fields. It does not directly call the network around the draft/submission path.

For an existing-record online edit, retain the in-flight command and recoverable editor text through a lost reply. This permits resolving that particular attempt, not queuing arbitrary offline edits. Additional text can remain a local form buffer, but it cannot be submitted against an assumed revision until the prior attempt and current server state are resolved.

## 4. Capture and media contracts

```text
CreateInboxEntry {
    inboxId: InboxId
    scopeId: ScopeId
    capturedAt: Instant
    text: Text
    source: { kind, uri? }
    attachments: [
        { attachmentId, mediaId, digest, byteLength, mimeType, caption?, position }
    ]
}

InboxEntryCreated { inboxId, revision }
```

Allow non-empty text, at least one ready attachment, or both. Client capture time is provenance, not commit ordering; server recorded time orders history. Validate requested scope against authenticated authority. Captured URIs describe provenance, not arbitrary server fetch instructions.

All IDs and manifest values are frozen before transfer begins. The server verifies each media object belongs to an authorised upload/scope, matches digest/size, is durably published and is protected against collection. It creates inbox root/payload, placements, changeset, receipt and required work in one transaction. No successful text-only result stands in for a missing declared photo.

Keep upload transport separate from record commands:

| Capability | Input / result | Rule |
| --- | --- | --- |
| `PrepareMediaUpload` | Stable upload/media IDs, scope, digest, size, MIME → upload handle/status | Binds identity to caller and immutable bytes. Repeating returns its own status, not a global hash lookup. |
| `TransferMediaBytes` | Handle and bytes → progress | Transport choice/chunking deferred. Upload is operational, not a content changeset. |
| `FinalizeMediaUpload` | Handle → ready / retryable / rejected upload | Verify bytes and durably publish. Ready alone does not create a household attachment. |
| `ResolveMediaUpload` | Handle → current transfer/publication state | If protection expired, recreate/recover exact bytes under safe physical generation before content finalisation. |

Expired handles and physical storage generations are not part of the frozen capture's semantic payload. Retries retain logical media IDs/digests while upload recovery may issue a fresh handle. An uploaded file cannot be attached using an unrelated caller's ID.

Server-only `MediaPublication` and `MediaCollection` capabilities own claim/generation rules. A client never supplies a filesystem path to delete. Historical media queries return `available`, `collected`, or `recovery_possible` with authorised metadata; a source URI alone is not proof recovery will succeed.

## 5. Ordinary edits, deletion and dates

| Command | Essential arguments | Result / guard |
| --- | --- | --- |
| `SetInboxEntryText` | Inbox ID, expected revision, text | New revision; reject stale revision or invalid empty content after considering existing attachments. |
| `DeleteInboxEntry` | Inbox ID, expected revision | New tombstone revision; retain receipt/history. Explicitly handle media reference release. |
| `RestoreInboxEntry` | Inbox ID, expected tombstone revision | New revision if authorised and required media/invariants permit; not a revision rewind. |
| `SetTaskOccurrenceTarget` | Occurrence ID, expected revision, target | Target is absent, date-only, or instant. Does not change deadline, completion or recurrence definition. |
| `SetTaskOccurrenceDeadline` | Occurrence ID, expected revision, deadline | Explicit real-deadline edit; same date/instant distinction. |
| `SetTaskOccurrenceReviewDate` | Occurrence ID, expected revision, date or absent | Resurface for a decision, not overdue-work classification. |
| `SetRecordPinned` | View ID, record ID, desired boolean, expected view preference revision | Changes view-owned preference only; no target revision/history change. |
| `SnoozeReminderOccurrence` | Reminder occurrence ID, expected schedule generation, until instant | Personal operational update; stale generation is not silently applied to a different reminder. |
| `SetAttentionSnooze` | Record ID, until instant or absent | Last committed personal preference wins; no shared task edit or content history. |

The last three are still retry-safe mutations with receipts, but do not create content changesets. Results distinguish saved preference/operational state from saved content. For `SetRecordPinned`, an already-satisfied boolean can return `Unchanged`; if a change is needed, validate the view preference revision. Add explicit ordering arguments only to a separate reorder operation.

Day/week/month shortcut buttons resolve to a visible absolute target before first submission, using the intended calendar/timezone semantics. Never recompute “one week from now” on each retry. The UI must distinguish rescheduling from snoozing; selecting a preset and selecting a date ultimately use the same appropriate command.

For ordinary content edits, validate expected revision even when submitted text happens to match current text. An old form is not proof that the user reviewed intervening edits. Commands with a useful desired-state no-op exception state that exception explicitly; do not generalise it to all edits.

## 6. Task completion and recurrence correction

```text
CompleteTaskOccurrence {
    occurrenceId: TaskOccurrenceId
    expectedOccurrenceRevision: Revision
    expectedTaskRevision: Revision
    when: Now | RecordedInstant(Instant)
    performedByPersonId?: PersonId
    note?: Text
    preparedAttachments?: [AttachmentManifest]
}

TaskOccurrenceCompleted {
    occurrenceId, occurrenceRevision, completionId,
    nextOccurrenceId?, maintenanceRecordId?, cookingRecordId?
}
```

`Now` is interpreted once at the first successful commit, never again on replay. A backdated explicit instant is preserved. Authenticated actor and claimed performer are separate: recording “wife did this yesterday” does not authenticate her as the actor or put the action in her undo history. Personal clients may record the other household member as performer explicitly; shared clients default to unknown performer unless a labelled claim is supplied.

Receipt replay runs first. For a new operation, authorise the current target, then apply this explicit exception: if it is already completed and the request is a plain `Now` completion without extra note, attachments or performer claim, return `Unchanged(already_completed)` and the authorised existing result. Do not add another completion or attribute it to this caller. Requests with additional details receive a conflict and preserve those details for a deliberate correction.

If still open, require both occurrence and task revisions. Use the validated recurrence rule to create completion, optional maintenance/cooking records, next occurrence and operational reminder consequences in the same action. Do not silently complete a replacement occurrence when the requested one was skipped/deleted.

`CorrectTaskCompletion` supplies expected revisions of the completion and affected linked records/next occurrence from a correction preview, plus corrected time/performer/note. The server rechecks the recurrence definition and all relevant dependencies in the write transaction. If the next occurrence was independently edited or worked on, reject automatic recalculation; keep history/copy and ordinary explicit edits available.

`SkipTaskOccurrence` is separate, creates no completion, and requires an explicit next target for after-completion recurrence. Fixed-calendar catch-up policy remains proposed in [the model](DATA_MODEL.md#7-tasks-recurrence-and-maintenance); contract precision does not mark that product policy accepted.

## 7. Importing and planning a recipe

| Command | Arguments / outcome | Boundary |
| --- | --- | --- |
| `ImportRecipe` | Recipe ID, scope, URL, initial collection IDs → placeholder revision and import/job identity | Saves immediately and queues extraction; success means saved request, not successful extraction. |
| `ApplyRecipeImport` | Import result ID, recipe ID, expected revision, explicit selected imported fields → new revision | Authorised worker or human review path; result must belong to recipe. Retains household adjustments. |
| `PlanRecipeMeal` | Recipe ID/revision, proposed task/occurrence IDs, target, selected ingredient IDs, explicit shopping destinations and quantities → created/updated IDs/revisions | Atomic Tasks + Shopping + typed links/provenance; requires current source revision and authorised destinations. |

Extractor returns a typed `RecipeCandidate` containing title, ingredients, steps, yield, image candidates and field provenance. It has no write context. Metadata and optional later LLM extraction use this same boundary. The worker prepares media and calls the application layer; arbitrary extracted text never selects a command or author.

An import that collides with a recipe edit becomes reviewable work. A user-reviewed apply has a new operation ID and the current expected revision; do not mutate/retry the worker's rejected payload under its original ID. Causality links the request and applied result while attribution distinguishes worker from user.

Meal planning does not blindly merge shopping labels. Each selected ingredient states create-new versus a supported explicit restock/reuse choice. Reused entries carry expected revisions if their quantity/content will change. Source text and recipe revision are snapshotted for provenance. A stale recipe or shopping input rejects the compound action before any partial creation remains.

Recipe Soon pins remain view preferences, independent of meal scheduling and Want to try/Favourites membership. Deeper collection operations can follow the same patterns; they do not require a new general workflow framework.

## 8. History and personal inverse operations

```text
GetRecordHistory(recordId, cursor?, actorFilter?) -> authorised history page
GetRecordVersion(recordId, revision) -> historical content + current media availability
GetActionReversalAvailability(changeSetId) -> available | blocked(safeReason)
UndoAction { targetChangeSetId } -> newChangeSetId + changed record revisions
RedoAction { undoChangeSetId } -> newChangeSetId + changed record revisions
```

Availability is a hint that may become stale; execution rechecks every guard. Actor filters narrow history listings, never the changes needed to reconstruct a version. Historical results are read-only; copying text into an editor creates a normal revision-checked command.

An undo checks authenticated human ownership, current permission, affected roots' expected post-action revisions, additional guards and domain predicates. Read-only links tolerate tombstones; a private link to shared content must not block a shared deletion or disclose itself through an error. Same-scope business dependencies, such as purchases consuming shopping entries, can prevent the inverse.

Redo names the committed Undo action it reverses. Proposed journal convention: `undo_of_id` references the action undone; `redo_of_id` references the Undo changeset being reversed. Its original action is available through that Undo's `undo_of_id`. This makes the precise reversal link durable without choosing targets from timestamps. Check that the target is an eligible undo by this person and has not already been reversed; current revision guards still apply. Repeated clicks use operation receipts.

Initially offer reversal of eligible recent actions, plus redo of an eligible undo. Do not promise arbitrary selective undo or a whole stack through intervening shared edits. Async worker actions can block a stale human inverse, including an imported recipe changing after its placeholder was created; history and explicit deletion remain available. Grouping that causal chain into one future inverse needs its own rule.

### Versioned history payload

```json
{
  "payloadVersion": 1,
  "kind": "recipe",
  "fields": {"title": {"before": "Soup", "after": "Lentil soup"}},
  "children": [
    {
      "collection": "adjustments",
      "id": "adjustment-example",
      "operation": "insert",
      "before": null,
      "after": {"body": "Use half the salt", "personId": "person-example"}
    }
  ]
}
```

This is a semantic example, not a complete production codec. Each kind has a static allowed field/child vocabulary and typed decoder. Root identity/revisions/scopes live in the history envelope. Insert/delete/retire deltas preserve old/new values and stable child IDs. Byte content is represented by logical media references, never binary diffs or physical file keys. Full non-binary baselines accompany creation and an audience-expanding share snapshot; a newly authorised reader never receives private before-values.

Codec versions are independent of HTTP contract versions. Migrations must keep old decoders or explicitly transform retained deltas while preserving chronology and meanings. The first history implementation should demonstrate decoding an older payload fixture after a schema/codec revision before relying on it for durable recovery.

## 9. Read projections and cache

| Query | Result / rule |
| --- | --- |
| `GetInboxEntry`, `GetRecipe`, `GetTaskOccurrence` | Typed current content, revision, permitted relationships and attachment descriptors; no upload secrets or raw DB rows. |
| `GetRecordHeader` | Minimal authorised kind/title/status for generic link cards; `unavailable` without disclosing whether an inaccessible ID exists. |
| `GetPersonalOverview(viewId)` | Sections/counts/order from permitted view configuration and current person's access. Shared activity is a filtered projection, not journal rows. |
| `GetCacheSnapshot` | One consistent authorised content projection with opaque generation and production timestamp. Atomic local replacement preserves drafts/in-flight requests. |
| `GetMedia` | Authorised bytes/variant or meaningful unavailable result; no permanent public file-path access that bypasses later scope checks. |
| `GetStorageUsage` | Timestamped DB/auxiliary/media measurements; last known sample usable offline. |
| `GetBackupStatus` | Administrative projection of completed local export sizes, last checked availability, verification and run errors; optional timestamped external-backup report. Unknown remote state is explicit; no archive contents or general host-file access. |

Start with one bounded full cache snapshot and on-demand media/history for this household. If size eventually requires pagination, all pages must belong to one stable snapshot; do not combine unrelated reads into a claimed coherent snapshot. Full-cache refresh need not expose global commit sequence numbers or private activity counts. An operation result's revisions describe its commit, while cache refresh describes its own later snapshot; reconciliation cannot regress a newer current view by treating an old replay as fresh content.

Guard snapshot application with a local cache-update generation: if an accepted command or a newer direct read changed local current-state knowledge after the refresh began, discard/refetch the older snapshot instead of overwriting it. Serialise local cache application; compare record revisions when incorporating individual current reads. This avoids inventing a distributed merge protocol while handling out-of-order replies. A refresh may still be stale relative to unseen changes by the other person, so show its timestamp and retain normal expected-revision checks.

Phone caches are partitioned by signed-in identity. Signing in as someone else cannot reuse private rows or queued credentials from the earlier person. Existing cached shopping and household content stay read-only offline. Media cache eviction is separate from draft/pending-upload retention.

Cache/current-read metadata also identifies the installation and recovery epoch. A changed epoch suspends old automatic writes, preserves local recovery material and invalidates assumptions about old revisions. Explicit recovery/abandonment uses [the restore contract](RESTORE_RECONCILIATION.md), not ordinary cancellation of an uncertain submission.

## 10. Module interfaces and transaction composition

```text
Transport adapter
    -> authenticated RequestContext + typed command
    -> WriteCoordinator.execute(handler, context, command)
        -> one ActionContext / database transaction
        -> feature handler and typed repositories
        -> tracked record changes + invariant checks
        -> history, jobs, final receipt
    -> permitted outcome projection
```

| Capability | Owned responsibility |
| --- | --- |
| `WriteCoordinator` | Receipt arbitration, one transaction/savepoint policy, finality, record revision bookkeeping and atomic finalisation. |
| `ActionContext` | Transaction-scoped access to actor, clock, change tracker and participating repositories. Cannot outlive the transaction or be reused by a background network call. |
| `RecordChanges` | Track affected roots and owned rows; produce one revision advance/delta per root; validate complete subtype and visibility rules before commit. |
| Feature handlers/repositories | Typed domain rules and state changes inside supplied context. No independent commits, transport handling or direct writes into another feature's tables. |
| `HistoryCodec` / reversal policy | Kind-specific logical snapshot/delta interpretation and domain inverse/dependency rules. |
| `MediaStore` / publication coordinator | Byte storage and claims; expose ready authorised identities to content transactions. |
| `BackupCoordinator` / `MediaRetentionGate` | Online SQLite snapshot and manifest from the copied DB; protect immutable bytes against every physical deletion path while copying, verify and publish completed exports. Existing worker/operational jobs, outside content transactions; not a second service or content-history feature. |
| `RecipeExtractor`, `CalendarAdapter`, `ReminderChannel` | External effects/preparation outside content transactions; no direct domain SQL. |
| Client draft/submission/cache capabilities | Distinct mutable editing, frozen attempts, read projections and media retention. |

Repositories enlist their owning root before changing typed payload/children; finalisation cannot depend on individual UI callers remembering to append history. Features supply semantic codecs/invariants, while the coordinator handles revision/history consistency. An implementation must verify that bypassing root tracking is impossible through normal repository APIs; naming a tracker alone does not establish that property.

`CompleteTaskOccurrence` composes Tasks, Maintenance and scheduling operations under one context. `PlanRecipeMeal` composes Recipes, Tasks and Shopping the same way. A compound action has one public handler and one receipt, not nested public commands each committing their own receipt. A background follow-up is a separate action with its own operation ID and causal link.

These are responsibilities and function/interface contracts, not a requirement for one class per command/table. Value types provide useful naming/validation symmetry; ordinary functions suit stateless transformations. Keep a static registry of supported record codecs and handlers, without runtime plugin loading or an inherited universal household entity.

## 11. Review result and next decision

This pass refines three points in the connected model: durable rejection is an explicit final outcome with a local `REJECTED` branch; desired-state no-ops are command-specific; and redo names the precise Undo changeset it reverses. All remain proposals. Existing accepted offline/media/privacy requirements are preserved.

The comparison is now in [STACK_SELECTION.md](STACK_SELECTION.md), with concrete package boundaries and build gates in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The working choice shares React screens through Capacitor while Kotlin owns native persistence/capture; TypeScript/Fastify implements the server. Device/host proof gates remain explicit.

Later implementation checks should exercise lost-response replay, duplicate submit gestures, terminal-rejection arbitration, stale same-text edits, competing completions with extra details, multi-module rollback, import-after-edit, private-link deletion behaviour, redo target validation and cache refresh while a command is pending. No new executable tests or application scaffold were added for this document pass.
