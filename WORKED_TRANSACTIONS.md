# Household app — worked database transactions

Date: 2026-09-26. Status: proposed workflows for reviewing [the connected model](DATA_MODEL.md) and [architecture](ARCHITECTURE.md). IDs and dates below are illustrative. This is design, not a running application. SQL constraint checks are recorded separately in [the probe](design_checks/registry_constraints.py).

See [APPLICATION_CONTRACTS.md](APPLICATION_CONTRACTS.md) for typed command/outcome shapes and the subsequent refinements to rejection finality, no-op handling and redo links.

These workflows assume ordinary operation within one server recovery epoch. [RESTORE_RECONCILIATION.md](RESTORE_RECONCILIATION.md) adds the discontinuity case: resolve surviving receipts first, but require the current epoch before a new mutation can execute after restoring an older backup.

## 1. Shared write contract

An application command carries an operation ID, expected server recovery epoch, typed arguments and expected revisions for existing content. The server derives client/person from authentication and computes the canonical request digest. The client cannot supply a different actor to gain authority or undo someone else's work; an explicitly claimed performer remains distinct from authenticated actor attribution.

1. Do external preparation first: acquire/upload bytes, retrieve recipe metadata or call providers outside the content transaction.
2. Begin a short database write transaction. Look up `(client_id, operation_id)` before replaying a mutation. Matching digest returns the saved outcome; changed digest fails.
3. Load and validate permitted roots, expected revisions, typed relationships and domain predicates. Check protected media is ready where required.
4. Apply all domain changes. Each affected root advances once; changes in owned rows count as a root change. Ensure each new registry row has exactly its typed payload.
5. Append one changeset with logical old/new deltas and inverse dependencies, enqueue durable side effects, and save the operation receipt.
6. Commit. Only now report a saved result. Deliver notifications/export calendars afterwards from durable jobs.

Any failure before commit leaves none of this action's domain state/history/accepted receipt. A terminal rejection is arbitrated under the same write transaction, rolling back provisional domain changes to a savepoint before saving the rejection receipt if needed. If the whole transaction aborts, a fresh transaction first resolves any competing winner; the server must not announce terminal rejection before durably establishing it. Transient failures do not become terminal merely because the client timed out.

History payloads represent logical content, not SQL text. Example:

```json
{
  "payloadVersion": 1,
  "kind": "note",
  "fields": {"body": {"before": "Use matte paint", "after": "Use washable matte paint"}},
  "children": []
}
```

Adding ingredients or page blocks uses child IDs plus insert/update/retire deltas in the owning root's entry. Creation stores a complete non-binary baseline. A code-owned codec interprets each version, including after migrations. An inverse is proposed from this data, then checked by its feature module; it is not executed as arbitrary SQL.

## 2. Offline text and photo capture

**Starting state:** phone has no connection. You type “Check this leak” and take photo `M1`. No server record exists.

| Step | Phone state | Server state |
| --- | --- | --- |
| Edit | Mutable draft `D1`, local revision 3; durable camera copy of `M1` ready | None |
| Tap Save | Mark submission intent; keep editable until freeze wins the local revision check | None |
| Prepare submission | One local transaction freezes operation `O1`, intended inbox ID `I1`, text, media ID/digest/size and attachment ID `A1`; state becomes `SUBMITTED` | None |
| Upload | Retry the frozen media request, never rewrite the manifest | Upload metadata binds `M1` to client/scope and protects publication; bytes staged, verified and durably published |
| Finalise | Send the same capture command `O1` | One transaction creates `records(I1)`, `inbox_entries(I1)`, `attachments(A1 → I1/M1)`, changeset `C1` and receipt `(client, O1)`; commits with media protection/reference checks |
| Acknowledge | Local transaction records receipt/result; pending UI card maps to `I1`; draft bytes can become ordinary cache after confirmed acceptance | Content remains at `I1` |

Do not upload unfinished autosaved forms simply because connectivity returns. If a user edits while freeze races, either the edit commits first and is included, or the edit loses the local revision/state check and sees the submitted snapshot. A timeout never changes `SUBMITTED` back to editable.

**Lost response:** server committed `C1`, phone did not receive it. Phone replays `O1`; receipt returns `I1` with no second root, attachment or changeset. If your wife subsequently edited or deleted `I1`, receipt resolution still succeeds without restoring old content. Fetch current permitted state separately.

**Photo uploaded, SQL finalisation failed:** the ready file has no accepted live placement yet. It remains protected for a bounded retry window; later retry rechecks lifecycle/claims. If protection expired and GC claimed it, finalisation must wait for recovery/re-upload instead of attaching missing bytes. The immutable digest/ID still describe the requested photo. No accepted inbox item silently omits declared media.

