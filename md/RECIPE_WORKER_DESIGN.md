# Recipe import worker boundary

Implemented on the recipe feature branch after recipe storage 009. Migrations 010
and 011 add worker identities and durable import state; the deployed household
still uses schema 008. This document records the implemented boundaries.
It refines the existing import and attribution contract in
[APPLICATION_CONTRACTS.md](APPLICATION_CONTRACTS.md#7-importing-and-planning-a-recipe).

## Identity and authority

Add a distinct local worker principal and a `worker` client kind in a new migration.
Keep worker, integration and human actor columns mutually exclusive, with composite
client/actor foreign keys. Existing human/integration rows, canonical request
digests, receipts, commit sequence and wire encodings remain byte-for-byte intact.
The migration requires the same verified referenced-table rebuild procedure as 007;
007 and 009 themselves remain immutable.

A worker has no HTTP credential. Human and capture authentication continue to
accept only their existing client kinds. Keep `RequestContext` limited to those
external callers. A separate internal worker context must name its persisted job,
recipe, scope and lease; validate those facts against SQL inside each write
transaction. No general worker access to inbox, tasks, private queries or undo is
introduced. Alexa remains an integration with its existing capture-only permission.

`HistoryService` gains a separate worker entry point which uses the same delta
encoder and revision checks. It admits only the recipe import action, one expected
recipe root and the persisted causal changeset. Worker attribution is visible as
such, not attributed to whichever person originally requested the import. Recent
human undo can therefore be blocked by a completed automatic import, as already
specified in the history contract; history/copy and ordinary deletion remain
available. Do not silently collapse later worker changes into an earlier save.

## Persisted request, result and application

`ImportRecipe` creates an editable URL placeholder and its durable import job in
one content transaction. A narrow, synchronous post-history hook on a feature
mutation attaches the actual committed causal changeset before the coordinator
commits its receipt. Hook failure rolls back the whole action. This hook performs
SQL only; it must not schedule an unpersisted promise or perform network I/O.

The typed import row records the initiating human/client, recipe/scope, URL,
expected revision, recovery epoch, job ID and causal changeset. The shared job row
owns retry/run-after/lease state. One active import per recipe prevents redundant
work. Re-import or retry is an explicit new request with a new identity; a lost
reply retries the original request and does not enqueue a duplicate.

The worker claims work in a short transaction, then uses `RecipeSourceReader`
outside SQL. It persists a bounded, validated candidate snapshot and page digest,
not raw HTML. Once a result is frozen, application retries use those exact bytes
and stable child/media IDs. They never fetch a new page under an old operation ID.
Several candidates require review. Failure retains the URL card and a safe error
code; a metadata bookmark can still provide a useful title and source picture.

Automatic application rechecks the job, lease, epoch, principal, recipe deletion,
scope and expected revision. A changed recipe retains a reviewable result. A human
reviewed apply uses the current revision and a new human operation ID. Both paths
preserve household adjustments and memberships and apply only explicitly selected
source fields. Replacement source ingredients/steps receive new IDs; retired
identities remain reserved for shopping provenance and history.

The internal worker coordinator commits recipe changes, history, a worker receipt
and job disposition atomically. A surviving receipt wins on retry. There is no HTTP
route accepting worker context or a worker-selected arbitrary command. Keep common
receipt serialization helpers reusable without changing old digest inputs.

## Media, shutdown and restoration

Images use the same bounded public retrieval as pages, followed by actual-byte
validation and immutable file publication. A job-scoped media path binds staging
objects to that recipe and worker client. Shared media internals can be reused,
but human media APIs must continue to reject worker and integration contexts.
Only validated local attachment references reach household cards. Preserve the
source URI/digest in media provenance even after eventual garbage collection.

The worker stops claiming work on shutdown, aborts current network retrieval and
finishes or rolls back any synchronous transaction before the database closes.
Expired leases permit retry after a crash. Restore already pauses background jobs;
worker writes additionally require the original recovery epoch, so a restored
unfinished import cannot silently resume. A review/retry after recovery is a new
human action rather than rewriting a frozen operation.

## Required evidence before activation

- Upgrade an existing 009 fixture without changing old requests, receipts, actor
  relationships or historical versions; test SQL/FK failure rollback of the rebuild.
- Reject human/capture attempts to obtain worker authority, supply actor fields,
  operate on another job/recipe/scope, or use any non-import command.
- Exercise immediate placeholder save, failed fetch, ambiguous multiple recipes,
  interrupted retrieval, stable-result replay and a lost application acknowledgement.
- Race import with a partner edit, note addition, deletion, job cancellation and
  restore. Retain reviewable results and preserve current household content.
- Inject failure after source content/history/media-link changes but before receipt
  commit. Verify atomic rollback and safe later collection of unreferenced files.
- Back up and restore pending and completed imports, worker history and photos into
  an isolated destination. Verify paused work and both old/new receipt behavior.

Food screens, native read cache, durable forms, Soon pins, linked cooking tasks and
ingredient shopping groups remain required after this storage/worker work. No
partial source checkpoint is a substitute for that end-to-end feature.

## Implemented recovery behavior

Import commands atomically create/update the URL card, causal history, job grant
and human receipt. A five-minute lease guards one job, and each retrieval run has
a 90-second bound. Shutdown releases saved work; lease expiry permits recovery
after abrupt process death. Once metadata is saved, page retries do not fetch it
again. Once application IDs are frozen, retries do not fetch either page or images.
The internal receipt encoding is version 3 and includes the persisted epoch,
recipe revision, job identity and frozen application. Existing human/integration
encodings remain versions 1/2.

One unambiguous candidate can apply automatically to the original recipe revision.
Multiple candidates, conflicting edits and unavailable images during application
remain reviewable. A metadata-only bookmark refresh leaves existing ingredients
and directions intact. Selecting a replacement source photo preserves manual
household photos. Images have normal media ownership, protection and collection;
their source URI and digest survive collection. Review previews expose local media
references, never arbitrary remote image URLs.

Focused fixtures cover source/application replay, post-history queue failure,
partner edits, private previews, stale leases, cancellation during file publication,
commit failure, shutdown, ambiguous sources, bookmark refresh and backup/restore
of both attached and still-pending images. Migration fixtures retain all old column
values and frozen receipt bytes while testing SQL/FK rebuild rollback.
