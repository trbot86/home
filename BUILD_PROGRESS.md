# Build progress

Updated 2026-09-27.

## Suggestion cards and explicit releases (2026-09-27)

Cards show a one-line latest update and a per-person unread marker. Opening a
connected foreground discussion acknowledges only the rendered revisions;
delayed or repeated acknowledgements cannot hide newer updates. Read metadata
does not create content history or change the other person's read position.

Prepare release and Deploy tested release are separate durable requests, visible
on cards and in discussions. One host-managed release checkout merges the
committed suggestion, audits source, runs isolated checks, and builds both server
and Android artifacts. Deployment approval pins the exact manifest; stale source,
images or APKs are rejected. The normal verified-backup upgrade path preserves
live identity/data and publishes the signed Android update. Uncertain deployment
outcomes require host inspection; no replacement is launched automatically.
Build/host-control changes still require coordinated developer review.

Validation: 240 package tests in Linux, 56 browser tests, 16 bridge tests and
15 Android unit tests pass. A verified secondary backup restored into an isolated
Linux volume preserves all 59 existing tables and four media files through the
two additive migrations. Runtime configuration and rehearsal reports are ignored.

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
- Read-only personal calendar agenda, selective calendar visibility, scheduled
  refresh and coherent web/Android offline cache; Google account setup remains pending.
- Per-person agenda sections, ordering, item counts and Home/Work defaults,
  with optional recipe/project panels and durable customisation drafts.

## Current development

Suggestion discussions and the development-host bridge are implemented. Each
suggestion has a separate summary, chronological discussion, persistent questions
and explicit work requests. Browser and Android replies/photos use their existing
durable outboxes; agent updates have a scoped worker identity and do not edit the
original suggestion. Ready for review is distinct from deployment. The bridge
uses one isolated worktree per suggestion and preserves external process journals
across restart; uncertain execution is never blindly relaunched.

Validation: 235 runnable package tests on Windows (one Unix socket test skipped),
all 236 in the Linux image, 54 browser flows, 15 Android unit tests and five bridge
recovery tests pass. An actual installed Codex process produced a persistent
question in an isolated server, and a subsequent run received its answer. An
in-place emulator update preserved all cached sections, offline photo drafts,
profile and editor text; a separate native trial retained a photo reply across
process termination and synchronized it once to the other profile. A restore
from the secondary backup into an isolated Linux volume preserved 51 existing
tables and two media files through schema 022. Live release metadata remains in
ignored `.local/suggestion-discussion-*` files. See SUGGESTION_BRIDGE.md for host
setup, conservative recovery and the current start/result reporting granularity.

Fixed-calendar recurrence has a design checkpoint and tested calendar arithmetic
in FIXED_RECURRENCE_PLAN.md. One late-reporting policy question is pending. The
calculation supports either choice through an explicit cutoff and keeps monthly
schedules anchored after short months. All 229 runnable package tests pass on
Windows, with one existing platform-specific test skipped; type and boundary
checks pass. The feature is not deployed. No command, schema or UI has changed.
The plan separates a fixed occurrence's scheduled slot from its movable target
and guards against older phone editors replacing a fixed rule on other edits.

Desktop screenshot paste and image-file drop are deployed for
Inbox, suggestions and the shared photo editor. Twelve affected browser flows,
fourteen Android unit tests, the native photo-editor regression and all 225
Linux package tests pass. See PHOTO_TRANSFER_IMPLEMENTATION.md.

Shopping product photos and purchase receipt photos are deployed on the private
web host and Android download. They reuse the attachment editor and existing placement
tables, retaining immutable purchase facts, private gift scopes and old history.
The Linux image passes 225 tests; ten affected browser flows, fourteen Android
unit tests and the dedicated emulator photo/offline workflow pass. See
SHOPPING_PHOTOS_IMPLEMENTATION.md.

Recently done is deployed on the web and private Android download, with shared
completion/purchase/cooking/maintenance activity, filters and source links.
See ACTIVITY_IMPLEMENTATION.md.

Inbox filing is deployed on the web and private Android download. Inbox notes can
create or link tasks, shopping items and project pages while retaining the source
and its photos. Migrations 001 through 021 are published and immutable. See
INBOX_FILING_IMPLEMENTATION.md for transaction and retention details.

Personal agenda customisation is deployed: section order, counts and visibility,
Home/Work defaults, recipe and project panels, durable editor drafts and private
preference sync. See AGENDA_LAYOUT_IMPLEMENTATION.md.

The Android task widget is deployed in the private download. It reuses the
server's authorised task projection, supports per-widget views and opens the
existing completion/date controls. It requires no database migration. See
TASK_WIDGET_IMPLEMENTATION.md for the contract and completed verification.

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
with typechecking, package boundaries and production builds. The full 35-flow
browser suite and all 192 Linux package tests pass in the Docker candidate.
Calendar scheduling, agenda rendering and physical-device Google consent remain.
The live app, database and published APK are unchanged.

