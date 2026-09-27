# A04 — Freeze inbox captures before submission

Date: 2026-09-25; schema references revised 2026-09-26. Status: freeze-before-send direction agreed; protocol/schema mechanics proposed, not implemented. SQLite remains the working preference.

All host relations below live in one application database; local drafts and submissions share one phone database. The connected review in [DATA_MODEL.md](../DATA_MODEL.md) proposes a common client-scoped operation receipt and nullable human attribution. [APPLICATION_CONTRACTS.md](../APPLICATION_CONTRACTS.md) refines final outcomes and the explicit local rejection branch while preserving freeze-before-send.

The stack/restore pass additionally binds frozen submissions to an installation and server recovery epoch. A normal restart does not change that epoch; restoring an older backup does. Resolve surviving receipts normally, but pause missing-receipt requests from an old epoch for [explicit reconciliation](../RESTORE_RECONCILIATION.md). A frozen request is never silently rewritten to the new epoch.

## Decision

Existing server records are read-only offline. A new inbox capture is a local draft that may be edited or deleted until the first submission is prepared. Before any request can leave the phone, durably freeze its create payload and mark it submitted. Keep that payload immutable until the server confirms the outcome. Subsequent changes use ordinary online update/delete operations after resolving the create.

This adopts the user's explicit proposal to lock editing after an upload attempt, including when no acknowledgement arrives. No queue of post-submission draft corrections is required. A connection indicator is a reason to try a request, not proof of its outcome.

Local autosave of an unfinished form does not request upload. Record submission intent separately (for example, a nullable `submission_requested_at` on a capture draft) when Save/Submit or the agreed voice-capture completion event occurs. Only ready captures can be frozen by the uploader. This distinction does not add a second independently writable copy of the draft or a queue of updates to existing server records.

## Client state and transitions

| State | Meaning | Allowed changes |
| --- | --- | --- |
| `DRAFT` | Capture exists only locally and has never been prepared for submission; separate intent distinguishes unfinished work from a capture ready to send. | Edit or delete locally. |
| `SUBMITTED` | The create payload is frozen; delivery may not have started, may be in progress, or may have committed without a reply. | Retry the identical submission or resolve its receipt. No local content edits or deletion. |
| `ACKNOWLEDGED` | Server creation is confirmed and the stable server identity is known. | Online update/delete against the current server revision; offline access is read-only. |
| `REJECTED` | A durable terminal rejection receipt confirms this operation cannot create the entry. | Keep the frozen request; copy recoverable content into a new draft/operation for correction. Never reopen the original payload. |

Connectivity, retry timing, and last error are separate operational fields, not substitutes for these ownership states. Suggested UI text for `SUBMITTED`: "Waiting for confirmation". Avoid "Uploaded" when persistence is still unknown.

The local transition is a short database transaction:

1. Check that the draft remains `DRAFT` at the expected local revision, submission was requested, and all selected attachment bytes are durably available locally.
2. Persist its immutable request payload (including any attachment manifest), stable client capture ID, and `SUBMITTED` state together.
3. Commit that local transaction.
4. Only then issue the network request.

Every local editor/deleter must also check state in its write transaction, so an edit racing with submission either becomes part of the frozen snapshot or fails cleanly. UI disabling alone is insufficient. This uses persistent state to control editing; do not hold a database transaction or row lock across a network call.

A crash after step 3 but before step 4 is harmless: restart discovers `SUBMITTED` and sends the stored request. A crash after server commit but before local acknowledgement also leaves the same retryable state. Do not return to `DRAFT` because of a timeout, apparent disconnection, or a lookup that finds no receipt yet; an earlier request may still be running or arrive later.

## Submission identity and relational storage

### Captures containing photos

A capture may contain text, one or more photos, or both. Camera/gallery acquisition first creates app-owned local media with stable identities; do not assume a picker URI alone guarantees that a future background upload can read the bytes. Persist the form and pending acquisition context before leaving for the camera/picker. Unavailable/cancelled acquisition leaves the rest of the draft recoverable, and the user can retry or remove the incomplete attachment before submission.

Freeze the selected media IDs, ordering/captions where present, content digests, and actual bytes alongside the capture payload. Do not re-encode or replace bytes differently on a retry under the same identity. Pending local media is protected by its draft/submission reference until discarded before freeze or confirmed durably accepted by the server; ordinary cache cleanup and the old-media retention timer must not erase it.

The server durably publishes all declared media files before committing the entry, media metadata/attachment links, change set, and receipt in one database transaction. Only then can it confirm the complete capture. Whether uploads arrive in one bounded request or separate requests remains an API design choice; both protect staging/publication against cleanup as specified in [A13](0003-file-media-and-container-storage.md). Missing/expired uploads can be resent from the protected local copy, and retries must not duplicate attachments. A failed SQL commit may leave pending/unreferenced files; it cannot roll back filesystem publication. A text-only acknowledgement cannot silently stand in for a failed photo upload.

### Capture receipt

Generate a stable operation ID once for the capture's submission intent (the earlier `client_capture_id`). It identifies the create intent, not the text: separately captured identical notes remain legitimate separate entries. Retries reuse the same ID and immutable payload. The proposed common name is `operation_id`, scoped to the authenticated logical `client_id`.

Illustrative server relations, aligned with the connected model (exact DDL remains provisional):

