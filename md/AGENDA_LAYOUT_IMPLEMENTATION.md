# Personal agenda layouts

Each person can choose the agenda sections, their order and item limits, and
save a default Home/Work filter and seven- or thirty-day calendar range.
The initial layout shows personal tasks and calendar events. Make-soon recipes
and project priorities are optional Home sections. Hiding every section is
allowed and leaves the customisation control available.

## Ownership and persistence

`AgendaLayout` is a versioned presentation contract. All four known section
kinds occur exactly once; each has an enabled flag and a limit from 1 to 100.
`SetAgendaLayout` updates one `saved_views` row in the current person's private
scope. It checks the view revision and uses the normal immutable operation
receipt transaction. It produces no content changeset and does not revise
tasks, recipes, projects or their histories. Another profile cannot read or
change this preference. Home/Work filtering never grants access to content.

Migration020 extends the existing saved-view table while retaining row IDs,
pins, typed project references and all old columns. The migration runner's
reviewed rebuild path checks foreign keys before committing and restores
foreign-key enforcement after either success or failure. Earlier migrations
remain immutable.

Web and Android already cache authorised saved views with their coherent
household snapshot. No new local database or Android Room migration is needed.
Existing installed clients can retain the new view variant without using it;
the new interface requires updated assets. The initial defaults are computed
without inserting preference rows for either person.

## Editor and retry behaviour

The existing durable form buffer stores unfinished changes locally. Closing
the dialog, Android Back and reload preserve it, including an empty numeric
field. An unreadable draft offers explicit discard-and-load recovery without
changing the server preference. Ctrl/Cmd+Enter submits a valid connected form.
Offline drafts remain editable; saving requires connection.

After submission, the existing command queue freezes edits until the outcome
is known. Explicit retry remains available after a network failure and reuses
the frozen operation. A reconciled successful snapshot closes the editor
without another update. A different device's edit causes revision rejection;
the draft stays visible until the user loads the current layout. Restoring
defaults changes the draft only until Save is pressed.

## Section boundaries

Each panel derives from the current authorised cache. Tasks show open work
assigned to the person or unassigned that needs attention today. Deadline,
target and review dates keep their separate meanings. Recipe cards open the
existing recipe; project priorities open the original board or pinned record.
Deleted targets and archived projects/recipes are omitted, with pins retained
for restoration. Item limits affect rendering, not the downloaded data.

Calendar limits count displayed event entries across the selected days; a
multi-day event can contribute an entry to more than one day. Show-more controls
expand recipes, priorities and events without changing the saved default.
The task panel links to the full Tasks section. Temporary agenda filters do
not change saved defaults.

## Verification

- Server tests cover profile isolation, stale writes, frozen request replay,
  atomic receipt failure and invalid layout rejection.
- Migration tests compare every existing table's old columns, retain Food
  and project pins, replay old receipts and exercise undo after upgrading.
  Injected SQL and foreign-key failures roll back the entire rebuild.
- Browser tests exercise multi-device preference sync, profile privacy,
  offline drafts, lost replies, stale edits, unreadable draft recovery,
  hidden sections, item limits, ordering and recipe/project navigation at
  desktop, tablet and narrow phone widths.
- `scripts/verify-android-agenda-layout.mjs` targets only the dedicated test
  emulator and a disposable server fixture. It checks native-to-browser
  sync, profile separation, Android Back and offline Room persistence.

Google account setup remains separate from layout preferences. This feature
does not enable notifications, edit external calendars or change gift access.
