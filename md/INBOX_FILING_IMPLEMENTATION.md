# Filing captured notes

Inbox offers Unfiled, Filed and All notes. Its navigation count includes only
unfiled, non-deleted household notes. App suggestions retain their separate
category. Filing preserves the original text, capture source and photo attachments;
the destination owns its subsequent task, shopping or project state.

The File dialog creates a task, shopping item or project page, or links to an
existing authorised record. New destinations keep the note's exact visibility.
Shopping lists and projects must already exist. The task's optional date is a
flexible target; further assignment, recurrence and planning use the task editor.
Project pages include a reference block to the original note. New task and
shopping cards also provide a source link. Photos stay attached to the source;
deleting that source follows ordinary deleted-media retention, rather than
copying its photos permanently into every destination.

Back to inbox makes a note unfiled while retaining its destination links. Unlink
removes one reference, never the destination, and returns the note to Inbox if
no links remain. A deleted target leaves an unavailable-destination indicator.
Suggestions and household filing are independent: moving a note to suggestions
retains its provenance, and household filing controls return with its category.

## Transaction and ownership

Migration021 adds `inbox_entries.filed_at` and source-owned `inbox_destinations`.
Composite foreign keys validate each endpoint's scope, and SQL triggers prevent
a shared source from referencing a private destination. The source record's
revision guards all link changes. At most twenty destinations belong to a note.
Target deletion does not cascade to the note or remove a retained reference.

`InboxFiling` composes a static whitelist of existing synchronous creation
handlers: CreateTask, AddShoppingEntry and CreateProjectPage. Their domain
validation remains authoritative. One WriteCoordinator transaction contains
destination creation, source filing, the compound changeset and the immutable
operation receipt. Neither a nested transaction nor a second command receipt
is introduced. A retry reuses its exact operation, and an insertion or receipt
failure rolls back every participant.

Linking an existing item leaves that item and its history unchanged. A private
source may reference a shared item, but backlinks are derived only from the
current person's authorised snapshot; another profile sees no private source
text, photo or backlink count. Creating a new item always requires identical
source and destination scope, even for a private source and shared container.

Per-person undo reverses the whole filing action. Newly created destinations
are removed only when the existing revision and relationship checks still
permit reversal. Later edits by the other person reject undo without partial
changes. Existing destination content is never undone by undoing its link.

## Compatibility and drafts

Old cache entries and history payloads interpret missing filing fields as
unfiled with no destinations. Frozen CreateInboxEntry requests keep their
original schema and bytes. The additive migration preserves all old columns,
receipts, history and installation identity; published earlier migrations are
unchanged. Android stores the added fields in its existing snapshot JSON, so
no Room schema migration or reinstall is needed.

Unsubmitted filing drafts use the existing local durable editor store. Closing,
Android Back and reload retain them. Offline forms are editable, but filing
requires connection. Submission locks the source's existing operation queue
until its outcome is known. Retry reconciles the frozen operation. A changed
source revision retains the draft and requires explicit discard/load before a
new filing. Ctrl/Cmd+Enter submits a valid connected form.

The full original text populates destination details. Shopping's shorter
10,000-character limit is explained and blocks submission until shortened;
source text is never truncated. Linking to an existing item copies no content.

## Verification

- Ten server tests cover compound undo/redo, lost replies, source media,
  visibility and SQL guards, twenty-destination capacity, nested request
  validation, missing parents, insertion/receipt failures, migration rollback
  and exact replay of retained and previously pending legacy commands.
- Five filing browser flows cover source navigation, photos, screen widths
  from 320 to 1440 pixels, long text, nested project pages, retained links,
  private drafts, offline reload, stale source edits and frozen retries.
  Eight existing inbox and note-link flows also pass.
- `scripts/verify-android-inbox-filing.mjs` requires the named test emulator
  and disposable Alex/Sam server fixture. It checks native-to-browser sync,
  original photos, Android Back, offline Room cache and unfinished filing text.
  In-place APK preservation is checked before resetting that test emulator.

Automatic categorisation and external language-model providers remain separate
future work. Everyday filing requires neither an external provider nor sending
household content outside this installation.
