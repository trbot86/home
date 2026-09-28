# Projects and mixed-media pages

This feature follows the Food release. Migrations 015–016 extend the existing
household volume through the protected upgrade procedure.

Projects have a visual overview, an optional cover/gallery and nested pages.
Pages contain ordered text, web links, cards referencing existing app records,
and photo/screenshot placements. The prominent next-actions area uses independent
view pins; arranging priorities must not rewrite the reference material. Stored
images and outbound web links are visibly different. General file formats and
document previews require explicit media support beyond the current photo pipeline.

Projects and pages are separate revisioned roots. Blocks belong to pages and have
stable, retired identities. Page parents must be in the same project and scope;
ancestor checks reject cycles. Moving a subtree between projects preserves page
and attachment identities, requires matching scope and revisions for every
descendant, and updates the entire subtree in one receipt/history transaction.

Links belong to the source page. Shared pages can link only to shared records;
private pages can also refer to shared records. A link never changes the target's
revision, counts, history or deletion eligibility. A deleted target leaves a
retained unavailable card rather than deleting the page or resurrecting the target.

Archiving retains pages and their media. Deleting a project explicitly validates
all live contained page revisions and tombstones those roots together. Deleting a
page validates all live descendants. External linked records remain untouched.
Undo/redo covers the whole action and rejects conflicting subsequent changes.
Explicit restoration names the pages to restore, so previously deleted pages are
not revived implicitly. Photo recovery retains the existing ready/collected-media
rules; history does not promise indefinite image retention.

Implementation sequence:

1. Add typed contracts, additive project/page/block storage, hierarchy and weak-link
   policies, compound deletion/move/restore, generic photo-editor reconciliation,
   history and preservation tests against isolated databases.
2. Extend view preferences with project context and ordered next-action pins,
   retaining existing Food preferences and retry receipts. Prove that source-owned
   pins do not revise or disclose private target activity.
3. Build responsive visual boards, nested navigation, mixed-media editors, record
   selectors, next actions, archive/trash/history and durable unfinished forms.
   Extend browser and native caches and link navigation together.
4. Verify shared/private navigation, cycle/move/delete races, photo edits,
   interrupted requests, old caches, offline reading and in-place Android updates.
   Rehearse a fresh secondary-backup restore before the protected live upgrade.

No external account or new provider is required for this slice. Calendar delivery,
notifications, LLM filing and arbitrary document ingestion remain separate features.

Progress: the Projects branch has storage/API support and responsive boards with
nested pages, mixed-media editors, photo placements, priority pins, archive,
removal/restoration and history. Editors retain unfinished blocks, including partial
URLs, across closing and reopening. Reference cards open the existing records;
page and project links navigate within the board. Both client caches include the
project snapshot, with empty defaults for older caches. Android photo resolution
includes project and page attachments without changing its database schema.

Ten isolated project tests cover hierarchy, mixed-media history, weak-link privacy,
compound moves/deletions, receipt replay, failed commits, the 014 upgrade and a
backup restoration with actual image bytes. The full server suite has 135 passing
tests and one platform-specific skip on Windows. Contracts and voice-package tests,
typechecking, package boundaries and production builds pass. All 31 browser flows
pass, including four Projects flows and layouts at 320, 390, 820 and 1440 pixels.
The Android APK builds and its ten native unit tests pass.

Project next-action views now extend the same preference service as Food pins.
Their context, scope and order are separate from record revisions/history. Private
projects may pin shared records; shared projects cannot pin private records. The
016 migration preserves existing Food rows and receipts and checks foreign keys
after its table rebuild. Isolated tests cover stale ordering, failed receipts,
target deletion/restoration, private-view isolation, old frozen commands, backup
restoration and rollback after SQL or foreign-key failure during the rebuild.

Native verification now passes on the isolated test emulator: in-place update
preservation, cached pages/photos, nested Back navigation, unfinished page forms,
block order, pins, history and offline inbox capture. Back handlers explicitly
prioritize dialogs, then nested details, then the app fallback; subscription
timing cannot send a nested page straight to the inbox. The release image passes
all 155 Linux package tests. A fresh secondary backup was restored and migrated
through 016 in a disposable production container, preserving all 41 retained
tables and its media.

Projects is deployed on the web and in the private Android download. The protected
upgrade took another verified backup before applying 015–016 to the existing
volume. Both profiles' 19 distinct existing record hashes, installation identity
and recovery epoch were preserved. Live foreign-key/integrity checks and read-only
desktop/phone rendering pass; served web/APK bytes match the tested artifacts.
The upgrade backup is verified at the independent secondary location. No synthetic
records were added to the live household. Installation on physical phones remains
a user action; in-place installation and preservation were verified on the emulator.
