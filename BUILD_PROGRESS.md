# Build progress

Updated 2026-09-27.

## Implemented and deployed

- TypeScript/SQLite server, responsive dark-green React UI, Android host and Room persistence.
- Shared/private Inbox, photos, durable offline capture, separate app suggestions and history.
- Revision-guarded commands, immutable retries, per-person undo/redo and Ctrl+Z/Ctrl+Shift+Z.
- Shopping lists, reusable restock products, purchase attribution and history.
- Tasks/chores, Home/Work/person filters, priorities, deadlines, flexible targets and review dates.
- Actual-completion recurrence, performer attribution, completion notes and compound undo.
- Online database/media backups, secondary-copy verification, isolated restore and upgrade protection.
- Private Android distribution with locally compiled server configuration.

## Current development

Reusable photo editing is implemented for Inbox entries, task definitions and
completion records: captions, ordering, removal, full-size viewing and history.
Browser and Room drafts retain originals and immutable requests through an
interrupted save. The editor is verified and awaiting deployment; Migration006
remains unpublished. Maintenance assets and the service log are next.
See MAINTENANCE_IMPLEMENTATION.md.

## Verification

The deployed Tasks release passed 40 server tests, five contract tests, nine
browser flows and five Android unit tests, plus isolated native UI checks.
Current attachment changes pass 43 server tests, five contract tests, 12 browser
flows and eight Android unit tests. These cover migration preservation, receipt
replay, caption/order history, privacy, rollback and media retention. The isolated
emulator also passed native draft/Back handling, partner downloads, undo, history
images, and actual camera and gallery acquisition into a task's photo draft.
Local reports contain exact build, backup and deployment evidence. They are
intentionally excluded from this public repository.

## Remaining work

Maintenance assets/receipts, recipes, project boards, calendar integration,
selective notifications, richer gift workflows and Alexa integration remain.
Fixed-calendar recurrence needs an explicit missed-slot policy. OEM voice,
widget and locked-phone behavior requires physical-device checks. Metadata
snapshots have explicit limits pending incremental synchronization.

The active household contains real data. Never replace it with test fixtures.
Run tests against disposable databases and preserve installation identity,
media, history and pending phone captures. See AGENTS.md and PHONE_TRIAL.md.
