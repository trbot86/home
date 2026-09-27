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
- Reusable photo/receipt editing for Inbox, tasks and completions, with captions,
  ordering, removal, full-size previews and historical images.

## Current development

Photo editing is deployed on the web and in the private Android download.
Browser and Room drafts retain originals and immutable requests through an
interrupted save. Migration006 is published and immutable. Maintenance assets
and the service log are next.
See MAINTENANCE_IMPLEMENTATION.md.

The deployed usability update adds a house favicon, clickable web addresses in
notes and captions, and a Storage shortcut to this household's Android
installation page. Android opens links in the external browser and preserves
unfinished edits when returning. The installation shortcut downloads through
the browser; Android still asks before installing. It is not an automatic updater.

Deployed internal note links add Copy link to the note editor, resolve readable titles
from the current profile's cache, and open notes inside the app. Pasted links
also open the corresponding web note after profile selection. Existing cached
notes remain readable offline; a link never grants access to a private note.
Android links opened outside Our place use the browser; Android App Links are
not configured.

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
The release preserved existing record hashes and installation/recovery identity.
Both the secondary backup and a restore into a new isolated folder were verified.

The usability update passed 14 browser flows and ten Android unit tests. After
the final link-component refinement, the eight affected browser flows passed
again. An isolated Android emulator verified actual browser handoff, returning
to an unfinished editor, and the installation shortcut's configured endpoint.
Live checks verified the matching icon, web bundle, Android download, installation
page and a fresh secondary backup. Existing household records and identity were preserved.

Note linking passes nine affected browser flows, including private-title
isolation, late responses during profile switches, offline links, deletion/undo,
and unfinished editor preservation. The isolated Android emulator also passed
actual clipboard copy/paste, internal navigation, Back and profile isolation.
The live web bundle and private APK match the tested build. A live shared-note
deep link opens after profile selection; record hashes and household identity
were unchanged, and the pre-release backup was verified at the secondary location.

## Remaining work

Maintenance assets/receipts, recipes, project boards, calendar integration,
selective notifications, richer gift workflows and Alexa integration remain.
Fixed-calendar recurrence needs an explicit missed-slot policy. OEM voice,
widget and locked-phone behavior requires physical-device checks. Metadata
snapshots have explicit limits pending incremental synchronization.

The active household contains real data. Never replace it with test fixtures.
Run tests against disposable databases and preserve installation identity,
media, history and pending phone captures. See AGENTS.md and PHONE_TRIAL.md.
