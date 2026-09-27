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

Reusable record-attachment editing is in progress for maintenance records.
Server placement edits and guarded history are implemented and tested. Browser
and Room attachment-draft infrastructure is being added; the attachment editor
and maintenance assets/service log are not yet released. Migration006 remains
unpublished. See MAINTENANCE_IMPLEMENTATION.md.

## Verification

The deployed Tasks release passed 40 server tests, five contract tests, nine
browser flows and five Android unit tests, plus isolated native UI checks.
Current attachment changes add server checks for reordering, caption history,
receipt replay, privacy, rollback and collection after the final live reference.
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