**Local crash:** before freeze, recover draft; after freeze, retry exactly the frozen payload. Pending bytes cannot be evicted as ordinary cache. After server acceptance but before local acknowledgement, use the receipt path again.

**Class consequence:** `FormDraftStore` owns mutable fields, `CaptureSubmissionStore` owns frozen request/state, `CaptureUploader` transfers and resolves it. Server `CreateInboxEntry` composes Records, Media, History and receipts inside one coordinator transaction. None owns a general bidirectional sync engine.

## 3. Alternating note edits, time travel and personal undo

**Starting state:** shared note `N1`, revision 1, body “Matte paint.” Every save below checks the revision it loaded.

| Commit | Actor | Revision | New body |
| --- | --- | --- | --- |
| `C10` | You | 2 | Washable matte paint. |
| `C11` | Wife | 3 | Washable matte paint, warm white. |
| `C12` | You | 4 | Washable matte paint, warm white. Test a sample. |
| `C13` | Wife | 5 | Washable matte paint, warm white. Test two samples. |

These are four changesets, even if both editors stayed open. No long per-person session spans someone else's committed starting state. Each save writes the note, registry revision, delta and receipt together.

**Read version 3:** reconstruct from its creation baseline and deltas, or reverse deltas from current state. Show an explicitly historical read-only view. Copying text writes nothing; pasting it into the current editor uses a normal revision-checked save. Reconstruction includes both people's relevant changes even if the activity list is filtered to one person.

**You undo `C12`:** expected result of that action is revision 4, but current revision is 5. Reject without changes. Do not remove your text from your wife's edited paragraph using speculative semantic merging.

**Wife undoes `C13`:** revision 5 still matches, no dependency changed, so new action `C14` restores revision-4 content at **revision 6**, with `undo_of = C13`. Redo, if no intervening conflicting action, writes that content forward at revision 7 and records its relation to the original action/inverse. It does not reset the revision counter.

Even after her undo, your old `C12` remains conservatively blocked: revision 6 is not 4, although the text happens to match. Copying old text remains available. Unrelated shopping changes do not block this note's undo. Your later edit of the same note can block your earlier undo too; the rule concerns dependencies, not only which spouse edited.

For a multi-record action, validate all recorded revisions **and** feature predicates inside the inverse transaction. Revisions alone cannot detect every new inbound reference: another record might now depend on a record the undo would delete. Record those expected dependencies and explicitly check for new references where relevant. Do not undo a partial subset silently.

**Class consequence:** `GetRecordVersion` is read-only. `UndoAction` asks the owning feature handlers for a valid inverse and applies it through the same coordinator. Per-person undo eligibility is distinct from the global ordered history.

## 4. Recurring maintenance and two phones completing it

**Starting state:** asset `H1` is an air purifier. Task `T1` (“Replace filter”) has after-completion recurrence of 90 calendar days, maintenance extension for `H1`, and open occurrence `O20` at revision 4. The filter was bought on September 10 and actually installed on **September 20, 2026**. You record completion on September 26.

`CompleteTaskOccurrence(O20, expectedRevision=4, actualCompletedAt=Sep20)` performs one transaction:

1. Resolve receipt and validate occurrence, task/rule, actor scope and actual time.
2. Change `O20` from open to completed, revision 5.
3. Create completion `K20` with actual September 20 time and known performer, plus service record `S20` for asset `H1` linked to `K20`. Attach an already prepared service photo if supplied.
4. Create the next occurrence `O21`, target **December 19, 2026**, from September 20 + 90 days. Record the calculation inputs/rule version. September 26 recording time does not shift it.
5. Cancel outstanding operational reminder slots for `O20`; schedule slots/jobs for `O21` from enabled reminder definitions. This need not edit other people's private reminder definitions or reveal them in the shared completion changeset.
6. Save one changeset for the content roots, dependency guards and receipt. Do not revise the asset simply because another service record now references it.

**Same request retried:** resolve original receipt. **Wife's different command arrives afterwards:** if she simply requests completion of already-completed `O20`, return an explicit already-completed result without another completion/next occurrence. If her request carries a different claimed actual time/note, do not silently discard that data; return a conflict and provide an explicit correction operation. The partial unique indexes are final protections against two active completions or two open next occurrences.

**Correct actual time:** a dedicated `CorrectTaskCompletion` checks completion and dependent next occurrence. If `O21` has not been independently edited/completed and the rule is unchanged, update actual date, linked service record and computed target together. If someone has planned around/changed `O21`, reject automatic recalculation and explain the affected next occurrence; no semantic merge dialog is required.

**Undo completion:** guard `O20`, `K20`, `S20`, `O21`, the recurrence definition and relevant new references. Void/tombstone new completion/service/next occurrence, reopen `O20`, and update reminders atomically. A next occurrence already worked on blocks this inverse.

