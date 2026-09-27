import test from 'node:test';
import assert from 'node:assert/strict';
import { taskWidgetSnapshot, emptyTasks, type TaskDefinition, type TaskOccurrence } from '../src/index.js';

test('widget read model shares task attention ordering, keeps date meanings and excludes other people', () => {
  const snapshot = emptyTasks();
  function row(id: string, changes: Partial<TaskOccurrence> = {}, taskChanges: Partial<TaskDefinition> = {}) {
    snapshot.definitions.push({
      recordId: id,
      kind: 'task',
      scopeId: 'shared',
      title: id,
      instructions: 'Keep this out of the widget projection',
      context: 'home',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      revision: 1,
      defaultAssigneeId: null,
      defaultPriority: 1,
      recurrence: null,
      ...taskChanges,
    });
    snapshot.occurrences.push({
      recordId: id + '-occurrence',
      kind: 'task_occurrence',
      taskId: id,
      scopeId: 'shared',
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      revision: 1,
      state: 'open',
      ordinal: 1,
      assigneeId: null,
      priority: 1,
      deadlineDate: null,
      targetDate: null,
      reviewDate: null,
      ...changes,
    });
  }
  row('anytime');
  row('target', { targetDate: '2026-09-25' });
  row('review', { reviewDate: '2026-09-25' });
  row('priority', { priority: 3 });
  row('deadline', { deadlineDate: '2026-09-26' });
  row('today', { deadlineDate: '2026-09-27' });
  row('upcoming', { targetDate: '2026-09-28' });
  row('partner', { assigneeId: 'partner' });
  row('deleted', {}, { deletedAt: 3 });
  row('completed', { state: 'completed' });
  row('secret', { scopeId: 'other-private' }, { scopeId: 'other-private' });
  row(
    'mine',
    { assigneeId: 'me', scopeId: 'my-private', priority: 2 },
    { scopeId: 'my-private', context: 'work' },
  );
  row('broken-scope', { scopeId: 'other-private' });
  const now = Date.parse('2026-09-27T15:00:00Z');
  const result = taskWidgetSnapshot(snapshot, 'me', ['shared', 'my-private'], now);
  assert.equal(result.date, '2026-09-27');
  assert.equal(result.personId, 'me');
  assert.equal(result.sampledAt, now);
  assert.deepEqual(
    result.rows.map((r) => r.taskId),
    ['deadline', 'today', 'priority', 'mine', 'target', 'review', 'upcoming', 'anytime'],
  );
  assert.equal(result.rows.find((r) => r.taskId === 'target')!.attention, 'ready');
  assert.equal(result.rows.find((r) => r.taskId === 'review')!.attention, 'review');
  assert.equal(result.rows.find((r) => r.taskId === 'mine')!.context, 'work');
  assert.ok(!JSON.stringify(result).includes('instructions'));
  // The civil day follows the household zone, not UTC or the rendering device.
  assert.equal(
    taskWidgetSnapshot(snapshot, 'me', ['shared'], Date.parse('2026-09-27T02:00:00Z')).date,
    '2026-09-26',
  );
  assert.deepEqual(taskWidgetSnapshot(snapshot, 'me', [], now).rows, []);
});
