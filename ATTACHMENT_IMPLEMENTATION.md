# Record photos and receipts

Deployed 2026-09-27. Migration006 is published and must not be edited.

Inbox entries, task definitions and task completions share a photo editor. The
editor accepts JPEG, PNG and WebP images, captions, reordering and removal, with
20 photos per record and a 25 MB limit per photo. The image viewer also works
from historical versions. A historical photo can become unavailable after its
last live reference is removed and the media retention period expires.

`AttachmentRepository` owns placement validation and byte retention. Each record
adapter explicitly opts into attachment editing and retains its own lifecycle
rules. `SetRecordAttachments` shares the parent's revision, transaction, history
and command receipt. Migration006 preserves placement IDs and removed rows while
making display positions unique only among live placements.

The browser IndexedDB v2 and Android Room v3 stores hold dedicated attachment
drafts. Captions/order and newly acquired originals persist locally. Submission
freezes one command and its upload dependencies before any network request.
Retries resolve a receipt before uploading; final receipt and draft state change
atomically. A stale background reply cannot overwrite a newer request for the
same record. Reconciliation after a restored server uses that same finalizer.

Closing retains unfinished work. Offline existing records are read-only. A
conflicting revision preserves the draft for inspection and explicit discard;
it never silently overwrites the partner's changes. Confirmed originals are
released only after refreshing the server view. Android camera/gallery intents
persist their target kind so they return to the correct draft after interruption.

Verification uses temporary households and the project-owned emulator. Tests
cover browser v1 migration, Room v1/v2 migration, server placement migration,
lost replies across restart, per-user undo, profile isolation and shared byte
downloads. `scripts/verify-android-attachments.mjs` checks the native editor;
camera/gallery handoff was also exercised with synthetic emulator images.

Maintenance assets/service records will reuse this editor and repository.
PDF/document attachments, moving a rejected photo draft into Inbox, and changes
to storage retention are outside this slice.
