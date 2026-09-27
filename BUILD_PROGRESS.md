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
- Home assets, model/serial/location details, archive state, photos and service logs.
- Tasks linked to assets, atomic completion/service recording, historical service,
  exact decimal costs with explicit currencies, and revision-guarded compound undo.
- Visual Food library, metadata/photo import, Want to try, Favourites, Make soon
  pins, household adjustments and cooking notes/photos.
- Linked cooking tasks with actual-date recurrence, plus selected ingredient
  shopping groups, retained source details and compound undo/redo.
- Project boards, nested mixed-media pages, source-owned record links, ordered
  next-action pins, subtree moves, selective restoration and history.
- Optional maintenance ideas with source guidance and independent task drafts.

## Current development

Photo editing is deployed on the web and in the private Android download.
Browser and Room drafts retain originals and immutable requests through an
interrupted save. Migrations001–016 are published and immutable. Home assets
and the service log are deployed on the web and in the private Android download.
See MAINTENANCE_IMPLEMENTATION.md.

The separate Alexa task's capture backend is integrated. Integration actors are
distinct from people, and the separate listener can only capture shared inbox
notes and resolve its own receipts. It is disabled in the live deployment; no
integration identity or credential has been provisioned there. Amazon setup,
the cloud transport and network restrictions remain with the Alexa task.

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

The combined Home/Alexa release passed 61 server tests, six Alexa tests, five
contract tests, 20 browser flows and ten Android unit tests. Docker built and
tested the same source. Native UI checks covered Home drafts, Back, linked
completion, actual-date recurrence, undo/redo, partner receipt downloads,
historical images and Room cache. Installing over the previous APK preserved
its session, unfinished photo capture and old task form; both saved afterward.
Browser checks also cover full-length integration note IDs and Alexa attribution.

Before deployment, the fresh secondary backup was restored into a new isolated
directory and migrated through 007 and 008. All 20 retained data tables and four
media files were preserved. The live upgrade used another verified pre-upgrade
backup, and all 17 existing inbox record hashes plus installation/epoch were
unchanged afterward. The upgrade backup is verified on the secondary drive.
Live schema/integrity and read-only desktop/phone Home checks passed; the web
bundle and published APK match the tested artifacts. No test records were added
to the live household.

## Remaining work

Calendar integration, selective notifications, richer
gift workflows and Alexa cloud/device integration remain.
Fixed-calendar recurrence needs an explicit missed-slot policy. OEM voice,
widget and locked-phone behavior requires physical-device checks. Metadata
snapshots have explicit limits pending incremental synchronization.

The active household contains real data. Never replace it with test fixtures.
Run tests against disposable databases and preserve installation identity,
media, history and pending phone captures. See AGENTS.md and PHONE_TRIAL.md.

## Food development checkpoint (2026-09-27)

The development branch now includes scoped recipe storage, background metadata and
photo import, worker attribution/receipts, review after concurrent edits, visual Food
screens, household adjustments, cooking notes/photos and independent Soon pins.
Browser and Android clients cache saved Food data and retain unfinished forms.
Migration 012 adds only view preferences; existing recipe and household revisions
are unchanged by pins. The checkpoints below led to the complete Food release.

Verification includes 23 browser flows, ten Android unit tests, native Food flows,
in-place APK preservation and a real public recipe import into a disposable database.
See RECIPE_IMPLEMENTATION.md for exact coverage and limitations. Cooking tasks are
now connected through migration 013, with atomic meal/completion/recurrence history,
guarded undo and shared date controls. The Linux build passes all 135 tests across
server, contract and voice packages. Ingredient shopping groups now add a durable
recipe checklist, immutable source details and collapsible named groups. Group
removal keeps items and protects concurrent edits; compound undo/redo includes
membership changes. Migration 014 is additive. All 27 browser flows and 139 Linux
package tests pass; the APK update preserves the previous emulator data and drafts.
Deeper collection controls remain optional follow-up work.

## Food release (2026-09-27)

The web app and private Android download now include Food and named shopping
groups. The tested image and APK match the served bytes. A fresh backup was copied
to the independent secondary destination, restored into a new Docker volume under
production Linux settings, and migrated through 014. All 24 retained tables and
four media files were preserved; the isolated rehearsal volume was removed after
verification. The live upgrade took another verified backup before applying six
migrations to the existing data volume.