The September 10 purchase remains a separate purchase event throughout. Recording an old service receipt does not complete today's task unless explicitly requested.

For a fixed “every Monday” task, completing/reporting a stale September 14 occurrence on September 26 would propose September 28 next, retaining phase and coalescing missed slots. That catch-up rule is a reviewable product policy, not an accidental result of storing one date.

**Class consequence:** Tasks owns completion/recurrence; Maintenance contributes its typed service-log effect to the same transaction. One application use case composes them. Neither calls another module that starts and commits a nested transaction.

## 5. Recipe link to picture, notes, task and shopping

**Starting state:** wife pastes a URL into Recipes and selects Want to try.

1. `ImportRecipe` transaction creates recipe `R30` at revision 1, source URL/import request, collection membership and extraction job. It saves one receipt; the photo is not falsely marked ready.
2. Worker fetches metadata and stages image outside the write transaction. It creates a source snapshot/extraction result with expected recipe revision 1.
3. If revision still matches, `ApplyRecipeImport` creates/reconciles ingredient/step children, title/yield and image placement, advances `R30` once, and stores its own retry receipt. Actor is the worker, with a causal link to wife's request, not a fabricated second human edit.
4. If she added adjustment “Use half the sugar” first, revision changed. Retain the result for review instead of overwriting current content. Applying a reviewed import still leaves `recipe_adjustments` untouched.

Pressing “Let's make this soon” adds a view pin. It neither moves collection membership nor creates a fake due date. Moving Want to try → Favourites removes/adds memberships in one recipe edit, preserving the same `R30` and adjustments; multiple memberships are also supported.

**Cook Saturday and shop selected ingredients:** the compound action creates task `T30`, occurrence `O30` with a Saturday target, task-recipe link, and only the selected shopping entries. For each shopping source it stores recipe ID, ingredient ID, recipe revision and text/quantity snapshot. A composite FK rejects using an ingredient from another recipe.

Suppose “2 lemons” and “1 tsp cumin” are selected; salt is unchecked. Create those two entries, no salt. Do not automatically merge every similar text label. Where an explicit restock item already has a needed entry, reuse it and record additional provenance; change quantity only by a clear user decision or a supported exact-unit calculation.

Recipe edits later do not silently rewrite the shopping list's copied quantities. Reimported ingredients retire old IDs when needed, preserving prior provenance. Completing `O30` can additionally create a cooking record when requested, without turning temporary cooking notes into permanent adjustment notes automatically.

**Undo this compound action:** validate all created/changed task and shopping roots plus new purchase/dependency predicates. If someone already purchased the lemons, undo must not delete that purchase's source entry silently. An untouched action can be reversed as one changeset; otherwise reject and keep history available.

**Class consequence:** importer is an adapter that returns a validated recipe candidate. Recipes owns content and source snapshots; Tasks and Shopping expose typed operations within the caller's transaction. Shared orchestration does not transfer ownership of their rules into a giant recipe service.

## 6. Private gift planning

**Starting state:** shared suggestion `G40` says “A ceramic tea set would be lovely,” revision 2. Both see it.

You create private gift plan `P40` referencing `G40`, then private shopping entry `E40`. Later you purchase it and attach receipt photo `M40`.

| Changed | Scope | Shared consequence |
| --- | --- | --- |
| Plan `P40 → G40` | Your private scope | None; `G40` remains revision 2. |
| Private list and entry `E40` | Your private scope | No shared shopping count/activity changes. |
| Purchase and receipt placement/media | Your private scope | No shared thumbnail, source URL or purchase notification. |
| Personal reminder/pin | Your private scope | No shared task/suggestion revision bump. |

Foreign keys prove `G40` exists. Access checks permit your private source to refer to the shared target. There is no mutation on `G40` signalling that somebody acted on it. Shared suggestion queries cannot blindly aggregate all inbound links. A mixed changeset viewer must filter both entries and summaries; hidden content cannot survive in a shared actor/action label.

If your wife deletes the shared suggestion or undoes its creation, your private link does not block that operation or cause a revealing dependency error. It is a non-owning link that can point to a retained tombstone; your private plan continues with an unavailable-source indication. This differs from a same-scope purchased shopping entry whose business state deliberately prevents a destructive inverse.

A physical receipt containing groceries plus this gift stays private. The groceries can have a separate shared purchase record without that image. Sharing an explicitly redacted receipt creates a new shared media object; it does not relabel private bytes.

Your wife can see her own previously shared wish while being unable to infer the private plan through ordinary app views. This scope model concerns application users, not hiding database contents from an administrator who can inspect the host directly.

**Class consequence:** read projections, history, Media and notifications all use the same audience rules. UI hiding alone is insufficient; source ownership prevents private operations from causing observable shared edits.

## 7. Photo replacement, collection and restoration

