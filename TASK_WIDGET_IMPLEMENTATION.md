# Android task widget

Status: deployed on the private server and Android download, 2026-09-27.

Add **Our place tasks** from the Android launcher’s widget picker while the
desired profile is selected in the app. Each instance has Home/Work filtering,
a maximum of one to five rows, an attention-only filter and a private-task toggle.
Defaults include shared tasks assigned to the selected person or unassigned,
Home and Work, attention-only, three rows, and no private tasks.

The widget shows task titles, the reason they need attention and when the cache
was downloaded. Resize it to show more rows, within the configured maximum.
**Done…** opens the existing completion form; **Move date…** opens flexible
target/review controls. Both retain the app’s revision checks, durable pending
requests and undo. A stale shortcut never resolves to a later recurring occurrence.
The global **Dictate** shortcut uses the existing capture activity and currently
selected app profile. Microphone capture remains a foreground action.

## Data and privacy

The existing authorised cache response includes a versioned `taskWidget` read
model. Its rows and timestamp come from the same snapshot as the app’s tasks.
The common contracts package owns task classification and comparison, reused by
the web client and server projection. Native code filters that ordered projection;
it does not implement separate recurrence, command or date-classification rules.

Room retains the projection inside the existing profile cache. SharedPreferences
stores widget options only. No schema migration, server preference row or
additional task authority is introduced. Widget options bind to client, person and
server recovery epoch. A profile switch clears rendered content before publishing
the new session. A wrong profile, restore, missing or inconsistent cache renders
a neutral message. Private task titles require explicit opt-in because launchers
can display them without opening the app. This follows the household’s existing
trusted-network profile model; profile selection is not identity authentication.

Activity intents contain opaque owner/epoch/occurrence identifiers and an action,
never a title or command. The native bridge stores the latest navigation request
durably until the app consumes it. The client checks profile, epoch, scope,
deletion and occurrence state before opening controls. It refreshes when connected.

Cached rows remain readable offline with their downloaded timestamp. Their
attention classification reflects that download, including its household date;
the widget does not claim a live view while disconnected. Edits require a
connection, as in the task screen. Refresh uses the existing sync worker;
WorkManager also requests refresh every 30 minutes subject to Android scheduling.
In-app changes rerender the widget. This is not notification delivery or an
exact alarm. [Android background-update guidance](https://developer.android.com/develop/ui/views/appwidgets/advanced)
describes the scheduling constraints.

Android 12+ selects among responsive RemoteViews layouts by actual bounds.
A compact summary fits short layouts; larger layouts show one to five rows.
Older versions receive portrait/landscape alternatives. See
[Android widget layout guidance](https://developer.android.com/develop/ui/views/appwidgets/layouts).
The task controls have 48dp height. Home-screen rotation, launcher layout and
background behavior still vary by device; emulator evidence does not certify a
physical phone’s launcher or speech recognizer.

## Verification

- `pnpm check`: 215 package tests passed, one platform-specific Windows skip;
  type checking, package boundaries and builds passed. The production Linux
  image passes all 216 package tests with no skips.
- Ten affected browser flows passed: tasks, calendars and agenda layouts.
- Four widget Android tests plus ten existing tests passed, including native
  RemoteViews inflation/intents, filtering, cached identity and recovery checks.
- In-place emulator APK replacement preserved cached sections, profile, photo
  captures and unfinished editor text from the preceding release.
- `scripts/verify-android-task-widget.mjs` exercises real activity intents on the
  dedicated emulator: completion/date forms, deadline retention, unfinished
  capture/completion text, stale occurrence, epoch and wrong-profile rejection.
  Android may consume the first Back to dismiss its keyboard.
- `scripts/verify-android-widget-launcher.mjs` requires the synthetic fixture and
  a widget added through the launcher. Its launcher checks passed: configuration, private opt-in, profile hiding,
  offline reading and actual completion/date buttons. Actual launcher resizing
  from three rows to two preserved visible controls and showed the remaining
  count. UI evidence remains in ignored local storage.

No live household records are used for test mutations. No APK, cached household
content, private server address or test-device report belongs in the source repo.

## Release preservation

The deployed server uses the reviewed production Linux image. The private APK
matches the local tested artifact byte for byte. No schema migration was needed;
migrations 001 through 021 remain unchanged. Both profiles, all 19 pre-existing records,
installation identity and recovery epoch were preserved. SQLite integrity and
foreign-key checks passed. A fresh online release backup was copied and verified
at the configured secondary location. The preceding deployment image is retained
locally for rollback. Machine identifiers, paths, digests and evidence stay in
ignored local reports.
