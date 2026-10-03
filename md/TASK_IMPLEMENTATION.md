# Tasks, actual completion and personal overview

Implemented and deployed 2026-09-26, following the Shopping release. This follows
md/DATA_MODEL.md and md/APPLICATION_CONTRACTS.md; it does not replace their wider plan.
No additional household input is needed for the bounded work below.

## Calendar and approximate planning

Migration036 adds occurrence-level calendar visibility (default on) and optional
ASAP, this-week or this-month timing. Approximate timing replaces a target date;
it does not manufacture a calendar date. A real deadline or review date remains
independent. Old requests omit the new fields safely, and old navigation layouts
gain Calendar immediately after Agenda without discarding their custom order.

Agenda groups tasks into Today / ASAP, Next 7 days, This month, Later and Anytime.
The seven-day window runs from tomorrow through today plus seven days, including
across month boundaries; months use calendar boundaries. Approximate This week
tasks appear in Next 7 days without acquiring an invented date. Dated tasks
precede undated tasks in each group. Important priorities use coloured tags.

Calendar shows a month selector and the selected day's tasks and external events.
An occurrence has one planned calendar date: target, otherwise deadline, otherwise
review. Approximate occurrences and occurrences with calendar visibility disabled
have no planned entry. Every visible completed occurrence has an entry on its
actual completion day in the household time zone, regardless of those settings.
Same-day planned and completed entries fold together; completion on another day
retains the planned entry and adds the checkmarked completion. Task visibility and
Home/Work filtering remain enforced.

History and undo include both new fields. Recurrence inherits calendar visibility
and gives the next occurrence its calculated target date. Contract, server and
browser tests cover grouping, same-day folding, old requests, recurrence, undo,
navigation compatibility and narrow layouts.

## Release evidence

Migration005 is published and immutable. Tasks, occurrences and completions use
static record adapters and a typed command-handler registry. Derived live flags
support partial unique indexes; inverse writes release the next occurrence's
open slot before reopening the previous occurrence.

40 server and five contract tests pass in the Linux image. Nine browser flows
pass, including Tasks at 320/390/820/1440px, draft recovery, lost replies, privacy,
offline reading and completion undo/redo. Five Android unit tests pass.
`scripts/verify-android-tasks.mjs` verifies native creation, dates, actual
completion, recurrence, performer, undo, history, drafts, Back and Room cache.

The upgrade preserved existing records and installation/epoch. No synthetic data
was inserted. A verified export was copied to the independent secondary location
and restored into an isolated directory; schema and foreign-key checks passed.
Exact release identities, addresses and reports remain in ignored local storage.
Live assets and the privately distributed APK matched the tested build.
Physical-phone confirmation of these screens remains an ordinary-use check.

## First usable outcome

- Create/edit/delete shared or private tasks with a title, instructions, home/work
  context, optional assignee and priority. Private tasks can be assigned only to
  their owner. Undated tasks remain useful without a manufactured due date.
- Keep deadline, flexible target and review date separate. Show a date picker and
  quick postponement by one day, one week, two weeks or one month. Postponement
  changes the selected target/review date; it never silently moves a deadline.
- Record actual completion time, performer and notes. Distinguish when work
  happened from when it was recorded. A replacement purchase is not completion.
- Support one-off tasks and recurrence after actual completion (days, weeks,
  months). Keep fixed-calendar recurrence as a subsequent feature: its proposed
  missed-slot/coalescing policy has not yet been accepted by the user.
- Personal and household views filter Home/Work/Both, person and state. Group
  genuine missed deadlines separately from flexible work ready to do, review
  dates, priorities and upcoming work. A compact completion feed supplies credit.
- Reuse history, guarded undo, pending request resolution, editor buffers and
  read-only offline cache. Inbox stays available for offline capture.

## Connected records

Add migration005 only after migration004; never rewrite the deployed migrations.

`tasks` is a registered root containing title, instructions, context, default
assignee and default priority. Its optional `task_recurrences` row is task-owned
content with a versioned after-completion rule, count, unit and IANA timezone.

`task_occurrences` is a separate registered root with same-scope task FK, ordinal,
open/completed/cancelled state, current assignee/priority and separate nullable
deadline/target/review dates. One-off tasks also have an occurrence. Enforce one
live open occurrence per task and stable unique ordinals. Historical/tombstoned
ordinals are not reused; occurrence changes do not edit definition defaults.

`task_completions` is a registered root with same-scope occurrence FK, actual
completion instant, performer, display-name snapshot and notes. At most one live
completion belongs to an occurrence. Author/recording time comes from history;
performer may differ when one person records work done by the other. Completed
occurrence state and a live completion must agree at transaction commit.

Task attachments, asset records and maintenance-plan extensions follow this first
task slice. Keep those explicit feature boundaries; do not encode asset, recipe,
shopping or project IDs in freeform JSON/text as hidden relationships.

## Commands and transactions

Use a Tasks repository with static adapters for the three roots. Extend the
existing WriteCoordinator with typed commands; no nested transactions or second
idempotency receipt store. Extract handler routing if the next feature makes the
coordinator's existing constructor/dispatch materially harder to follow.

1. CreateTask creates the definition and first open occurrence in one changeset.
2. UpdateTaskDefinition requires its revision; occurrence edits require theirs.
   Treat recurrence as definition-owned content and retain its prior rule in
   history. Do not rewrite existing completions.
3. PostponeTaskOccurrence takes the explicit new date and selected target/review
   field. UI presets calculate a visible date; retries contain the same date.
4. CompleteTaskOccurrence requires task and occurrence revisions. Write the
   completion and close the occurrence, then create the next occurrence under an
   after-completion rule in the same transaction. The server validates the rule
   and calculates from actual completion in its timezone, even when the result
   is already in the past. Calendar-month addition clamps to month end.
5. DeleteTask closes its open occurrence atomically; retain historical work.
   Restore cannot silently recreate conflicting open occurrences.
6. Undo of completion reverses every created/changed root together and rejects
   if a relevant next occurrence has been edited or completed. Do not implement
   arbitrary cascading historical correction under the name Undo.

Date-only fields use validated ISO civil dates, not midnight UTC timestamps.
Actual completion uses an instant. Centralise civil-date/recurrence calculations
and test leap years, month end, timezone boundaries and late reporting. Begin
with the configured household timezone (America/Toronto for this deployment).

## Verification and rollout

Tests must cover competing completions, stale definition/occurrence revisions,
multi-record rollback, lost replies and retries, after-completion calculations,
private scope/assignment, postponed dates versus deadlines, and guarded undo
after a partner touches the next occurrence. Test migration preservation against
an existing shopping purchase/history fixture.

Browser/native checks cover Ctrl+Enter, date pickers, postponement, actual-time
entry, personal filters, small-screen layout, dialog Back, saved editor text and
offline read access. Add Tasks to the existing snapshot while retaining the old
cache endpoint for installed phones. Upgrade only through the verified-backup
workflow, compare live data before/after, publish a batched APK and verify the secondary disk.

Notifications, calendar connectors, fixed-calendar catch-up, maintenance assets
and completion corrections beyond guarded undo remain distinct follow-on work.
Do not show a working reminder toggle until a delivery channel actually exists.
