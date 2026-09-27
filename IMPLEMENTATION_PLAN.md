# Household app — first implementation slice

Date: 2026-09-26. Status: **first slice implemented and locally verified; actual-phone and household-host review next**, following [stack selection](STACK_SELECTION.md). This document preserves the build sequence; [BUILD_PROGRESS.md](BUILD_PROGRESS.md) records completed evidence and remaining limits, and [README.md](README.md) gives run instructions. The first slice proves the shared foundations using real text-plus-photo inbox capture on desktop and Android.

## 1. Bounded outcome

Two distinct people can sign in on their own clients, create shared/private inbox entries, attach a camera/gallery/file photo, edit/delete online, inspect a previous version and perform a safe recent undo/redo. An Android capture survives process loss and network interruption, retries without duplication and reconciles to current authorised server state. Settings reports dated phone/server storage usage. A restored backup opens accepted records and their referenced files.

The minimum native quick-capture entrance also exercises final speech recognition and readback when the actual phone supports them; text/camera capture does not depend on speech availability. A widget/shortcut can launch that entrance. Lock-screen and physical-button behaviour are optional capability experiments, not a requirement to weaken the phone lock or a blocker for ordinary capture.

This slice does not build every household feature. The model already preserves their identities and relationships; Tasks/Shopping/Recipes follow after the capture foundation passes. No Alexa account configuration, calendar write access, LLM provider setup or e-ink hardware purchase is required to establish this slice.

## 2. Planned repository structure

Create only the packages needed by the slice; later feature folders appear when implemented.

```text
apps/
  server/
    src/
      bootstrap/             configuration, dependency assembly, startup
      transport/             Fastify routes, authentication, response projection
      application/           WriteCoordinator, ActionContext, cross-feature handlers
      features/
        access/              clients, people, permissions and sessions
        inbox/               domain rules, handlers, SQL repository, history codec
        records/             registry and changed-root tracking
        history/             reconstruction and inverse orchestration
        media/               placements, publication and collection
      infrastructure/        SQLite connection/migrations, file store, clock, jobs
    migrations/              numbered SQL, immutable after release
  web/
    src/
      routes/                inbox, editor, history, settings
      features/inbox/        responsive feature screens
      ui/                    shared controls, visual tokens, accessibility
      platform/browser/      IndexedDB and same-origin HTTP adapter
      platform/android/      typed Capacitor bridge adapter
  android/
    app/                     Capacitor host, quick-capture activity, widget/shortcut
    client-core/             Kotlin draft/submission/cache/media/network logic
    contracts/               generated or fixture-checked wire DTOs
packages/
  contracts/                 app-owned JSON Schema/TypeBox definitions and fixtures
  client/                    React-free ports, presentation models, adapter conformance
design/                      reusable visual tokens, interaction specifications
ops/                         eventual image/Compose files and backup/restore scripts
```

These are candidate directories, not one required class per folder or a framework of empty interfaces. Keep domain/application/repository code together inside each feature initially. Small capability modules can remain directories within one server package until a build boundary is useful.

Dependency rules:

- Contracts contain wire types/schemas and portable fixtures, with no database, UI or server imports.
- Domain rules use explicit values and supplied time; no HTTP, files or provider SDKs.
- Repositories and media adapters implement application capabilities. Only the coordinator opens the content write transaction.
- Shared web UI depends on `ClientPlatform` ports. Browser/Android adapters implement them; Android UI never opens Room through a second JavaScript SQL driver.
- Kotlin client core has no dependence on the React host. Native capture and background upload must work while that host is absent.
- Server module composition happens through internal typed methods in the same action context, not nested public HTTP commands.

Enforce these through compiler/package visibility and a small import-boundary check once code exists. Do not use architectural naming as a substitute for enforcement.

## 3. Initial schema and schema evolution

Implement these connected subsets first:

| Store | Initial tables/families | Why now |
| --- | --- | --- |
| Host identity | People, clients/credentials, scopes, installation settings | Two-person privacy and durable caller identity are prerequisites. |
| Host content | Records, inbox entries, attachment placements | First real feature and shared registry/ownership contract. |
| Host history | Changesets, record changes/dependencies, operation receipts | Every first user write already has history and retry semantics. |
| Host media/work | Media objects/uploads/variants, necessary jobs | Photo publication/recovery and bounded collection. |
| Android local | Drafts, draft media/acquisition requests, frozen submissions, in-flight online attempts, authorised cache, storage samples | No second independent editing source or unprotected pending bytes. |
| Browser local | Equivalent supported drafts and in-flight state in IndexedDB | Recoverable desktop forms; no claim of an always-running browser uploader. |

Leave Tasks/Shopping/Recipes and other table families uncreated until their feature slice. This is incremental execution of one coherent model, rather than independent schema invention. Keep explicit migrations; never auto-sync a production schema from current entity declarations.

Server migrations have ordered versions/checksums, a pre-upgrade backup and a verified schema-version gate. Do not edit an already released migration. Restore a compatible backup/image if rollback is needed rather than assume every destructive migration has a lossless inverse. Android Room migrations preserve pending captures and frozen request bytes; destructive migration fallback is forbidden for this store. New app versions must read or migrate old draft formats and still replay supported old command formats.

