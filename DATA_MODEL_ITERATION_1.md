# Household app — archived data-model inventory

Historical snapshot preserved on 2026-09-26 before the connected design pass. See [DATA_MODEL.md](DATA_MODEL.md) for the current proposal; unresolved-next-pass statements below describe the earlier inventory.

Date: 2026-09-25. Status: agreed storage goals with a proposed logical schema. Host media uses files on an app-owned Docker bind mount; SQLite remains the working database choice. This is a design map, not executable DDL or an implemented stack. Read with [ARCHITECTURE.md](ARCHITECTURE.md), the [capture submission decision](decisions/0001-offline-capture-submission.md), the [record history/media decision](decisions/0002-record-history-and-media-retention.md), and the [file/container storage decision](decisions/0003-file-media-and-container-storage.md).

## 1. Storage scope

The deployment is a self-hosted application for two people. Use one host relational database for the whole application: domain data, identity/settings, operation receipts, job state, and any cache-invalidation metadata. These are different tables with different responsibilities in the same transaction domain. Feature modules are code ownership boundaries, not separate databases.

Each Android phone can also use one local database containing its authorised read cache, local capture data, submission state, immutable submitted payloads, and acknowledgements. Separating data and metadata logically does not require separate files, engines, or services. Phones communicate with the application API; they do not write the host's database file over a network share.

Local client data also includes recoverable form drafts and draft media. A draft stores person/context, form kind, typed or versioned field values, local revision/time, and optional target entity/base server revision. Inbox capture drafts additionally track explicit submission intent so an autosaved unfinished form is not uploaded on reconnect. Stable local media IDs link acquired bytes, metadata, and readiness to the draft, then to its frozen submission. Choose one authoritative draft representation rather than duplicating editable text in form and queue tables. Local media placement may use BLOBs or durable app-private files appropriate to the selected client stack; byte availability and reference updates must be recoverable across interruption. These are client concerns, not new shared household rows created for each keystroke.

The agreed choice is to store photo/receipt bytes as immutable ordinary files, with identity, storage key/generation, digest, source provenance, lifecycle and references in SQLite. Docker mounts a dedicated app-owned host directory with separate database and media subdirectories. Publish files durably before committing live references; failed database finalisation may leave pending/unreferenced files for retry or cleanup. Replace media as whole objects; collect unreferenced old bytes after roughly 24 hours or earlier under storage pressure while retaining small historical metadata. Backups must preserve the database and referenced files consistently and live outside the app's writable mount. There is no requirement for an object-storage service.

