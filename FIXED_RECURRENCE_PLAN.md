# Fixed calendar recurrence: design checkpoint

Status: calendar arithmetic implemented and tested; the feature is not deployed.
The late-reporting choice below is awaiting household input. Existing recurrence
remains based on actual completion. This pass is grounded in the current Tasks
contracts, repository, editor and published migration 005; migrations 001 through
021 remain immutable.

`nextAnchoredCalendarDate` in `packages/contracts/src/calendar-date.ts` finds the
first daily, weekly or monthly slot after an explicit cutoff. It is independent
of the pending late-reporting policy and does not read the clock. Five new tests
cover anchor/interval behavior, February and leap-year recovery, the supported
date range, invalid inputs and timezone-derived cutoffs. The full package suite
passes 229 tests on Windows, with one existing platform-specific socket test
skipped. Type checks and package-boundary checks pass. No schema, command or UI
has changed; those parts below remain proposed.

## Behavior and the remaining choice

A fixed schedule keeps its calendar pattern when a chore is completed late or
its current target is postponed. Keep one open occurrence, as in PLANNING.md.
Passing a scheduled date does not create another record or claim completion.

The initial patterns can use the existing interval count and days/weeks/months,
plus an anchor date. Every week from a Wednesday means Wednesdays; every two
weeks preserves alternating weeks. Monthly dates clamp independently from the
anchor: January 31, February 28, March 31. Adding a month to the previously clamped
February date would incorrectly drift to March 28.

One product choice remains: which elapsed slots to skip when work is recorded
well after it happened? For a Wednesday chore scheduled September 9, completed
September 10 and recorded September 21, 2026:

| Policy                                       | Next target  | Consequence                                                               |
| -------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Coalesce through recording day (recommended) | September 23 | Keep the next upcoming Wednesday; elapsed slots are not outstanding work. |
| Coalesce through actual completion day       | September 16 | Retain one outstanding occurrence, already ready to do.                   |

Both preserve the Wednesday pattern and record September 10 as the actual work.
Neither creates a completion for an elapsed slot. After-completion recurrence
continues to use actual completion, regardless of this choice.

## Separate the scheduled slot from the flexible target

Extend occurrence content with nullable `scheduledDate`. It describes the slot
that this occurrence represents; `targetDate` remains editable and postponable.
Deadlines and review dates keep their existing meanings. Do not infer the slot
from a mutable target or use ordinal as a slot number: skipped calendar slots
and historical tombstones already make those concepts different.

On fixed-schedule creation, set the first occurrence's scheduled date to the
anchor. Default its target to that date while retaining an explicitly chosen
target. The editor must make the resulting first target visible before saving.
After-completion and one-off occurrences have no fixed scheduled date.

Postponing Wednesday's target to Friday keeps Wednesday as its scheduled slot.
Completing it Thursday produces the next Wednesday. Completing it early on
Tuesday also produces the next Wednesday, rather than recreating the slot just
completed. With the recommended policy, the calculation finds the first slot
strictly after the latest of:

- The occurrence's scheduled date, if it has one.
- Actual completion converted into a civil date in the recurrence timezone.
- Recording time converted into that same timezone.

The alternative omits recording time. The anchor establishes the earliest slot;
no calculation produces dates before it. The editable target does not determine
the next slot. The next target initially equals the calculated scheduled date.

Changing a definition's schedule affects future occurrences and preserves the
current occurrence's slot, dates, assignment and priority. Explain this beside
the editor controls. This includes changing from fixed to after-completion or
vice versa: the new mode determines the next occurrence, while the current one
remains identifiable. Existing completion snapshots retain the rule used when
that completion was recorded. Do not silently reschedule current work as a side
effect of a title or recurrence edit.

## Contracts, storage and command boundaries

Use a discriminated recurrence union. Keep the existing version 1
`after_completion` shape intact. A fixed variant adds its validated anchor date
and retains count, unit and timezone. Avoid arbitrary recurrence-language strings
or a second scheduling engine. More complex patterns can be explicit later
variants when there is a concrete need.

