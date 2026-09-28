# A13: File media and container storage

Date: 2026-09-25. Updated: 2026-09-26 with development-loop and Windows host guidance. Status: files for host media and dedicated Docker persistence are agreed directions. The expected host is Windows with local NVMe and backups to the main PC. The working Windows recommendation uses a local Linux-backed named volume in place of the earlier illustrative host-directory bind mount; [WINDOWS_DEPLOYMENT.md](../WINDOWS_DEPLOYMENT.md) explains that refinement. Exact paths, backend configuration and implementation remain proposed. Nothing has been deployed. This supersedes the host-BLOB preference in earlier drafts; the archived architecture remains historical.

Read with [ARCHITECTURE.md](../ARCHITECTURE.md), [DATA_MODEL.md](../DATA_MODEL.md), [capture submission](0001-offline-capture-submission.md), and [history/media retention](0002-record-history-and-media-retention.md).

## 1. Storage boundary

Use one SQLite database for domain records, record history, identity/settings, operation receipts, media metadata and references, and background work. Store media bytes as immutable ordinary files in an application-owned directory. Keep source URIs, content hashes, sizes, types, physical storage keys and lifecycle state in the database. Application records and clients use stable media IDs, not host paths.

The `MediaStore` interface is backed by `FileMediaStore` initially. Use one file-storage policy for original images and derived image files; a thumbnail cache can be regenerated but must follow the same visibility rules. No second database or object-storage service is required. The selected Android stack keeps pending media in app-private files owned by the Kotlin client core, protected from cache eviction.

Illustrative persistent layout for the Windows target, not created storage:

```text
local Linux-backed named volume: household-data  ->  container: /data/
    db/household.sqlite
    media/objects/
    media/derived/
    media/staging/
```

Mount the database directory, including SQLite's companion files, rather than exposing only a single database file. Staging and final media directories should be on the same filesystem for the chosen publish mechanism. Durable database/media storage belongs in the mount, not the replaceable container layer. App-created backup exports use a separate dedicated writable `/backups` mount; the host's backup system owns independent retained copies outside the app's write access. This revises the earlier external-only backup proposal following the user's review.

