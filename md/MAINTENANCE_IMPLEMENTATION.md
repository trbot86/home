# Maintenance records and reusable photo attachments

Implemented after the Tasks and reusable-attachment releases. Follow md/DATA_MODEL.md
and retain the existing live household. Migration008 adds Home; migration007 is
reserved for the integration actor model. Deployment status is in BUILD_PROGRESS.md.

## Usable result

Keep appliances, systems and rooms in a Home section, with name, model, optional
serial number, location, acquired date and notes. Archive old assets without
discarding their service history. A maintenance task remains an ordinary task,
with the same person/date/priority controls and after-completion recurrence.

Keep service details and receipt photos alongside actual completion. Allow a
historical service entry without completing today's task. Photos can come from
the camera, gallery or desktop file picker; unfinished work survives leaving
for the picker. Start with the existing JPEG/PNG/WebP pipeline. PDF/document
support is a separate addition, with its own validation and preview policy.

## Data and module boundaries

- `home_assets` is a registered root: name, model, serial, location, acquired
  civil date, notes and archive state. Same shared/private scope rules as tasks.
- `maintenance_plans` is a task-owned extension with a same-scope asset FK and
  reference/instructions. It shares the task's revision and history. Recurrence
  stays in Tasks; there is no second scheduling engine.
- `maintenance_records` is a registered root: asset, optional unique completion
  reference, actual service instant, notes and optional exact decimal cost plus
  currency. Avoid floating-point money and do not infer a currency silently.
- Photos use the existing `attachments` placements and `media_objects` bytes,
  with parent revisions/history and same-scope enforcement. A media object can
  have multiple placements. No file is deleted merely because one placement is
  removed. Existing media retention and backup protection remain authoritative.

The shared attachment repository owns placement validation, reads, writes and
retention bookkeeping. Keep record lifecycle rules in feature adapters. Expose attachment
support explicitly; do not make every registered kind silently editable through
a universal unvalidated patch API. Legacy history lacking attachment fields must
normalize safely, and retained command receipts must remain replayable unchanged.

Migration006 now makes display positions unique only among live placements,
preserving placement identity and old history. The reusable photo editor and
attachment repository are deployed; see ATTACHMENT_IMPLEMENTATION.md. The Home
slice can reuse them without another attachment-table migration.

## Client durability

Use the same acquisition/storage service for Inbox and record attachments. The
Android acquisition table already distinguishes Inbox and record drafts through
the tested attachment migration. Do not repurpose an ordinary Inbox draft
and accidentally display, upload or clean it as an Inbox capture.

Persist owner, target record, base revision, scope, epoch, captions/order and
local media references before opening a camera/gallery activity. Store original
bytes durably before acknowledging acquisition. Freeze an attachment update
before its first possible request and keep its media pinned until its receipt
has been reconciled. Replay the same immutable request after an uncertain reply.
An existing target still requires connectivity for submission; local unfinished
editing does not authorize delayed unguarded overwrites.

Reuse the current command-attempt/receipt coordinator rather than adding a second
commit protocol. Keep acquisition intent and upload preparation distinct from
server commit. Profile switching, process loss and restore epochs must preserve
the original owner and pending bytes. Removing an app photo leaves its original
camera/gallery source untouched.

## Worked actions and verification

1. Create an asset, then associate a task of the same scope. Reject cross-scope,
   unavailable and archived targets rather than silently copying private content.
2. Complete the linked task: completion, service record, next occurrence and
   their revisions/history commit atomically. Guard the relevant relationship
   as well as task/occurrence revisions. Undo reverses the entire action unless
   later relevant edits make it unsafe.
3. Add a historical service entry: it appears in the asset log without changing
   any open task or recurrence date. Attach a receipt photo through the shared
   placement workflow.
4. Remove a placement: retain historical descriptors, start collection grace only
   after the last live reference, and prevent restoring collected bytes by
   pretending their old path still exists. Text history remains readable.
5. Archive an asset: keep the service log and linked plans visible; do not silently
   cancel chores. Hard deletion stays guarded while active plans refer to it.

Test stale/competing writes, atomic rollback, actor versus performer, shared-media
retention, photo replacement/order, lost replies, private scope, migration from
the published schema, Android pending-media migration and camera cancellation.
Verify responsive UI, draft recovery and offline read access. Run only isolated
tests. Deploy through the backup-first upgrade, compare live records/identity,
publish the batched APK, and verify the independent secondary disk copy and isolated restore.

Both application listeners construct the same record-adapter registry through
`createRecordFeatures`, so an inbox capture still checks the integrity of Home
records. The capture listener registers no Home routes or commands. Home access
requires a human context at both the type and runtime boundaries.

Client caches treat Home as an additive section. Existing task command payloads
may omit the maintenance relation; their frozen digests do not change. Old task
editor buffers acquire only the new optional fields when loaded. Completing a
linked task creates its service row within the same receipt transaction. A linked
service cannot be independently deleted or have its completion instant changed;
undo the completion as one action. Later relevant edits reject that undo.

## Optional maintenance ideas

The deployed maintenance-ideas feature adds five source-backed starting points: heating
filter checks, dishwasher filters and spray arms, washer cleaning and refrigerator
seal inspection. Browse and filter them from an asset, then customize an ordinary
task before saving. Dates and recurrence start unset. A title already present on
that asset is indicated to avoid repeated clicks creating identical tasks; this
is a title check, not a claim to recognize every renamed equivalent.

No schema, scheduling engine or server command is added. Generic task templates
provide starting text to the existing durable editor. Each asset/template gets a
separate local draft key, so a manual draft or another idea is not overwritten.
Source guidance is copied into the task's editable maintenance reference; future
catalog edits do not alter saved tasks. Model manuals take precedence. Visibility,
actual-completion recurrence, service logs, receipts and guarded undo use the
existing task and maintenance boundaries.

Sources checked 2026-09-27:

- [US Department of Energy: heating filters](https://www.energy.gov/articles/5-tips-help-you-save-energy-bills-winter).
- [Bosch dishwasher maintenance](https://www.bosch-home.com/us/owner-support/dishwashers/cleaning-maintenance).
- [Whirlpool washer cleaning](https://www.whirlpool.com/blog/washers-and-dryers/clean-washing-machine.html).
- [Whirlpool refrigerator maintenance](https://producthelp.whirlpool.com/Refrigeration/Full-Size_Refrigerators/Product_Info/Cleaning_and_Care/Preventative_Maintenance_for_Refrigerators).

Typechecking, package boundaries and the production build pass. All 11 affected
Home, Tasks and Food browser flows pass, including separate drafts, private scope,
opt-in dates/recurrence, undo/redo, offline browsing and 320–1440 pixel layouts.
The image passes all 155 Linux package tests. Android builds, in-place update
preservation and native UI verification pass, including Back, Room draft recovery,
private asset scope and editable recurrence. The feature is published on the web
and in the private Android download. It needed no migration. Both profiles'
existing records and household identity were preserved; served artifacts match
the tested builds, and the fresh pre-release backup has a verified secondary copy.

Fixed-calendar recurrence, notification channels and calendar integration remain
separate slices.
