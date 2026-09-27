# Maintenance records and reusable photo attachments

Next slice after the deployed Tasks release. Follow DATA_MODEL.md and retain the
existing live household. Migrations001–005 are published and immutable. No
additional household input is needed to implement the bounded work below.

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

Extract the repeated placement validation/read/write/retention bookkeeping from
Inbox into a concrete shared attachment repository before using it in another
feature. Keep record lifecycle rules in feature adapters. Expose attachment
support explicitly; do not make every registered kind silently editable through
a universal unvalidated patch API. Legacy history lacking attachment fields must
normalize safely, and retained command receipts must remain replayable unchanged.

The deployed placement table has `UNIQUE(record_id,position)`, including removed
rows. Replacement/reordering therefore needs an explicit migration or ordered
write strategy; simply tombstoning a placement and reusing its position is wrong.
Preserve attachment identity and old history when resolving this constraint.

## Client durability

Use the same acquisition/storage service for Inbox and record attachments. The
current Android acquisition table points at an Inbox draft, so generalization
must be explicit and migration-tested. Do not repurpose an ordinary Inbox draft
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
publish the batched APK, and verify the independent the secondary disk copy and isolated restore.

Suggested maintenance templates follow once the storage workflow is usable.
Keep suggestions optional, state their basis, and research any proposed service
interval against relevant manufacturer guidance. Fixed-calendar recurrence,
notification channels, calendar integration and recipes remain separate slices.