A conformance fixture set covers creation, empty versus absent fields, date-only versus instant, private scope, terminal rejection and missing media. Server and Kotlin decoders must agree on these fixtures. Physical SQLite schemas differ between host and phone; only authorised projections and application contracts cross the network.

## 4. Build sequence and exit conditions

### Step A — toolchain, wire contract and lifecycle proof

Pin mutually compatible Node LTS, Fastify, TypeBox, SQLite driver, React/Vite, Capacitor, Android Gradle/Kotlin and Room versions. Use lockfiles and the Gradle wrapper. Confirm the supported Android API floor against the two phones; do not infer the wife's version from “Android.”

Create the smallest bridge proof with synthetic data: a native draft saved to Room, a shared screen reading/editing it, and a worker reading the same frozen request after the web view is gone. Exercise an external camera activity's interrupted return. Verify contract generation or the small fixture-checked DTO fallback.

**Exit:** no two Android writers/migration owners, no JavaScript process requirement for durable upload, no broken null/date/request semantics. If the hybrid presentation or bridge fails this bounded check, switch Android UI to native Compose before implementing household screens; retain the native core and server contracts.

### Step B — server action boundary and authentication

Build the actual registry/inbox/receipt/history transaction with typed SQL repositories. Centralise manual transaction/savepoint control. Content handlers are synchronous and cannot await network/file work. Validate every newly registered root's payload; record one revision/delta per affected root.

Establish two real identities and revocable per-client credentials before testing private content. Working onboarding proposal: local bootstrap creates the household and two accounts, then each person's login establishes their browser session or device credential. Use maintained password/session primitives, not custom cryptography; concrete authentication-library/configuration choices are resolved during this step. Browser tokens use protected cookies and CSRF/origin checks; Android stores its device secret natively. Do not ship development identity headers or a universal shared login as the privacy implementation.

Keep client identity stable across credential rotation. Shared integrations and any future restricted lock-screen capture get separate least-capability clients; they cannot name another person's actor identity. Bootstrap/recovery is an operator action, while ordinary app use has no server-admin menus.

**Exit:** real two-person access tests; same operation returns one result; changed payload under one key fails; invalid well-formed commands get durable rejection receipts; injected transaction failure leaves no partial content/history/receipt.

### Step C — durable media and text-plus-photo creation

Persist acquisition intent before launching camera/gallery; copy acquired bytes into protected app-owned storage. Compute/record the immutable media identity/digest once. On the server, stage/verify/publish with protection before accepting the attachment transaction. Path generation and generation-based collection stay in Media.

A lost upload result resolves the same upload; a lost capture result resolves the same operation. Failure cannot silently downgrade photo capture into text-only success. Exercise empty-text photo-only capture and removal/replacement before submission.

**Exit:** interrupted acquisition is explicit; accepted media bytes exist; native pending media survives restart/ordinary cache cleanup; crash recovery distinguishes staged/ready/live/collected objects. No live-generation deletion under a stale GC claim.

### Step D — responsive inbox, editing and history

Implement list grouping/paging from the outset, one visible pending/synced card per capture, explicit edit/delete controls and a consistent details/history surface. Respect private/shared context in titles, counts and previews. Ctrl+Enter calls the active form's normal submit path, with duplicate gestures sharing one intent. Enter remains a newline.

Browser draft recovery and Android native draft recovery use the same screen state model but platform-specific stores. Existing records remain read-only offline. After uncertain submission, resolve creation and load current revision before editing. Historical views remain read-only and support copying old text; recent Undo/Redo use the application contract.

**Exit:** two-person alternating edits reject stale writes; undo/redo advances revisions; deleted entries do not return after replay; no private values appear in another person's lists/history/media responses. Storage Settings shows measured times and separate database/media figures.

### Step E — native quick capture and shared-view freshness

Add the small Kotlin quick-capture activity using the same native core. Persist the final recognised transcript, then speak back whether it was saved locally/pending or confirmed on the server. Provide smooth edit/re-record/continue options when recognition ends early. If offline recognition is unavailable, text/photo capture still works and no false “saved transcript” is announced.

A widget/shortcut launches this activity; native UI must not expose the full private cache when used as a restricted lock-screen experiment. Test permitted launch/microphone behaviour on the actual household phones instead of asserting model-specific button integration. Ordinary unlocked capture is the baseline.

Add foreground invalidation/refetch with resume/periodic repair. Pending acknowledgements and cache refreshes share the local ordering guard so old responses cannot regress current state. No promise of precise background widget updates or cloud push delivery is made by this slice.

**Exit:** capture entry works without opening the full app, worker resolves pending upload without the web view, readback distinguishes pending/synced, and foreground clients converge after missed invalidations.

### Step F — container, migration and restore rehearsal

Package the same server entry point plus web assets in a non-privileged application image. Mount the app-owned data volume with distinct DB/media paths and a separate dedicated backup-output directory; no Docker socket or broad host mount. On the proposed Windows host, use the Linux-backed named volume and app-created online exports in [WINDOWS_DEPLOYMENT.md](WINDOWS_DEPLOYMENT.md). Use direct development/test commands by default. Pin an appropriate image/runtime and test the actual target CPU architecture/native SQLite module combination.

