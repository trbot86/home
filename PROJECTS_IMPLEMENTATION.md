# Projects and mixed-media pages

This feature follows the deployed Food release. Live migrations 001–014 and the
existing household volume remain unchanged during development.

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

Progress: the storage/API foundation is implemented on the Projects branch.
Ten isolated project tests cover hierarchy, mixed-media history, weak-link privacy,
compound moves/deletions, receipt replay, failed commits, the 014 upgrade and a
backup restoration with actual image bytes. Existing automated tests, typechecking,
package boundaries and production builds pass. The user-facing boards and native
cache integration are still pending; this foundation has not been deployed live.

Project next-action views now extend the same preference service as Food pins.
Their context, scope and order are separate from record revisions/history. Private
projects may pin shared records; shared projects cannot pin private records. The
016 migration preserves existing Food rows and receipts and checks foreign keys
after its table rebuild. Isolated tests cover stale ordering, failed receipts,
target deletion/restoration, private-view isolation, old frozen commands, backup
restoration and rollback after SQL or foreign-key failure during the rebuild.
