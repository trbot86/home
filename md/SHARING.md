# Saved-item sharing

Standalone creation defaults to Just me. Children retain their list, project,
recipe or asset visibility. Existing drafts and frozen requests keep their saved
scope until the person changes it.

Saved editors offer Share with household. The server previews the connected
private records, including deleted records and references retained in history.
The person explicitly confirms that entire group, photos and previous history.
Already-shared targets do not pull additional private records into the group.
Sharing is one-way; its history entry cannot be undone.

ShareRecords uses the ordinary command envelope, recovery epoch, transaction,
history and receipt protocol. The preview digest includes the epoch, current
revisions, related payload rows and project views. A changed group requires a
fresh preview. Scope-bearing payloads move atomically with their record roots,
retained media and project pins; foreign keys and feature integrity are checked
before commit. Original history deltas and operation receipts are preserved.
Historical visibility is expanded only for records explicitly shared by this
command. Unrelated private records and global personal views stay private.

Personal built-in recipe collections become named shared collections to avoid
colliding with household collection roles. Unfinished recipe imports stop;
fetched results remain available for human review. The preview explains these
consequences when applicable. Worker identities, original revision grants and
provenance are retained; sharing never refreshes a worker's authority.

Migration 028 changes only scope-transition guards, without rewriting data.
Deployment must use the existing backup-verified upgrade command. Android uses
the existing durable command store and a read-only sharing-preview bridge;
there is no Room migration, reinstall or capture-queue reset.

Focused checks: record-sharing, worker-auth, upgrades and capture server tests;
record-sharing and visibility-defaults browser tests; server/web typechecks;
web build; Android Kotlin compilation and CaptureStore tests; package boundary
and staged public-source audits. Combined regression suites, distribution
builds and device verification belong to release coordination.
