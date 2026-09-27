# Recipes, cooking and recipe shopping groups

Implementation branch after the deployed Home release. Product requirements remain
in PLANNING.md and the connected schema in DATA_MODEL.md. Committed migrations are
immutable, including recipe migrations on this feature branch. The live household
still uses 001–008; no recipe migration has been deployed.

## Intended workflow

Save a pasted link immediately into Want to try. Enrichment runs as a durable job;
failure leaves a useful, editable link card. Show the actual source picture when
available, source attribution, servings, times, ingredients and ordered directions.
Several recipes on one page require selection. No inferred amounts or generated
dish photographs. Manual recipes, pasted text and household photos remain available.

Want to try and Favourites use memberships; moving removes/adds membership in one
action. Storage permits both memberships without forcing it in the ordinary move
flow. Soon is an independent, undated view pin. Adjustment notes and cooking notes
have separate owners, and cooking does not silently favourite a recipe.

Planning a recipe creates a linked ordinary task with existing assignee, priority,
target/review/deadline and snooze controls. Actual completion can create a cooking
record atomically. Manual past cooking must not complete today's task. Selected
ingredients become an explicitly named shopping group, collapsed by default, with
links to the recipe and immutable ingredient/quantity snapshots. Saving or pinning
alone adds no groceries. Existing household quantities are never guessed or summed.

## Boundaries and durability

- PublicWebFetcher retrieves only public HTTP(S) pages/images, pins validated DNS
  to each connection, validates every redirect and bounds time, headers, wire bytes
  and decompressed bytes. It sends no household credentials/cookies. Parsing never
  executes page scripts or fetches JSON-LD contexts.
- RecipeExtractor returns validated candidates from JSON-LD or microdata, then
  Open Graph/title fallback. Source data and warnings are explicit. It cannot write
  household records or call a model. Optional LLM extraction remains a later adapter
  with explicit configuration; no household data is exported automatically.
- Recipes owns current content, stable ingredient/step identities, household
  adjustments, memberships and immutable import results. Retired ingredient IDs
  remain available to shopping provenance. Generic attachments store saved pictures.
- Import jobs persist the initiating client, expected recipe revision, scope,
  source URL, server epoch and causal changeset. Fetching/staging occurs outside SQL.
  Applying against a changed recipe retains a reviewable result; household notes
  are preserved even when the user deliberately applies a reviewed import.
- Automatic application requires an explicit local worker actor and a restricted
  internal command path. Do not impersonate the requester or grant Alexa more
  commands. Workers have no HTTP credentials; worker authority must be tied to the
  persisted import job. Keep old human/integration digests and actor wire formats
  unchanged. Design and test this extension before adding background content writes.
- Import application, history and the worker receipt commit together. A crashed
  worker retries the same result/operation, not a newly fetched replacement under
  the old operation ID. Restoration pauses unfinished jobs for reconciliation.
- Task links, cooking records and shopping source rows follow same-scope typed FKs.
  Compound actions compose repository effects inside one coordinator transaction;
  later purchases or partner edits can reject undo.

## Verification and release sequence

1. Implement and test bounded retrieval and pure metadata extraction with synthetic
   pages, malformed input, multiple recipes, relative images, redirects, DNS changes,
   compressed size limits and cancellation. Check a public page without publishing
   retrieved content or creating household records.
2. Implement typed recipes/collections/adjustments/cooking storage and migration,
   history, source-owned links, worker identity and durable import jobs. Prove old
   receipts and queued phone writes remain unchanged; exercise import-after-edit,
   retry, rollback, deletion, private scopes, media retention and isolated restoration.
3. Add responsive visual Food screens, durable forms, metadata review, photo editor,
   source links, linked tasks and ingredient-selection shopping groups. Keep controls
   keyboard accessible, Ctrl+Enter consistent, and offline cached reading available.
4. Test web and native Android, including update preservation, acquire/cancel photos,
   interrupted import/application and cross-profile isolation. Then use the existing
   verified-backup upgrade and compare live identity and retained records. Publish
   one tested APK for the complete slice.