SQLite is now the leading choice for the host; confirm its library/configuration with the implementation stack and backup workflow. Two users do not by themselves justify a distributed storage architecture. SQLite explicitly supports application-server use when its workload and deployment conditions fit; its network-filesystem caveats concern direct database-file access. [SQLite deployment guidance](https://www.sqlite.org/whentouse.html)

## 2. Reliability appropriate to this deployment

The target is durable household data through app restarts, interrupted requests, duplicate retries, and routine upgrades. The server can be temporarily unavailable while phones browse cached records and retain new captures. No current requirement calls for failover, replication infrastructure, sharding, or a separately deployed message broker.

Use normal database durability, short transactions, uniqueness/foreign-key constraints, the agreed submission protocol, and a small background worker backed by database tables. Back up the database and any external media, retain backups outside the failure scope of the host, and test a restore. Submission receipts do not replace backups. A restore from an older backup can lose changes acknowledged after that backup; decide an acceptable recovery interval rather than claiming zero loss after destruction of the host's storage.

Use a database-supported backup procedure rather than assuming a copy of live database files is consistent. For example, SQLite provides an [online backup API](https://www.sqlite.org/backup.html). Exact scheduling, retention, and restore commands follow the database/media choice.

## 3. Conventions to establish across all features

| Concern | Proposed convention | Why decide globally |
| --- | --- | --- |
| Vocabulary | One glossary shared by classes, tables, API contracts, and UI concepts | Avoid separate synonyms for the same object and one name hiding different meanings. |
| Table/column naming | Plural `snake_case` tables; explicit role names for columns | `recipes`, `recipe_ingredients`, `recipe_adjustments` form a predictable family. |
| Identity | Stable entity IDs with one chosen representation; descriptive FK names such as `recipe_id` | References survive collection moves, imports, and client cache refresh. Do not derive identity from titles, URLs, or array positions. |
| Ownership | Every relation has a named owning module; relationships may cross modules using declared contracts and FKs | One global model with clear write responsibility. |
| Person and source | Distinguish authenticated caller, attributed person, and capture device/source | A shared speaker should not require pretending that it is one spouse. |
| Visibility | A shared policy vocabulary with person-scoped privacy and explicit sharing rules | Private gifts must not leak through joins, thumbnails, activity, or caches. |
| Time | Instants use `_at`; date-only values use `_on`; recurring local schedules retain a time zone | A target date, completion instant, and calendar appointment must not be implicitly converted into one another. |
| Revisions | Mutable records have a defined revision/conditional-update rule where needed | Timestamps are display/provenance information, not the sole concurrency guard. |
| Change history | Commit grouped, versioned old/new logical deltas alongside current records; recent undo/redo targets the attributed person's actions and commits new changes | Read-only history can reach further back than safe undo. Reject later conflicting row/dependency changes. Binary bytes follow their own retention policy. |
| State | Domain-specific state names with documented transitions | A task's completion state and an upload's acknowledgement state have different meanings. |
| Constraints | Primary keys, foreign keys, uniqueness, nullability and checks encode agreed invariants | Module boundaries do not excuse structurally invalid cross-feature data. |
| Quantities | Preserve original ingredient text; use explicit units and precise numeric representations when parsed | Recipe quantities must not silently become untyped floating-point values or lose ranges. |
| Money | Explicit currency and exact amounts if costs are stored | Receipts and purchases use one consistent representation. |
| JSON | Suitable for raw import snapshots, bounded command payloads, provider details, and versioned layout settings | Core identities, relationships, amounts used in operations, and lifecycle state remain deliberately modelled. |
| Deletion | Choose archive, soft delete, hard delete and cascade policy per relationship | Preserve durable records and idempotency receipts without orphaning media or reviving deleted entries. |
| Migrations | One globally ordered migration history, with feature ownership recorded | A cross-feature change has one coherent deployment order; class renames do not silently rebuild user data. |

Relational constraints support these invariants; some cross-row/state rules still require transaction logic. [PostgreSQL constraint documentation](https://www.postgresql.org/docs/18/ddl-constraints.html) provides concrete examples without committing this app to PostgreSQL.

## 4. Whole-app entity inventory

This inventory covers known features so shared concepts are considered together. It is not a requirement to create all listed relations in the first migration. Table families and cardinalities remain provisional until the relationships in section 5 are resolved.

| Area | Candidate relations | Key relationship or invariant |
| --- | --- | --- |
| Household and access | People, devices, household settings, credentials/sessions as needed | One household is the deployment target. Support personal identity and shared devices without building a multi-tenant product. |
| Record identity — proposed | `records`, visibility-scope references | Stable targets for shared capabilities; typed payload, subtype consistency, revision ownership and deletion rules must be explicit. See section 5. |
| Inbox | `inbox_entries`, capture provenance | A filed entry can retain provenance/reference to its destination; it does not own a duplicate copy of that destination's current state. |
| Operations | Submission/operation receipts; currently `capture_submissions` in A04 | A scoped unique key identifies a logical operation and its immutable request digest/result. Receipts outlive edits/deletion of their result where necessary. |
| Change history | `change_sets`, `record_changes` | Group the record/relationship changes from one committed action; preserve attribution, ordering, old/new values and revisions without duplicating media bytes. History access must protect private content. |
| Tasks | `tasks`, `task_occurrences`, `task_completions`, recurrence policy | A definition, actionable occurrence, and actual completion are distinct. Simultaneous completion must not advance recurrence twice. |
| Shopping | `shopping_entries`, `restock_items`, `purchase_records` | A reusable restock item can lead to many shopping entries over time; buying a replacement does not record installation. |
| Recipes | `recipes`, `recipe_sources`, `recipe_ingredients`, `recipe_steps`, `recipe_adjustments`, `recipe_cooking_records` | Imported source data and household adjustments have distinct ownership. Moving collections preserves the recipe ID. |
| Recipe organisation | Recipe collection membership, Soon pins | Want to try/Favourites organisation and Soon priority are independent concepts. |
| Maintenance | `home_assets`, `maintenance_plans`, `maintenance_records` | Plans use the task recurrence mechanism; service history links to the asset and relevant completion. |
| Projects | `projects`, `project_pages`, typed content/link relations | Hierarchy must prevent cycles. A project can refer to existing recipes, tasks, assets or files without copying them. |
| Gifts | `gift_suggestions`, `gift_plans`, relevant purchase links | Private planning/purchase details do not belong on the shared suggestion row. |
| Reminders | `reminders`, channel preferences, `reminder_deliveries` | Reminder snooze, task target, and actual completion remain distinct. Delivery records track attempts/results. |
| Calendar | `calendar_connections`, external calendar/event references and cached events | Provider identity and local source ownership survive refresh; work aggregation does not imply household sharing. |
| Media | `attachments`, attachment links, `media_objects`, upload/publication metadata as needed | Bytes are files. Stable metadata, storage key/generation, source URI/page, retrieval time and content hash survive collection. Live references/publication claims gate deletion; deletion claims gate reattachment. |
| Views and activity | Scoped pins, view preferences, permitted activity records/projections | Dashboard ordering does not move records. Activity is a visibility-filtered view of relevant facts. |
| App suggestions | `app_suggestions`, optional attachment/context links | Product feedback has its own workflow and is not automatically executed. |
| Background work | `background_jobs`, import attempt/result metadata as needed | A durable job and its originating state change can commit in the same database transaction. |

Cooking, purchasing, task completion, and maintenance records are useful typed product history. Their changes can appear in the logical journal, but their domain meaning should not be replaced by a raw request log. User-facing history and activity are authorised views over relevant facts and changes, not unrestricted access to receipts or the journal.

## 5. Relationships to design together before DDL

These are the highest-impact outstanding model choices. Resolve them explicitly rather than let the first screen or ORM settle them accidentally.

1. **Identity and attribution:** define people, personal devices, shared speakers, and integration callers. Then choose the common receipt-key scope and attribution fields. A04's household/author key is a capture-specific proposal; shared service callers must fit the final authenticated-caller model without inventing a human author.
2. **Targets shared by notes, attachments, pins, history, and project links:** architecture iteration 2 prefers a thin `records` identity registry for review, with typed domain payload and domain-specific foreign keys. Its proposed envelope holds record identity/kind, visibility-scope reference, revision and deletion metadata, each with one authoritative owner. Specify subtype consistency, atomic creation/deletion, stable child identities, and which child changes advance the parent's revision. Do not create registry entries for every ingredient, receipt or job automatically. Explicit typed joins for every shared target remain the alternative if the registry proves harder to constrain. Avoid unconstrained `(kind, id)` links or a universal domain superclass as accidental compromises.
3. **Tasks and their instances:** decide whether one-off tasks also have an occurrence, which completion/correction history to retain, and how recurrence revisions affect existing occurrences.
4. **Time and attention:** decide how an actual deadline, flexible target, review date, per-person snooze, and independent pin coexist. There should be one coherent representation for each meaning across features.
5. **Collections and references:** settle recipe membership semantics, project hierarchy, and links from tasks/shopping to recipes and assets. Do not make a recipe leave Favourites merely because it is pinned for Soon.
6. **Reusable shopping items:** define the restock-to-shopping-to-purchase relationships and what happens on re-addition, partial purchase, and undo. Keep quantities and origin links consistent with recipe ingredient selection.
7. **Media and deletion:** design file storage keys/generations, upload/publication tracking, attachment ownership, sharing, collection claims/tombstones, historical provenance and backup consistency together. Define what undo can restore after old bytes are collected and how verified source recovery works; see A09 and A13. These lifecycle states cover real filesystem work outside SQL transactions.
8. **Technical receipts versus change history:** choose whether a small common `operation_receipts` relation replaces the capture-specific receipt table for the several retryable commands, or whether endpoint-specific receipts share conventions. Design grouped reversible deltas alongside current state, including payload evolution, person attribution, and conservative conflict checks for recent undo. Read-only historical browsing/copying is the principal deep-history workflow. Decide independently whether an incremental cache feed is needed initially or a bounded full refresh is simpler.

Before the first migration, each entity should have an owner, key, visibility rule, lifecycle, relationships/cardinalities, unique constraints, deletion behaviour, and principal read/write paths. Exact indexes follow those access paths. Future modules should extend this model through the same conventions; schema evolution remains expected and uses reviewed migrations.

## 6. Operations and metadata in the same database

The phone persists operation intent and progress locally, including the idempotency key and frozen request. For inbox capture, A04 defines the edit boundary. Its local capture and submission state can be columns in one table or related tables in the same local database; choose one authoritative source for each state rather than maintain two independently writable status copies.

The host commits the data mutation, media metadata/references, logical change set, receipt/result, and any required durable job together. Newly referenced media files must already be durably published and protected from collection. For an immediate database operation, it does not need a separately committed remote "received" or "processing" state: an incomplete transaction rolls back, and a committed receipt resolves the retry without creating duplicate history. File publication/deletion and work that deliberately runs later, such as recipe fetching, have real lifecycle state outside that transaction. This makes client and server states logically reconcilable without forcing identical status sequences on both sides.

Record logical operations such as `CreateInboxEntry` or `CompleteTaskOccurrence`, not arbitrary SQL sent from clients. A retry key is distinct from the affected entity ID because a record can have many operations over its lifetime. The simple inbox-create protocol can use its stable capture identity as the create operation key, as specified in A04.

An operation receipt answers "did this request commit, and what result did it create?" A record revision answers "has this record changed since I read it?" A change set answers "what changed together, and what were the previous values?" A cache cursor answers "which changes have I downloaded?" These are different questions even when all metadata resides in the same database. Current tables serve ordinary reads; the delta journal enables historical views and supplies the information for checked undo/redo. See [A09](decisions/0002-record-history-and-media-retention.md) for the proposed mechanics and media-retention boundary.

## 7. First schema review package

Following architecture iteration 2, the next schema pass should produce one connected ER diagram for the whole known domain, a glossary/table catalogue, explicit relationship cardinalities, representative constraints, and worked transactions for photo capture, alternating edits/personal undo, recurrence, recipe-to-shopping/task, and private gift planning. Resolve the proposed record registry and identity/attribution model first, because they affect many table families. The current inventory is not yet that complete ER model.

Review those artifacts against normal user workflows, deletion/undo, import refresh, and backup/restore. Then write migrations for the first working features using the agreed conventions, rather than creating unused tables solely because they appear in this inventory.

## 8. Storage measurements for Settings

Expose a small timestamped storage summary, measured locally for this device and by the host for the server. It is a diagnostic query/response with a cached last result; it does not require a time-series database or replication of server filesystem access. Refresh on opening Settings > Storage when stale and on request; retain the server's last measurement while offline. This device's database includes both cached records and pending captures.

Report database size as a sampled sum of the main database file and its associated journal/support files. Show media files separately, with staging/derived files where useful and a labelled overall app-storage total. File sizes can move during measurement, so these are approximate operational snapshots, not a transactionally exact accounting total. Bytes awaiting collection are a subset of stored media and must not be added to the total twice. Match local-client accounting to its actual chosen storage representation.

Optional details can report logical allocated pages (`page_count * page_size`) and reusable whole pages (`freelist_count * page_size`), plus file payload bytes and bytes awaiting collection from media metadata. SQLite documents these page counters in its [PRAGMA reference](https://www.sqlite.org/pragma.html). Logical page totals and sampled database file totals can differ during WAL activity; file payload sums need not equal filesystem allocation, and database free pages say nothing about external media usage. Expensive scans are unnecessary for the initial overview, and displaying stats must not trigger compaction or cleanup.

Return aggregate sizes without private filenames, URLs, or record-level breakdowns. Record measurement time and unavailable/error state separately from zero bytes. Later checks should cover offline/stale display, media/subtotal non-duplication, staging/orphan accounting and the distinction between database internal free space and external media files.
