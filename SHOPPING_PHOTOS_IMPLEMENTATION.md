# Shopping photos and receipts

Status: implemented and verified; publication in progress.

Restock products keep photos of the package, product label or compatible part.
They are visible on the shelf and in a product-photo disclosure on shopping items
created with **Need this**. These are references to the current product; adding a
shopping item does not copy or freeze its images. Deleted products stop supplying
that reference preview.

Completed purchases have separate **Receipt photos** and **Purchase history**
actions. Receipts appear with that purchase and in Recently done. Restocking the
same product again retains its product photos and does not copy an old receipt.
Buying replacements continues to leave installation/maintenance records alone.

Both actions open the existing photo editor with captions, order, removal, camera
and gallery acquisition on Android, and file selection on desktop. Closing or
Android Back retains the photo draft. Submission uses the existing immutable
upload/command attempt and receipt reconciliation. Existing records remain
read-only offline; drafts and cached metadata remain available, with the existing
bounded Android cache of viewed images. Browser server-photo URLs require a
connection after reload.

## Ownership and compatibility

Only `restock_item` and `purchase` opt into `SetRecordAttachments`; lists and
shopping entries do not become separate photo owners. ShoppingRepository uses
AttachmentRepository for placements, equal-scope validation, revision checks,
history and retention. All placement changes share the parent transaction.

Purchase time, buyer and item snapshots remain immutable. Photos can change without
rewriting those facts or changing the shopping item's state/revision. Ordinary
per-user undo/redo applies to the photo action; a subsequent change can block an
earlier purchase undo under the existing conservative conflict rules.

The content schema accepts a missing `attachments` field in older history and
cached snapshots, normalising it to an empty list. Old detail-update commands
retain current photos because the repository applies their fields to the current
record. Existing journals and receipts are not rewritten. The existing placement
tables are sufficient; no server or Android database migration is introduced.

Private gift products, receipts and their history use the same scope as their
parent. Shared activity and the other profile's cache/media access do not expose
them. Photos are not copied across visibility boundaries.

## Verification

Four server tests cover legacy history, old-client edits, purchase immutability,
receipt replay, partner revision conflicts, private visibility, unsupported kinds,
failed-commit rollback and media retention through removal/undo/deletion/restore.
All 225 package tests pass in the production Linux image (224 pass and one
platform-specific skip on Windows). Typechecking, package boundaries, production
builds, ten affected browser flows and fourteen Android unit tests pass.

Browser flows exercise product references versus receipts, private media access,
receipt undo/redo/history/activity, a fresh restock after purchase, local photo
drafts, and 320/390/820/1440-pixel layouts. An in-place emulator APK replacement
preserves its existing profile, all caches, pending photo capture and editor text.
The native workflow then verifies photo drafts through Back/reload, partner photo
downloads, purchase history, and cached product/receipt images after shutting down
the synthetic server. No tests use live household records. Final release evidence
follows publication.