## Calendar agenda checkpoint (2026-09-27; not deployed)

The read-only Agenda now combines private/shared Google snapshots with personal
task priorities, Home/Work filters, explicit date ranges and offline status.
Background synchronization respects persistent retry timing and checks connection
and selection authority before publication. Browser and Android store the scoped
agenda with their existing snapshot; old caches, photos and unfinished forms remain
intact. No native database migration is required.

The package suite passes 197 tests plus one Windows-specific skip; the Docker image
passes all 198. All 36 browser flows passed across the regression run and the
focused calendar rerun. Android's ten unit tests pass, and the dedicated emulator
passed actual offline agenda rendering, profile isolation, Home/Work filtering and
in-place APK preservation. No test used a real Google account or the live household.
The implementation still needs account configuration, real consent and release
verification. The running app and published APK remain unchanged.

## Calendar agenda release (2026-09-27)

Agenda and calendar Settings are deployed, with an updated private Android
download. Google remains unconfigured pending account setup and real consent;
the personal task overview works without it. The served web and APK match the
tested artifacts.

The independent secondary-backup restore rehearsal preserved 44 retained tables
and two media files under production Linux while migrating through 019. The live
upgrade created another verified backup and preserved both profiles' 19 existing
record hashes, installation identity and recovery epoch. Integrity and foreign-key
checks passed, and the upgrade backup is verified at the secondary destination.
Live desktop/phone-width checks were read-only. Installing the published APK on
physical phones and completing real Google consent remain user/device steps.

## Personal agenda layout release (2026-09-27)

Source revision `c065dad` adds Agenda → Customise agenda for each person.
Section types, order, item limits, Home/Work defaults and calendar range sync
across their devices. Recipe and project cards open the existing records.
Offline drafts and pending saves retain their existing durability guarantees.

The live upgrade applied migration020 after creating and verifying a fresh
backup. Both profiles' 19 existing record hashes, installation identity and
recovery epoch are preserved; integrity and foreign-key checks pass. The
upgrade backup is verified independently at the secondary destination.
The served web assets and private Android download match the tested artifacts.
Live checks opened the editor at desktop/phone widths without saving household
preferences or creating test content. Actual phone installation remains a user
step; the emulator update preserved its cached sections, photo draft and editors.

## Inbox filing checkpoint (2026-09-27; release verification pending)

Notes can be filed into tasks, shopping items, project pages or existing records,
with Unfiled/Filed/All filters and source backlinks. One command transaction
preserves the original capture and photos while creating the destination, linking
it and recording compound undo history. New items retain the source's audience;
linking a private note to a shared item exposes no backlink to the other profile.

Ten server tests and thirteen affected browser flows pass, along with typechecking,
package boundaries and production builds. The package suite passes 212 tests plus
one Windows-specific skip; the Docker candidate passes all 213. Android's ten unit
tests pass. The dedicated emulator preserves its previous cache, photo draft and
editors through an in-place update, then passes native filing, browser sync,
source-photo navigation, Android Back and offline draft/cache checks.

A fresh secondary-backup restore into a disposable Docker volume preserves fifty
retained tables and two media files while applying migration021. The live household
has not yet been upgraded at this checkpoint. See INBOX_FILING_IMPLEMENTATION.md
for transaction, compatibility and retention details.

## Inbox filing release (2026-09-27)

Source revision `0456982` is deployed on the private web host and Android download.
The guarded live upgrade applied migration021 after a verified fresh backup, now
also verified at the secondary destination. Both profiles' nineteen existing
records, installation identity and recovery epoch remain unchanged. SQLite
integrity and foreign-key checks pass.

Read-only live checks opened the filing dialog at desktop and phone widths and
verified the empty Filed view and backup status. Served JavaScript, CSS and APK
bytes match the tested artifacts. No test notes or preferences were saved to the
real household. Physical phone installation remains a user step; the dedicated
emulator passed in-place update preservation and the filing/offline workflow.

## Android task widget release

The native widget provides Home/Work and attention filters, a row limit, private
task opt-in, offline cached reading, manual/background refresh and existing
completion/date controls. Scoped navigation rejects stale, deleted, wrong-profile
or restored-server actions. Actual launcher configuration, profile changes,
offline behavior, buttons and resizing passed on the dedicated emulator.

The production Linux image passes 216 package tests; ten affected browser flows
and 14 Android tests pass. In-place APK replacement preserved photo captures,
unfinished text, profile and cached sections. Deployment required no migration,
preserved all 19 existing records and installation identity, and passed database
integrity and foreign-key checks. A fresh release backup was verified at the
secondary location. See TASK_WIDGET_IMPLEMENTATION.md.

## Recently done checkpoint (2026-09-27; publication pending)

A separate quiet feed combines actual task completions, purchases, cooking and
maintenance. It defaults to shared records, filters person/Home/Work/kind/text,
and groups dates in the household time zone. Linked records appear once. Unknown
performers remain explicit; entering a record does not claim credit for its work.
The feed follows undo/redo and uses the existing coherent offline snapshots.