Run container replacement with existing data, schema upgrade from a prior fixture, and restore into an isolated directory. Prove the restored app can read accepted inbox text/history/receipts and open its images, while pending client submissions can still reconcile safely.

**Exit:** validated deployment/restore on the chosen host/filesystem. A passing in-memory SQL probe or emulator test does not substitute for this gate.

## 5. Focused verification matrix

| Scenario | Evidence required |
| --- | --- |
| Duplicate Save / Ctrl+Enter | One local submission intent, one server record and changeset. |
| Process loss before/after freeze | Recover mutable draft before; retry identical frozen request after. |
| Native worker without web UI | Queue drains/resolves with no React runtime. |
| Server commits, response lost | Receipt resolves original identity; later edit/delete stays intact. |
| Terminal rejection races a retry | One final receipt wins; no rejected operation later mutates content. |
| Validation rejects typed arguments | Valid envelope gets a durable rejected outcome, not an unrecoverable framework-only 400. |
| Interleaved edits and reversal | Stale edits/inverses rejected; unrelated records do not block; revisions rise on undo/redo. |
| Private/shared scopes | Direct IDs, media, counts, history and receipt projection all obey access rules. |
| Cache response ordering | A stale refresh/replay cannot overwrite a later confirmed state; pending captures remain. |
| Filesystem interruption | Publication/GC claims recover, live files survive and unavailable historical bytes are explicit. |
| Upgrade with pending queue | Old frozen request still resolves; media and draft formats remain readable. |
| Backup restore | Database and live referenced media agree; copied files are usable in the running restored app. |
| Online backup and concurrent work | Snapshot-derived manifest stays complete during edits/uploads/deletes; all physical collection paths respect the hold, failed runs release it safely, and partial exports are never accepted. |

Use real SQLite/temp directories for transaction/file tests, a fault-injecting transport for dropped replies, browser automation for forms/layout/keyboard and native instrumentation/emulator/device checks for process/camera/worker behaviour. Unit tests alone cannot prove Android lifecycle or filesystem durability. Reuse the existing [constraint probe](design_checks/registry_constraints.py) as design evidence, not as a substitute for runtime tests.

## 6. Operations and backup proposal

Following the user's review, routine backups use online SQLite snapshots plus immutable media copies while a coarse collection hold protects required bytes. The app writes verified completed exports to a dedicated Windows backup-output mount; the host's existing backup software handles remote protection. Ordinary app use continues. The [Windows deployment plan](WINDOWS_DEPLOYMENT.md#3-backup-procedure) defines ordering, partial-output recovery and destination ownership. A stopped-app whole-volume copy remains a fallback, and schema upgrades may still use a maintenance window.

Working policy to review at installation: daily off-peak exports, an additional verified snapshot before migrations, and seven daily plus four weekly local restore points if capacity permits. Remote retention/transport belongs to the external backup system; a dedicated network-share output mount remains an alternative. Match local retention to that system's schedule and show remote status as unknown unless it reports success. Recovery after disk loss depends on both export and remote-copy schedules. Pending phone data is not a backup of all accepted household content. Confirm destination access, capacity and acceptable recovery interval before real use. Backup retention and live-media garbage collection are different policies.

Do not automatically replay pending work against an arbitrarily older restored server without a recovery contract. A restore can remove receipts that once proved an operation committed. The initial restore procedure must mark a new server recovery epoch and pause automatic client submissions until reconciliation, rather than quietly risk duplicate resurrection. See [the recovery addendum](RESTORE_RECONCILIATION.md).

Use HTTPS and application authentication even on the private tailnet. The proposed host is Windows with Docker and local NVMe; verify its existing backend/startup behaviour and choose endpoint/port settings during installation. Live storage is a dedicated local Linux-backed volume, with ordinary Windows files used for completed backup exports. The container's replaceable layer is not the durable data location.

## 7. Decisions now versus user input

The server/client stack, package boundaries, transaction pattern and slice ordering above are working choices we can make from the stated requirements. Exact dependency versions are a compatible-set validation task, not a preference questionnaire.

The **host machine/storage arrangement** now has a working target: another Windows machine already running media applications, Docker for Windows, local NVMe (probably the boot drive), and remote backups to the main PC. [WINDOWS_DEPLOYMENT.md](WINDOWS_DEPLOYMENT.md) selects the Linux-backed volume and concrete backup/restore boundaries. Exact machine names, paths, credentials and startup configuration are installation inputs; they do not block the first slice's local implementation. Device-specific voice/lock-screen tests need access to the actual phones during implementation; they do not justify guessing capabilities now.

After this slice passes, build Shopping/restock first to replace the unreliable Keep list, then task/maintenance recurrence and personal overview, then recipe ingestion and richer project/gift interfaces. Preserve the already-designed shared boundaries while sequencing the integrations separately. A first functional build should prove useful capture and reliable shared state before adding every visual category.