The earlier `/srv/household-manager` bind-mount example remains a possible Linux-host arrangement. Bind mounts expose a selected host directory; a named volume gives Docker management of the persistent directory. Both preserve ordinary files and both allow the app to delete its own data. A dedicated app-only mount limits unrelated data reachable through that mount. On Windows, the named volume trades direct Explorer access for a Linux storage boundary; backup exports provide accessible copies. [Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/), [Docker volumes](https://docs.docker.com/engine/storage/volumes/)

The intended container runs without privileged mode, broad unrelated host mounts or the Docker socket. Use a non-root app identity with permissions on its data directories. A read-only application filesystem with explicit writable data/temp locations is a useful configuration to evaluate once the runtime is selected. This is a small deployment boundary, not a claim that containerisation alone guarantees data safety.

## 2. Publishing media before committing its reference

The guarantee changes from "bytes and records share one SQL commit" to "every newly committed live reference points to a durably published file." SQL rollback cannot undo filesystem operations.

1. Authenticate the upload and assign stable media/upload identities. Receive bytes into an app-controlled staging location outside the database transaction. Validate content and the expected digest/length.
2. Track active publication so orphan cleanup cannot mistake an in-progress object for abandoned data. The upload metadata, publication claim, and expiry rules are part of the media contract; these states describe filesystem work that actually spans time, not a copy of client communication stages.
3. Publish the complete immutable file at an opaque generated storage key. Require durable file and directory operations appropriate to the host filesystem; an atomic rename alone is not the entire power-loss durability contract. Never overwrite an existing different object at the same key.
4. In one short database transaction, verify file readiness/publication ownership, make media metadata ready, and commit the domain record, attachment links, logical change set, operation receipt and required jobs. Serialise finalisation against collection claims. No write transaction waits while receiving the upload or fetching an external URL.
5. Acknowledge the complete capture only after that transaction commits. On retry, resolve its operation receipt and stable media identities rather than create a second entry or attach the same photo twice. A prior successful receipt does not imply that intentionally deleted media is still retained.

If publication succeeds but the database commit fails, the file remains pending/unreferenced and is recoverable by retry or later eligible for orphan cleanup. Incomplete staging files are never served as valid attachments. Define abandoned-upload expiry separately from the roughly 24-hour grace period for formerly attached media; ordinary active uploads must not be deleted just because they are old.

Metadata-only edits still commit entirely within SQLite. Replacing a photo publishes a new file first, then atomically changes the reference and history. File names are app-generated, independent of user titles and original upload names. Never construct cleanup paths from user-supplied filenames or source URIs.

## 3. Collection across a filesystem boundary

Keep the agreed approximately 24-hour grace period after the last live reference disappears; storage pressure may shorten it for eligible objects. Historical references retain metadata, not bytes. Model storage lifecycle separately from the record's domain state.

For tracked published objects, use the following proposed collection protocol:

1. In a database transaction, recheck live references, retention timing, active publication and backup protection. Claim the eligible object for deletion, retaining its exact physical key/generation, and commit that claim.
2. New attachment/recovery operations must not attach an object with an active deletion claim. If reattachment wins before the claim, it clears eligibility and collection fails its check. This prevents a reference-versus-unlink race.
3. Delete only the claimed regular file within the media store's designated subtree. Refuse paths escaping that root, root-directory deletion and symlink traversal. Normal collection acts on individual owned objects; it is not a recursive wipe of `/data` or a caller-supplied directory.
4. Record collection completion in a new transaction, keeping the small historical metadata tombstone. A missing file after a resumed deletion is an idempotent completion; an I/O failure leaves the claim available for retry.

This can use conceptual states such as ready, deleting and collected; exact column layout comes with DDL. A crash after the claim or after unlink is recoverable because completion is retryable and reattachment is gated. Do not unlink a file inside a transaction and assume rolling back that transaction would restore its bytes.

Physical storage keys/generations must not be reused while a stale deletion could still target them. Recovering an exact historical image from its source can retain the logical media ID while publishing to a fresh physical key, after any prior deletion is resolved. Different recovered bytes remain a different media object as specified in A09.

Keep cleanup's filesystem capability rooted at media/staging or the appropriate media-object subtree. Database files and backup destinations are outside those cleanup roots. The container's dedicated mount limits access to other host data, while these application checks protect live household records inside the mount.

## 4. Backup and restore

A database-only backup is now incomplete. A recoverable backup contains a consistent database state plus all files required by its live references, with hashes or a manifest suitable for checking completeness. Source URLs are optional recovery aids, not replacements for backing up household photos and receipts.

For routine backups, keep the app usable: acquire a coarse media-collection hold, drain previously started deletions, create a consistent SQLite snapshot with the online backup API, derive the file manifest from that copied database, and copy/verify its immutable ready originals before releasing the hold. Ordinary edits, uploads and logical deletes may continue. Every physical deletion path must obey the hold, including space-pressure collection. Failed/interrupted runs are abandoned safely; an old partial manifest is never resumed after unprotected collection. [The Windows procedure](../WINDOWS_DEPLOYMENT.md#3-backup-procedure) gives the exact sequencing and restore treatment of omitted staging/derived data.

This uses the existing immutable-file invariant and adds a small backup/collection gate; fine-grained per-file pins are unnecessary initially. Publish only verified complete exports into the dedicated output mount. The host's existing backup software can protect those exports remotely, including through VSS, without needing to understand the live SQLite/media protocol. A correctly coordinated filesystem snapshot or stopped-app whole-volume copy remains an alternative; inactivity at 6 a.m. is not itself a consistency guarantee. Windows host snapshots of Docker's virtual disk require backend/product-specific verification.

Test restore into a separate location/container and verify database integrity, reference/file availability and representative image reads before treating the backup process as ready. Incomplete staging work can be retried from the phone; a backup must identify which committed media it guarantees to restore. The app can manage its local exports, while independent remote retention belongs to the external backup system. UI backup status needs only app-output metadata and an optional external status report, not a mount of the whole remote repository.

## 5. Development and container packaging

Docker is the intended deployment format; the user reasonably wants to avoid slowing routine development. Proposed approach: design the runtime contract now, support direct execution, and add/test the image when the first server slice becomes runnable. Do not postpone all container verification until the app is nearly complete, and do not require Docker for every unit test or source edit.

Use the same application entry point, dependency declarations, migration code and configurable data-root settings in direct and container runs. Tests use isolated temporary roots and the same SQLite/file-store implementation. Root-bounded deletion rules apply to direct development too; container isolation is not required for their correctness. Do not use household production data for development or image tests.

An early deployment check should start the image with the intended non-root identity and a disposable volume of the intended kind, save a record/photo, replace the container without deleting the volume, and verify persistence. It should also exercise migration/startup, shutdown during an operation, and the backup/restore procedure. These targeted integration checks supplement fast direct tests rather than becoming the required route for all tests.

If developing inside Docker is convenient for the eventual stack, Compose Watch supports source sync, restart, and rebuild actions, and Docker's layer cache can reuse unchanged build work. This means a source edit need not imply rebuilding the full image. Actual reload/startup speed depends on the runtime, dependencies, host and file-sharing arrangement; no performance has been measured here. [Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/), [Docker build cache](https://docs.docker.com/build/cache/)

Keep durable data out of image layers/build contexts. Separate development-only source synchronisation from the production image. Once the stack is chosen, select the simplest scripts and optional Compose overrides; there is no Dockerfile, container or running service yet.

## 6. UI and review consequences

Settings > Storage reports database storage (including companion files), media files, staging/derived files where useful, and an explicitly labelled total. Show bytes awaiting collection as a subset, not an extra amount added again. Host counters/measurements are timestamped and cached for offline display. Database internal free pages do not measure space occupied by external media.

Review the final host filesystem and container configuration, file durability/publish primitives, idempotent upload identities, collection claims, and backup/collection coordination before implementation. These are bounded storage contracts inside one app, not new independently deployed services.

The selected working stack and deployment sequence are in [STACK_SELECTION.md](../STACK_SELECTION.md) and [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md). The supplied host/storage context and revised online backup proposal are incorporated in [WINDOWS_DEPLOYMENT.md](../WINDOWS_DEPLOYMENT.md); exact paths, external backup integration and unattended startup remain installation values. A cold copy remains a fallback; routine backup need not pause the app.

Restoring older data can remove receipts and revert record revisions. The supported restore path must stop the old authority, verify database/files, rotate the server recovery epoch before serving writes, and reconcile old client submissions and external-effect jobs as specified in [RESTORE_RECONCILIATION.md](../RESTORE_RECONCILIATION.md). A restored file tree alone does not establish continuity of the application protocol.

Acceptance scenarios: upload interrupted before publication leaves no live reference; a crash after durable publication but before SQL commit leaves recoverable pending/orphan media; commit followed by lost acknowledgement returns one receipt on retry; reattachment and collection cannot both succeed for the same storage generation; a crash after unlink completes its tombstone on restart; cleanup cannot enter the database or backup directories; and a restored backup opens every referenced live attachment it claims to contain.
