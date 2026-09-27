# Recently done

Status: implemented and verified; publication in progress.

The **Recently done** section brings together tasks, shopping purchases, cooking
and maintenance. It defaults to shared work, with filters for person, Home/Work,
kind, visibility and text. Twenty entries are shown initially; **Show more
activity** extends the same filtered list. This is a quiet record with no scoring,
leaderboard, unread badge or automatic notification.

Entries are ordered by when work actually happened, then stable record identity.
Day groups and displayed times use the household time zone. Backdated completion
therefore stays on its actual date. Task completion and purchase attribution use
the recorded performer/buyer. A standalone cooking record may name its cook;
standalone service records currently have no performer field. These display
**Person not recorded**, without treating the person who entered a record as the
person who did the work.

## Projection and ownership

`packages/client/src/activity.ts` derives the view from the current authorised
task, shopping, recipe and home snapshots. It is shared by browser and Android
screens. There is no new event log, command, database table, background job or
migration. Existing records and their history remain authoritative.

A completion with linked cooking or service records becomes one activity row,
with their notes/photos and links back to the task, recipe or home item. A
completion linked to both categories still appears once and matches either
category filter. Duplicate copied notes and attachment placements are suppressed.
The task completion supplies actual time and performer for this compound action.
Standalone cooking/service records and purchases each supply their own date.

Undo removes the corresponding completion/purchase from this view; redo restores
it. Deleting a task definition does not erase its retained completion record.
Current titles and Home/Work context follow their source records; this is a view
of recorded accomplishments, not an immutable historical rendering of every label.
**Open history** reaches the existing per-record history and requires connection.
Source links open the ordinary screens, where existing edits, photos and undo apply.

## Visibility and offline behavior

Every row and joined parent is checked against the current profile's scopes.
Joined records must have matching visibility. Shared filters, search, visible
counts and notes/photos exclude private records. Profile changes remount the view,
reset its filters and remove the previous profile's rendered contents. This uses
the existing trusted-network profile-selection model.

Activity metadata and notes use the ordinary coherent read cache offline. The
screen labels offline data explicitly. Photos use the existing platform media
behavior: Android retains a bounded cache of viewed photos; browser server-photo
URLs generally require connectivity after reload. Missing photos show **Photo
unavailable**, while their captions remain visible. Opening a note/photo disclosure
loads its photos; collapsed rows do not eagerly download their image bytes. This
feature introduces no new media-retention promise or background photo downloader.

## Verification

Five pure projection tests cover actual dates/performers, non-mutation, compound
records, private search/count isolation, invalid cross-scope relationships,
deletion/undo, unknown performers and combined filters.

The browser fixture uses real commands to create purchases, private gifts,
Home/Work tasks, standalone records and linked cooking/maintenance completions.
The activity flows verify profile changes, midnight/time-zone grouping, source
navigation, undo/redo, photos and offline status, unfinished inbox text, and
320/390/820/1440-pixel layouts. Seven related task/inbox-filing browser flows also
pass. The production Linux image passes all 221 package tests. Typechecking,
package boundaries, production builds and fourteen Android unit tests pass.

In-place replacement of the previous APK on the dedicated emulator preserves its
session, cached records, photo captures and editor text. The native activity flow
then verifies filters, actual performers, private gifts disappearing on profile
switch, Android Back, and cached notes/photos with the fixture server shut down.
The second profile downloads the test photo, proving this does not rely on the
first profile's captured original. All fixtures are synthetic and isolated from
the live household. Final deployment evidence follows publication.