Five projection tests, two activity browser flows, seven related task/filing
flows, fourteen Android unit tests and the dedicated emulator activity workflow
pass. The production Linux image passes all 221 package tests. The emulator
update preserves the previous profile, caches, photo captures and unfinished
text. Second-profile downloaded photos remain visible with the test server off.
No server schema or native database migration is required. See
ACTIVITY_IMPLEMENTATION.md for privacy and offline-media boundaries.

## Recently done release (2026-09-27)

Source revision `a40dfe9` is live on the private web host and Android download.
No migration was required. Both profiles' nineteen existing records and the
installation identity/recovery epoch are preserved; database integrity and
foreign-key checks pass. The release backup was created online before deployment
and independently verified at the secondary destination. Served web assets and
APK bytes match the tested artifacts. Read-only live checks confirm the shared
feed, responsive layout and backup status without adding household test content.

## Shopping photos release (2026-09-27)

Source revision `1033175` adds product reference photos and purchase receipts.
No migration was required. Both profiles' nineteen existing record hashes and
installation/recovery identity are preserved; database integrity and foreign-key
checks pass. The fresh pre-deployment online backup is verified at the secondary
destination. The served web assets and APK match the tested artifacts. Live
checks opened Shopping and the product editor without saving synthetic content.
See SHOPPING_PHOTOS_IMPLEMENTATION.md for compatibility and test evidence.

## Screenshot paste and image drop release (2026-09-27)

Source revision `67f5285` is live. Inbox, suggestions and the shared photo editor
accept pasted screenshots and dropped image files, with ordinary text handling,
batch validation and durable local saving. The release needed no migration and
preserved both profiles' nineteen records and installation/recovery identity.
Database integrity/foreign-key checks, exact web/APK bytes and the independent
secondary copy of the pre-release backup are verified. Live checks did not save
test content. See PHOTO_TRANSFER_IMPLEMENTATION.md.

## Suggestion discussions and background work release (2026-09-27)

Source revision `b19075b` is live on the private web host and Android download.
Suggestions now carry a discussion, progress summaries, questions and durable
follow-ups with photos. Notes and requests for another round of work are distinct
actions. The host bridge runs requested work in isolated Git worktrees and reports
results in the app; completed code awaits integration and deployment.

The guarded upgrade applied migration022 after a verified backup, preserving all
24 existing records, both profiles and installation/recovery identity. Database
integrity and foreign-key checks pass. A fresh post-release online backup is
independently verified at the secondary destination. Live checks opened existing
discussions at 360, 820 and 1440 pixels without saving synthetic content, and
confirmed exact published APK bytes. The bridge is registered at sign-in and
healthy; existing suggestions are not automatically queued.

Validation passes all 236 package tests in Linux, 54 browser tests, 15 Android
unit tests and five bridge recovery tests. A real isolated Codex run completed a
question-and-answer round after bridge restart. The dedicated Android emulator
preserved data through an in-place update and verified an offline photo reply
across process restart, synchronization and viewing from the other profile.
Physical phone installation remains a user step. See SUGGESTION_BRIDGE.md and
SUGGESTION_WORKFLOW_PLAN.md for the execution and recovery boundaries.

## Suggestion worker permissions and storage correction (2026-09-27)

The initial worker's conversational rehearsal did not exercise a code write or
commit. A real suggestion exposed a read-only Windows session and disabled
approvals. The host now uses the current installed Codex app-server interface,
explicitly verifies workspace-write and automatic review before starting work,
and declines any approval that falls back to the unattended bridge. A real
synthetic edit/test/commit rehearsal passed, including automatic approval for
Git metadata writes. Runtime selection remains in ignored host configuration.

The bridge retains at most three suggestion checkouts by default and shares a
pnpm package cache. Clean idle checkouts can be recycled while retaining their
branches; active, ambiguous and uncommitted work remains protected. Twelve
isolated protocol, restart and worktree-retention tests pass. The Windows restart
helper also handles a Node process surviving its scheduled PowerShell wrapper.
These are host-worker changes; no household migration or Android update is needed.

The live retry subsequently implemented its requested label change, passed six
isolated Food browser tests and committed on its suggestion branch. Both obsolete
execution-permission questions were resolved in the saved discussion.

## Obsolete suggestion questions (2026-09-27)

No longer relevant removes a question from the active list while retaining the
question and a person-attributed resolution in the discussion. It does not queue
work. Resolution receipts replay safely, inherit suggestion privacy and support
normal guarded undo/redo. With all questions closed, an otherwise waiting
suggestion reads Ready to continue. Subsequent agent runs receive the resolved
state. No database migration is required.

Seven server suggestion tests and three browser suggestion flows pass, including
cross-profile visibility, privacy, history, reload and offline replies. The Linux
release image passes its full package suite, and the Android build and unit tests
pass. The update is published through the normal guarded host upgrade and APK
download process.