**Starting state:** page `P50` revision 7 has attachment `A50 → M50`, physical generation 1. You replace its screenshot with `M51`.

1. Publish and protect `M51` outside the content transaction.
2. Transaction checks page revision 7, changes `A50.media_id` to `M51`, advances page to 8, journals old/new media IDs, and sets `M50` collection eligibility if no other live placement/protection remains. Caption and placement identity can stay unchanged.
3. For roughly 24 hours, history can display the old screenshot and recent undo can restore it if all normal guards pass. Eligibility is not a guarantee under pressure; history records that bytes may expire.
4. GC transaction rechecks liveness/protection and claims `(M50, generation 1, exact key)` as deleting. Actual unlink is outside SQL. A second transaction records the collected tombstone, leaving digest/provenance intact.

**Reattach before claim:** attachment wins the write transaction, clears eligibility, GC cannot claim it. **Reattach after claim:** attachment cannot become live yet; wait for deletion resolution and recover/upload bytes under a fresh physical generation. Never let a stale unlink target a reused path.

**Crash after file publish but before page commit:** the pending file is recoverable/protected, then eligible for cleanup when abandoned. **Crash after unlink but before collected mark:** repeat idempotent deletion of the claimed key and finish the tombstone. Neither case requires pretending SQL rolled back the filesystem.

Source URL is retained after collection. Fetching the same bytes/hash can recover the logical object with a new physical key. Changed bytes become a new object; a disappeared URL simply means unavailable media. Normal history/copy still works.

If undo requires missing bytes, do not silently claim full restoration or create a live reference to a collected object. Attempt explicit recovery when possible; otherwise report why that inverse cannot fully restore. A separate “restore text without unavailable photos” action can be designed later, leaving the loss explicit.

**Class consequence:** Media alone owns publication/claim/unlink state. History references logical media identities; it neither stores byte deltas nor directly deletes paths. Filesystem durability and crash recovery still need tests on the chosen runtime/filesystem.

## 8. Snooze, target changes and stale reminders

Shared occurrence `O60` targets Tuesday, with a true Friday deadline. Your reminder slot is due Monday evening, generation 3.

- “Snooze reminder one day” updates your slot/generation, leaving Tuesday/Friday unchanged.
- “Hide from my overview one week” updates `attention_snoozes`, leaving wife's view and scheduled dates unchanged.
- “Move target to Wednesday” is a shared occurrence edit with expected revision, changeset and receipt. Recompute affected reminder slots in the same transaction or enqueue uniquely versioned recalculation; a sender must recheck current target scheduling before delivery.
- “Change deadline” is an explicitly named edit, not an incidental effect of snooze.

A queued generation-3 notification is suppressed if generation is now 4 or target is complete/disabled/inaccessible. A provider may already have delivered a message before completion; the design promises rechecking before send, not retracting every external notification.

Notification scheduling is operational state. Completing a shared task can suppress both people's scheduled slots through server-owned scheduling logic without editing their private reminder definitions or adding their private settings to the shared changeset.

## 9. Deleting or archiving a project

Archive project `P70`: keep page/attachment references live and hide the project from ordinary active lists. No media GC follows merely from archiving.

Delete `P70`: explicitly collect its contained pages, validate revisions and scope, then tombstone project/pages and retire placements/blocks atomically. Links to shared task `T70` or recipe `R70` disappear with pages, but those external records remain. Set media eligibility only after checking other live placements. Changeset records every affected root so immediate undo can guard them all.

Restore verifies all affected revisions, no newly conflicting hierarchy, and required media availability. It uses new revisions, not old revision numbers. Moving a page checks the destination project and walks ancestors to reject a cycle; a self-FK alone cannot do that.

## 10. Design conclusions and remaining evidence

The registry helps precisely where history, attachments, pins and generic links need a durable target. It does not absorb ingredient, block, job or receipt identity. Composite FKs enforce payload kind; the coordinator supplies the missing complete-subtype invariant.

The most important reusable boundary is the **application action and its transaction**, rather than a base class shared by unrelated domain objects. Maintenance completion and recipe-to-shopping exercise composition across modules without splitting commits. Source-owned relationships keep private state out of shared revision/activity effects. Operational retry and delivery state stays separate from user-visible logical history while living in the same database.

Remaining checks before implementation: concrete command/result types, history codec evolution, deletion/undo predicate coverage, reminder invalidation rules, client cache projection format, and a runtime-specific durable file/backup plan. Stack selection follows those contracts; no framework or application scaffold has been created by this pass.

Follow-on status: representative command/results, codec examples, rejection semantics and cache reply ordering are now specified in [APPLICATION_CONTRACTS.md](APPLICATION_CONTRACTS.md). Runtime-specific schemas, implementation and integration tests remain future work.
