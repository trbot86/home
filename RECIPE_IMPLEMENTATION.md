# Recipes, cooking and recipe shopping groups

Implementation branch after the deployed Home release. Product requirements remain
in PLANNING.md and the connected schema in DATA_MODEL.md. Migrations 001–008 are
immutable. No recipe migration or live recipe data exists yet.

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