```text
records
    record_id PRIMARY KEY
    record_kind, scope_id, revision, created_at, updated_at, deleted_at

inbox_entries
    inbox_id PRIMARY KEY / typed registry foreign key
    captured_text, captured_at, source_kind, source_uri, filed_at

operation_receipts
    client_id
    operation_id
    request_digest
    actor_person_id (nullable)
    outcome, change_set_id, result_json, recorded_at
    PRIMARY KEY (client_id, operation_id)
```

The receipt stores the original digest and resulting identity independently of mutable inbox content. The server digests canonical operation/version, expected recovery epoch, stable authenticated identity and submitted fields/media manifest, excluding tokens, transport headers and retry timestamps. A local integrity hash of frozen serialized bytes is separate from that canonical server digest. Client/person identity comes from authentication; a payload actor cannot choose a receipt namespace. Personal clients identify a person; shared integration clients may not. Credentials can rotate without changing the logical client. This single-household deployment needs no tenant key on every relation. `capture_submissions` names the phone's immutable queue, not a second server receipt table.

After any declared files are durably published, one server database transaction must arbitrate the unique submission key, insert the inbox entry and media metadata/links, persist its change set and creation receipt, and record any required follow-up work. Respond with acceptance only after commit. Concurrent submissions of the same key must be resolved by the database uniqueness/transaction mechanism, not an unprotected application-level "check, then insert". On a duplicate-key race, wait for or retry after the winning transaction as required by the selected database's isolation semantics, then read the committed receipt.

Server behaviour:

- **New key:** commit one entry and its receipt.
- **Existing key with matching digest:** return the original creation receipt without changing the current entry or rerunning follow-up effects.
- **Existing key with different digest:** reject key reuse with a conflict; never silently overwrite the entry.

The unique key could instead live on the inbox row if creation provenance and a deletion tombstone were retained there. The proposed separate receipt makes its lifetime explicit and now covers other commands in [APPLICATION_CONTRACTS.md](../APPLICATION_CONTRACTS.md). Shared receipt/transaction handling does not require a universal command/event framework.

Retain the receipt or an equivalent tombstone after an inbox item is filed, changed, or deleted. A late create retry must not recreate a deleted item or undo an online edit. For this small household app, retaining compact receipts indefinitely is the initial proposal. A future expiry policy must explicitly bound supported retries; deleting old receipts silently weakens deduplication. Link/foreign-key and deletion rules must preserve this lifetime rather than cascade away the receipt.

## Transition to online editing

For a submitted capture, Edit can first resolve the creation by retrying the same immutable create or retrieving its confirmed receipt. Then fetch the current inbox entry and revision. Apply the requested change through the normal online API with an expected revision. Mere proof that the phone is online is not enough to skip resolving the create.

Returning the original creation receipt does not assert that the entry still has its original content: another person may have edited, filed, or deleted it. Show the current result rather than restoring the submitted snapshot. Normal update/delete operations also need their own lost-response handling; create idempotency does not automatically make all later commands retry-safe.

Permanent rejection must leave the payload recoverable. The proposed contract records rejection under the same serialised write transaction that arbitrates the operation key, with no partial content effects, before claiming it is terminal. If a transaction aborts, retry resolution must check for a winning receipt first. Only that final receipt permits the local `REJECTED` branch and a corrected copy with a fresh operation identity. A missing receipt, authentication failure or connectivity failure retains `SUBMITTED`; none proves the earlier request cannot commit.

## Consequences

The offline contract is simple: mutable local drafts become immutable submissions, then server-owned records. It avoids general offline merge and draft-cancellation reconciliation. The user-visible cost is that an uncertain submission remains read-only until server contact resolves it, which the user has explicitly accepted. Keep the text readable while waiting and retry with bounded backoff.

This provides at most one committed inbox creation per scoped submission identity, even with concurrent retries, while the receipt is retained. It does not promise network delivery or exactly-once execution by external notification/import providers. Broader offline editing would be a separate future decision.

## Acceptance scenarios for later implementation

- A local edit races with freezing: the immutable snapshot contains the committed edit, or the editor receives a state/revision conflict.
- Local freeze commits and the app crashes before sending: restart submits that same snapshot.
- Two requests with the same key run concurrently: one inbox entry is committed and both resolve to its receipt.
- The server commits but the reply is lost: retry returns the original identity without another entry.
- Reusing the key with a changed payload is rejected without mutation.
- Another client updates or deletes the entry before the original phone retries: replay never overwrites or resurrects it.
- An offline phone can edit/delete a `DRAFT` but cannot modify a `SUBMITTED` or cached server entry.
- Cache refresh and acknowledgement do not display both the local submission and the accepted entry as separate records.
- Reconnecting with an unfinished autosaved form does not submit it; explicit submission intent makes a complete draft eligible.
- Camera/picker cancellation or app interruption preserves the form and distinguishes incomplete acquisition from a saved attachment.
- An offline photo capture survives restart with its bytes, and ordinary cache cleanup does not remove pending media.
- A lost upload/finalisation response retries the same media identities and capture without duplicate attachments; complete acceptance requires the declared media to be durable.

Design references: [AWS, Making retries safe with idempotent APIs](https://d1.awsstatic.com/builderslibrary/pdfs/making-retries-safe-with-idempotent-apis-malcolm-featonby.pdf) explains caller-provided request identities, parameter matching, and atomic recording. [PostgreSQL INSERT](https://www.postgresql.org/docs/18/sql-insert.html) illustrates database-enforced conflict handling; this is not a PostgreSQL selection.
