# Browser navigation history

Browser Back and Forward traverse main screens, selected records, note tabs,
editors, history panels, photo viewers, and agenda/navigation settings editors.
Normal browser shortcuts use the same history. Closing a panel is also a step.
Editing text does not add history entries and traversal never replays commands.

`NavigationHistory.tsx` stores opaque random tokens in browser history. Up to
200 navigation snapshots remain in page memory; form text remains in the existing
profile-scoped draft storage. Profile or server-epoch changes invalidate snapshots.
Reloaded, expired, or unknown tokens fall back to the URL's safe initial screen;
note URLs still use the existing authorized lookup. Internal navigation preserves
calendar connection/settings query parameters. Android retains native Back handling
and does not create browser history entries.

Use `useNavigationState` only for panel selectors and record IDs. Resolve records
from the current authorized snapshot, rather than retaining record objects. Keys
must distinguish simultaneously mounted panels and historical photo galleries.
Editors register their write queues with `useNavigationFlush`. Traversal waits for
queued saves, including writes added while an earlier save is pending. Failed
storage keeps the current editor mounted. Existing frozen capture requests and
server revision checks remain authoritative.

Focused verification (synthetic browser fixture with temporary databases):

- `navigation-history.spec.ts`: all eight tests, including delayed writes during
  Back/Forward and linked-note navigation, failed storage, independent capture
  drafts, profile boundaries, reload fallback, deep links and calendar query values.
- `note-links.spec.ts`, `links.spec.ts`, `record-sharing.spec.ts`: all seven tests.
- `tasks.spec.ts`, `home.spec.ts`, `projects.spec.ts`, `shopping.spec.ts`,
  `food.spec.ts`, `attachments.spec.ts` with grep
  `forms survive|drafts survive|editor buffers|private boards|unfinished blocks|pinned task|photo edits|database migration|recipe cooking tasks`:
  ten tests. Includes real project-to-task Back/Forward and historical photo
  viewer Back/Forward, draft recovery, frozen captures and private-profile checks.
- `calendars.spec.ts` with grep `calendar consent|switching profiles before`:
  two tests covering consent return and profile isolation.
- Web TypeScript check and production web build (for browser fixtures), package
  boundary check, staged public-source audit, indexed manifest and whitespace checks.

Full regression suites, Android runtime checks and distribution builds belong to
combined release verification. This change does not deploy or migrate live data.
