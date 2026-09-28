# Shopping and restocking implementation

This implemented feature slice follows md/DATA_MODEL.md and PLANNING.md. Keep existing server
records read-only offline; local inbox capture remains available while disconnected.
Do not reopen this decision as a new offline editing protocol.

## User-visible outcome

- Named shared or private lists, with purposes groceries, household, wants and gifts.
- Fast item entry with freeform quantity, notes, edit/delete and a large purchase checkbox.
- Needed and purchased views, search, stable ordering and explicit pending state.
- Reusable restock products with name, model/size, product link and default quantity.
  Need this returns the existing needed item or creates a fresh one after purchase.
- Purchase history records who bought an item and when; buying does not reset a
  maintenance or replacement date. Quantities are never silently combined.
- Per-user revision-guarded history/undo, privacy and eventual receipt resolution
  apply to every write, including compound purchase actions.

## Sequence

Steps1–5 are implemented and deployed (2026-09-26 Toronto time). Migration004
adds concrete shopping tables and constraints. Static record adapters preserve
inbox version1 history and support atomic purchase undo/redo. The cache endpoint
remains compatible with older installed phones. Browser IndexedDB and Android
Room retain shopping snapshots and editor buffers without a second queue.

Verification: 33 server tests pass on Windows and Linux, seven browser flows pass,
and five Android unit tests pass. The AOSP35 emulator passes native shopping,
history, purchase undo and editor recovery. Explicit dialog priority in the native
Back dispatcher prevents a dialog dismissal from also returning to Inbox.

Deployment preserved all six pre-existing visible inbox entries and the installation
ID/epoch. A verified pre-upgrade export preceded migration004; the post-upgrade
412,188-byte export `<local-run-id>` was verified on the secondary disk and
restored into a fresh isolated directory. No synthetic shopping records were added
to the live household. Updated web assets and the published APK match local bytes.

1. Generalise the existing history adapter boundary without changing old inbox
   delta encodings. Add atomic multi-record changesets and reversal guards; prove
   old inbox history, privacy and uncertain-request behavior still work.
2. Add an additive server migration for shopping lists, restock items, shopping
   entries, purchases and purchase lines. Use concrete typed tables and equal-scope
   containment; retain the registry's composite kind constraints.
3. Implement commands and one consistent authorised cache snapshot. Keep the old
   inbox endpoint/request shapes supported while old phone versions are installed.
4. Add modular responsive Shopping views and cached read access in both adapters.
   Reuse durable online attempts; do not create another queue or persistence owner.
5. Test simultaneous check-offs, duplicate Need this, stale edits/undo, lost replies,
   private lists and cache isolation, and phone layout. Upgrade with a verified
   backup, preserve real data, publish the Android update and verify the second copy.

Receipt-photo editing and product reference photos are deployed;
see [shopping photos](SHOPPING_PHOTOS_IMPLEMENTATION.md) for verification and limits.
Recipe ingredient import and named groups are deployed; see RECIPE_IMPLEMENTATION.md.
Advanced gift suggestions, inventory quantities and automatic reminders remain later scope.
No provider credentials or new household decisions are needed for this slice.