Both profiles' 19 distinct pre-release records passed preservation checks after
deployment. Installation identity and recovery epoch were unchanged. Live SQLite
integrity/foreign-key checks, responsive Food rendering, cached feature payloads
and the secondary upgrade-backup status passed. No test records were created in
the live household. The named shopping-group suggestion is recorded as completed
in the ignored local review metadata. Installing the published APK over the
existing phone app is still a user action; emulator installation was verified.

## Projects release (2026-09-27)

Projects now has visual boards, nested pages, ordered text/web/reference/photo
blocks, independent priority pins, subtree moves, archive, explicit restoration
and guarded history. Shared boards cannot disclose private references. Both
clients cache pages and retain unfinished editors, including incomplete links.
Android Back walks up nested pages before leaving Projects.

Verification passed 155 Linux package tests, 31 browser flows, ten Android unit
tests and isolated native runtime flows. In-place APK installation preserved the
previous session, cached records, photo captures and editor buffers. A fresh
secondary backup restored into a disposable Linux container preserved all 41
retained tables and media while applying migrations 015–016. The live upgrade
preserved both profiles' 19 existing record hashes and installation/recovery
identity; foreign-key/integrity checks passed. Published web/APK bytes match the
tested builds, and the upgrade backup is verified on the secondary drive.

## Maintenance ideas release (2026-09-27)

Home now offers five optional maintenance ideas with links to official guidance.
Each opens a normal editable task, with dates and recurrence unset and a separate
durable draft for that asset and idea. Existing manual drafts stay intact.
All 11 affected browser flows, native Android checks, in-place APK preservation,
typechecking and package boundaries pass. The image passes 155 Linux package
tests. The release requires no schema change. A fresh online backup and its
secondary copy were verified before publication. Both profiles' existing record
hashes and installation/recovery identity stayed unchanged, and served web/APK
bytes match the tested builds. Live checks added no synthetic household records.

## Calendar foundation checkpoint (2026-09-27; not deployed)

The development branch adds a Google reader, provider-neutral event contract,
owner-controlled selection/cache repository and asynchronous synchronization port.
All 18 focused tests pass, covering pagination, DST and recurring instances,
private/shared projections, atomic replacement, access loss and disconnect races.
Migration 017 preserves pre-existing tables and household identity in an isolated
upgrade test. Network work does not hold a database transaction, and every cache
publication rechecks the authority under which it started.
Typechecking, package boundaries and production builds pass. The package suite
passes 172 tests with one platform-specific skip on Windows.

Account connection, token storage, routes, scheduling and calendar UI are not yet
wired. The live maintenance-ideas release and private APK remain unchanged, with
schema 001–016. The first-release choice between a read-only agenda and household
event editing is still awaiting user input. See CALENDAR_IMPLEMENTATION.md for
the implemented boundaries and remaining integration work.

## Calendar authorization checkpoint (2026-09-27; not deployed)

The server now has an isolated consent/credential service using Google's official
OAuth library. Consent is expiring and tied to the initiating live client; account
reconnection preserves selections only for the same Google subject. Credentials
are encrypted transactionally and refresh/rotation cannot revive a disconnected
connection. Restores discard grants and pending consent while preserving household
data and calendar selection metadata.

Fourteen additional tests pass, including simulated HTTP through the actual Google
SDK, concurrent refresh, rollback, ownership, migration preservation and encrypted
backup/restore. Runtime key/OAuth configuration, callback handoff, routes, scheduler
and UI still need wiring. No live Google account, key or token has been provisioned;
the running app and published Android download remain on the maintenance release.
Typechecking, package boundaries and builds pass. The package suite passes 186
tests with one platform-specific skip on Windows.

## Calendar settings checkpoint (2026-09-27; not deployed)

The development branch now wires optional host-only configuration, browser consent,
owner-scoped calendar settings, and receipt-backed selection and disconnection.
Migration 019 binds each encrypted callback to its original browser session. Google
codes and state are excluded from application redirects and request logs. Android
opens settings in the external browser and keeps unfinished captures in the app.
No live Google account, client configuration, encryption key or token was created.

Five HTTP tests and three browser flows cover consent binding, profile switching,
source privacy, retry, selection, disconnection and responsive layouts. The dedicated
Android emulator passed actual browser launch and Back with its draft preserved;
in-place installation separately preserved its existing cached data, photos and
editors. The package suite passes 191 tests with one Windows-specific skip, along
with typechecking, package boundaries and production builds. Calendar scheduling,
the full 35-flow browser suite, and 192 passing Linux package tests in the Docker
candidate. Calendar scheduling, agenda rendering and physical-device Google consent remain. The live app, database
and published APK are unchanged.