Metadata references checked 2026-09-27:
[Schema.org Recipe](https://schema.org/Recipe),
[Google recipe guidance](https://developers.google.com/search/docs/appearance/structured-data/recipe),
[parse5 parser](https://parse5.js.org/functions/parse5.parse.html),
[Node HTTP request options](https://nodejs.org/api/http.html#httprequesturl-options-callback).
These establish formats/APIs; they do not guarantee any recipe site's coverage.

## Foundation checkpoint (2026-09-27)

Implemented public retrieval, charset decoding and pure recipe extraction. This is
source code on the recipe feature branch; it does not expose an import route, run
background jobs, create database records, or change the deployed household app.

The focused tests cover JSON-LD graphs/references, microdata and itemref, multiple
recipes, stable candidate IDs, exact ingredient text, section order, bookmark
fallback, malformed and excessive metadata, encodings and cancellation. Network
fixtures additionally exercise all-answer DNS validation, address pinning,
revalidation after redirects, downgrade rejection, response truncation, and wire
and decompressed limits. These fixtures use temporary loopback listeners only.

A read-only public-page probe successfully extracted one JSON-LD recipe with six
ingredients, five steps and one JPEG image. Its report stays in ignored local
storage; no scraped recipe content or image bytes are committed. One successful
page is evidence for this import path, not a promise about all recipe websites.

`RecipeSourceReader` keeps the final source URL and a source-byte digest, and returns
validated candidates for the future job to persist. It does not save raw HTML or
fetch images automatically. Image URLs remain untrusted candidates: the future
media stage must fetch through `PublicWebFetcher`, validate actual file bytes, and
attach a locally stored image under the recipe's scope. Never render arbitrary
external image URLs directly in household cards.

Character decoding uses the pinned `html-encoding-sniffer` package plus Node's
strict decoder. Published version 6 supports HTML metadata, BOM and transport
headers; a bounded adapter handles XML declarations. Undeclared HTML defaults to
UTF-8; malformed bytes fail for manual follow-up instead of introducing replacement
characters into ingredient amounts. The current upstream README describes some
unreleased behavior, so package-source inspection and fixtures govern this adapter.

## Storage checkpoint (2026-09-27)

Migration 009 adds recipes, stable ingredient/step rows, separate household
adjustments, collections/memberships and cooking records. Commands use the existing
transaction/receipt/history coordinator. The shared registry includes recipe
adapters in both server entry points, while the capture listener retains only its
plain inbox command. The authorised cache response includes recipe projections.

Want to try/Favourites are created on an explicit household action, not seeded into
live data by a migration. Moving a recipe changes its memberships in one transaction;
notes and recipe identity remain. An empty built-in collection can be undone with
the creating action and subsequently restored by the ensure command. Direct deletion
of built-ins is unavailable. Custom collections must be empty of live recipes before
deletion. Recipes with live cooking records can be archived; deleting them first
requires resolving those records. Removed ingredient/step IDs stay reserved to their
recipe for provenance and undo.

The focused checks exercise migration preservation, lost replies, rollback after
injected commit failure, private scopes, partner-edit undo guards, retired child
ownership, collection moves, manual cooking and real HTTP/media paths. A backup
restore fixture recovers source text, adjustments, membership, history and exact
photo bytes after those bytes have been collected from its isolated original.

Task/cooking integration and ingredient shopping groups/provenance remain required
before release. Later checkpoints below cover the import worker, Food screens,
Soon pins and native cache/forms. There is no deployed recipe feature yet.

The import worker boundary is specified in
[Recipe worker design](RECIPE_WORKER_DESIGN.md). Existing application contracts
already allow an attributed worker change to block a stale human undo; no implicit
human impersonation or causal undo grouping is needed for this first importer.

## Import checkpoint (2026-09-27)

Migrations 010/011 add a credential-free worker actor, immutable job authority and
persisted source/application state. URL saves enqueue work in the same transaction
as their history and receipt. Background retrieval uses the bounded public fetcher;
source pictures go through the existing media publication/collection subsystem.
One recipe applies automatically only while its original revision still matches.
Multiple candidates and changed recipes retain a reviewable snapshot. Human review
can select source fields without replacing household adjustments or memberships.

The worker preserves exact result bytes and generated child/photo identities across
restarts. Content, attachment placement, worker history, outcome receipt and job
completion commit together. Backups restore completed imports and exact photo bytes;
unfinished jobs remain paused under the new recovery epoch. No worker can obtain
HTTP credentials, ordinary household access or Alexa capture authority.

The main server starts the worker; constructing a test app does not start network
work. These are source changes only until the complete Food slice is verified and
deployed using the existing backup-protected upgrade path.

## Food client checkpoint (2026-09-27)

The dark-green Food view now has picture cards, search, shared/private filtering,
Want to try/Favourites moves, an independent Make soon view, archive/removal and
guarded history. A pasted link is saved before background retrieval; duplicate links
offer the existing card. Ambiguous imports offer a candidate and field selection,
with local source-picture previews. Recipe text, household adjustments, cooking
notes and photo editing use the existing durable editor and command paths. Parsed
times are shown in everyday units while their original source text is retained.

Migration 012 stores scoped view pins separately from recipe content. Pin commands
have their own revision and receipt, and do not change recipe revisions or content
undo history. Pins survive recipe edits and collection moves. Client snapshots cache
recipes, import summaries and view pins in the existing IndexedDB/Room JSON values;
old caches default these additions to empty without replacing saved records or drafts.

The full browser suite passed 23 flows, including three Food flows covering photos,
adjustments, cooking dates, collection moves, Soon pins, Ctrl+Enter, undo/redo,
private profiles, lost replies, unfinished forms and offline reading. Screens were
checked at 320, 390, 820 and 1440 pixels. A real public recipe URL also completed the
full save/fetch/image/apply/display path in a disposable household, with six
ingredients, five steps and a source photograph. This checks one site and recipe,
not universal importer coverage. Retrieved content and screenshots remain local.

Android built with ten passing unit tests. Installing over the previous APK on the
isolated emulator preserved its session, cached sections, unfinished photo capture
and editor text. Native Food checks then exercised Back/form recovery, photo upload,
partner photo download, adjustments, cooking notes, pins, import review, historical
images and Room/photo reading after the test server stopped. The reusable camera
and gallery picker was previously verified with the Home photo editor; this pass
checks recipe attachment transfer and display using a synthetic image.

At this checkpoint the Windows server suite had 112 passes and one Unix-socket test skipped;
the contract and voice packages add five and fourteen passes. Type checking, package
boundaries and the web/Android builds pass. These changes remain on the development
branch. Custom collection management, linked cooking tasks, ingredient shopping
groups and the final backup/upgrade/deployment checks remain before Food release.

## Cooking task checkpoint (2026-09-27)

Migration 013 adds a same-scope task-owned recipe link. The initial cooking task
refers to one recipe, and a task chooses either a cooking or maintenance completion
plan. Recipes retain their own revision: creating, postponing or completing a task
does not rewrite its recipe or change collections and pins. Archiving keeps existing
plans; a recipe with retained cooking tasks or meal records cannot be deleted.

Completion creates the task completion, cooking record and optional next occurrence
in one transaction, with one changeset and receipt. The actual date and performer
are fixed by the completion; meal notes/photos remain editable. Undo/redo covers the
whole action and refuses reversal after conflicting edits to the meal, task or next
occurrence. Manual past cooking does not check off a task. Old task command bytes
and receipts are unchanged; the optional cooking field defaults to null in retained
history, and old editor buffers acquire an empty recipe selection when reopened.

Food exposes Create a to-do, plan editing, actual completion, task history and the
same date picker/postponement component used by Tasks. Task cards link back to the
recipe. The browser workflow checks draft recovery, assignment, postponement without
moving a real deadline, monthly recurrence from actual completion and compound
undo/redo. The server checks replay, rollback, privacy, foreign keys, archive/delete
dependencies and partner-edit guards. Current Linux checks pass 116 server tests,
five contract tests and fourteen voice-package tests; Windows skips only the Unix
socket test. Ingredient shopping groups and release verification remain outstanding.

The Android emulator also passed linked task creation, recipe navigation, actual-date
monthly recurrence and compound undo/redo alongside the existing native Food checks.
Its APK build and ten unit tests pass. The eight affected Food, Tasks and Home browser
flows pass; final release checks will cover the complete client again after shopping
groups are connected. No cooking-task tests use the live household database.

## Ingredient shopping checkpoint (2026-09-27)

Migration 014 adds named shopping groups, entry-owned memberships and immutable
recipe source snapshots. Recipe and list revisions guard the ingredient checklist;
one command creates its group, selected entries, sources, changeset and receipt.
Each selected ingredient explicitly creates a new item. No quantity parsing,
scaling, pantry assumptions or label-based merging occur. Original ingredient text,
recipe title/version and shopping quantity survive later recipe edits or deletion.
Long ingredients require an explicit short shopping label and retain their full text.

Shopping groups start collapsed and show the relevant item count. Search opens
matching groups; large groups paginate their contents. Groups can be renamed,
removed while keeping their items, or restored. Removal validates the complete
current member set and revisions before ungrouping anything. Compound undo/redo
checks every affected record; a partner purchase or edit prevents an old reversal.
Membership moves belong to entries and do not revise recipe or group content.
Typed composite foreign keys enforce matching list and visibility scope.

The Food checklist saves unfinished selections and generated IDs on the device,
recognizes an acknowledged group after a lost response, and preserves frozen
requests. Browser and native caches default pre-group shopping snapshots to an
empty group array. Cached recipe links and groups remain readable offline.

Verification: all 27 browser flows pass, including widths 320/390/820/1440,
draft/retry recovery, partner purchases and group deletion/undo. Linux Docker
passes 120 server, five contract and fourteen voice-package tests; Windows skips
only the Unix socket test. An upgrade from the retained 006 fixture preserves all
golden rows, identity and requests; backup/restore retains group/source rows and
receipts and still permits compound undo. The in-place emulator APK update keeps
its prior session, all cached sections, photo capture and unfinished editor buffer.
The native workflow also passes checklist draft recovery, group creation and
compound undo/redo, recipe navigation, shared profile reads and offline Room/photo
cache checks. All ten Android unit tests pass.

This remains branch development. Migrations 009–014 and this APK have not been
deployed to the live household. Deeper collection controls and final live backup,
upgrade rehearsal, release and artifact verification remain separate work.
