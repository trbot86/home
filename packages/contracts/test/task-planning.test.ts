import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyTasks, type TaskOccurrence, type TaskDefinition, type TaskCompletion } from '../src/tasks.js';
import { planningGroups, taskCalendarEntries } from '../src/task-planning.js';
import { Value } from '@sinclair/typebox/value';
import { NavigationOrder, navigationSections, completeNavigationOrder } from '../src/views.js';

test('legacy navigation orders gain Calendar beside Agenda without invalidating frozen requests', () => {
  const legacy = navigationSections.filter((section) => section !== 'calendar');
  assert.equal(Value.Check(NavigationOrder, legacy), true);
  const current = completeNavigationOrder(legacy);
  assert.equal(current[current.indexOf('agenda') + 1], 'calendar');
  assert.equal(Value.Check(NavigationOrder, current), true);
  assert.deepEqual(completeNavigationOrder(current), current);
  assert.equal(
    Value.Check(
      NavigationOrder,
      current.filter((section) => section !== 'tasks'),
    ),
    false,
  );
  assert.equal(Value.Check(NavigationOrder, [...legacy.slice(1), legacy[1]]), false);
});
const base = { revision: 1, createdAt: 0, updatedAt: 0, scopeId: 'scope', deletedAt: null };
const task: TaskDefinition = {
  ...base,
  recordId: 'task',
  kind: 'task',
  title: 'Plan',
  instructions: '',
  context: 'home',
  defaultAssigneeId: null,
  defaultPriority: 1,
  recurrence: null,
};
const occurrence: TaskOccurrence = {
  ...base,
  recordId: 'occ',
  kind: 'task_occurrence',
  taskId: 'task',
  ordinal: 1,
  state: 'open',
  assigneeId: null,
  priority: 1,
  deadlineDate: null,
  targetDate: null,
  reviewDate: null,
};
test('planning buckets use civil week/month boundaries, dates precede approximate tasks and privacy filters remain', () => {
  const s = emptyTasks();
  s.definitions = [task];
  s.occurrences = [
    { ...occurrence, recordId: 'asap', approximateDate: 'asap' },
    { ...occurrence, recordId: 'today', targetDate: '2026-09-29' },
    { ...occurrence, recordId: 'week', approximateDate: 'week' },
    { ...occurrence, recordId: 'oct', targetDate: '2026-10-02' },
    { ...occurrence, recordId: 'other', assigneeId: 'other', approximateDate: 'asap' },
  ];
  const g = planningGroups(s, 'me', 'home', '2026-09-29');
  assert.deepEqual(
    g[0]!.dated.map((x) => x.occurrence.recordId),
    ['today'],
  );
  assert.deepEqual(
    g[0]!.undated.map((x) => x.occurrence.recordId),
    ['asap'],
  );
  assert.deepEqual(
    g[1]!.dated.map((x) => x.occurrence.recordId),
    ['oct'],
  );
  assert.equal(g[1]!.undated[0]!.occurrence.recordId, 'week');
  assert.equal(
    planningGroups(s, 'me', 'work', '2026-09-29').flatMap((g) => [...g.dated, ...g.undated]).length,
    0,
  );
});
test('calendar folds same-day completion, retains different planned day and includes hidden or approximate completions', () => {
  const s = emptyTasks();
  s.definitions = [task];
  s.occurrences = [{ ...occurrence, state: 'completed', targetDate: '2026-09-29' }];
  const completion: TaskCompletion = {
    ...base,
    recordId: 'done',
    kind: 'task_completion',
    occurrenceId: 'occ',
    completedAt: Date.parse('2026-09-30T01:00:00Z'),
    performedByPersonId: 'me',
    performerName: 'Me',
    note: '',
    ruleRevision: 1,
    recurrence: null,
    nextOccurrenceId: null,
  };
  s.completions = [completion];
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 1);
  assert.equal(taskCalendarEntries(s, 'me', 'both')[0]!.completed, true);
  s.occurrences[0]!.targetDate = '2026-09-28';
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 2);
  s.occurrences[0]!.calendarVisible = false;
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 1);
  s.occurrences[0]!.calendarVisible = true;
  s.occurrences[0]!.targetDate = null;
  s.occurrences[0]!.approximateDate = 'week';
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 1);
  s.occurrences[0]!.state = 'open';
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 0);
  s.occurrences[0]!.state = 'completed';
  s.completions[0]!.deletedAt = 1;
  assert.equal(taskCalendarEntries(s, 'me', 'both').length, 0);
});