One pure recurrence module owns validation and next-date arithmetic. Both the
completion preview and server command use it; the server is authoritative.
Calendar dates remain civil dates, not instants at midnight in an assumed zone.
Avoid walking every skipped day to find a distant next slot. Bound all arithmetic
by the supported calendar range and reject overflow before changing records.

A subsequent migration must rebuild `task_recurrences` to replace its current
`mode='after_completion'` CHECK, copy existing rules unchanged, and add the
nullable occurrence column. Use explicit SQL column lists in the repository;
current positional INSERTs cannot safely survive the added columns. No other
table references `task_recurrences` in the current schema, but confirm this
against the final migration set before writing the migration.

Make the new occurrence field optional for old wire snapshots and retained
history, normalizing absence to null at the adapter boundary. Do not rewrite
journal entries, old receipts or queued request payloads. History projection,
undo comparisons and redo must all use the same normalization.

CompleteTaskOccurrence continues to require task and occurrence revisions and
the existing stable completion/next-occurrence IDs. Within its current single
transaction it records the performer and actual time, closes the old occurrence,
creates the next one, and records linked maintenance or cooking work. A duplicate
request returns its receipt and original next date even if retried on another
day. Undo/redo restores the stored schedule decision; it does not recalculate
using today's clock. Editing the generated occurrence still guards reversal.

## Older phone editors need a write guard

The currently deployed editor constructs `mode: 'after_completion'` whenever a
recurrence exists. Merely adding fixed rules to the server would let an older
APK silently replace one while saving an unrelated title edit.

Add an optional expected recurrence mode to UpdateTaskDefinition. New editors
send the mode they loaded, alongside the existing expected revision. When the
current rule is fixed, require this field and a matching mode before allowing a
definition update. A legacy writer receives a specific update-required rejection
without changing the task. Existing writes to one-off or after-completion tasks
retain their compatibility. Validate any supplied expected mode against the
current definition even when it is not fixed.

The field is a compatibility precondition, not domain content; exclude it when
copying command fields into the task. Ordinary occurrence edits, postponement
and completion do not replace the rule and can retain their existing command
shapes. An older client can still label a fixed rule inaccurately, so distribute
the updated APK with the feature and keep its installation step explicit.

## Interface and verification

Offer Does not repeat, After completion and Fixed schedule, with interval and
anchor controls when relevant. Preserve existing saved editor buffers: a missing
mode means after-completion for an old repeat draft. New buffers must retain
mode, anchor and the loaded compatibility precondition across reloads and APK
updates. An old saved buffer cannot authorize replacing a newer fixed rule.

Task cards, task history and the completion dialog must distinguish the two
modes. The current completion copy promises that all repetition follows actual
work; revise it for fixed schedules. Show a next-date preview and explain skipped
slots without claiming that they were completed. Make the preview conditional on
the selected late-reporting policy; crossing a household midnight before commit
can change a recording-day-based result.

Required checks before release:

- Anchored weekly and alternating-week schedules, early/late/backdated completion,
  timezone date boundaries, month-end/leap-year behavior and range overflow.
- Target postponement independent of phase; definition changes independent of
  the current occurrence; transition between recurrence modes.
- Receipt replay across dates, competing completions, atomic rollback, linked
  service/cooking records and guarded undo/redo after partner edits.
- Old editor rejection without data loss; legacy after-completion commands,
  history, request receipts and unfinished buffers remain usable.
- Browser and native editor/preview flows, Ctrl+Enter, offline cached reading,
  in-place APK preservation and small-screen layout.
- Restore a fresh backup into an isolated location, migrate it, compare existing
  data and identity, and verify foreign keys before the live upgrade. Verify an
  independent secondary backup and deploy through the existing upgrade command.

Multiple weekdays, nth-weekday rules, time-of-day reminders and an explicit Skip
command remain separate extensions. A completion must never substitute for Skip.
