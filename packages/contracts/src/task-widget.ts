import { taskCalendarEntries } from './task-planning.js';
import { calendarDateAt } from './calendar-date.js';
import { openTasks, taskAttention, compareOpenTasks, type TaskAttention } from './task-views.js';
import type { TaskSnapshot } from './tasks.js';

export type TaskWidgetRow = {
  taskId: string;
  occurrenceId: string;
  scopeId: string;
  title: string;
  context: 'home' | 'work';
  attention: TaskAttention;
  deadlineDate: string | null;
  targetDate: string | null;
  reviewDate: string | null;
};
/** Read model for native surfaces; never a command or an additional authority store. */
export type TaskWidgetSnapshot = {
  version: 1;
  personId: string;
  timeZone: string;
  date: string;
  sampledAt: number;
  rows: TaskWidgetRow[];
  calendarTasks: {
    occurrenceId: string;
    scopeId: string;
    context: 'home' | 'work';
    title: string;
    day: string;
    completed: boolean;
  }[];
};
const order: TaskAttention[] = ['overdue', 'today', 'priority', 'ready', 'review', 'upcoming', 'anytime'];
export function taskWidgetSnapshot(
  snapshot: TaskSnapshot,
  personId: string,
  scopeIds: readonly string[],
  now: number,
): TaskWidgetSnapshot {
  const date = calendarDateAt(now, snapshot.timeZone),
    allowed = new Set(scopeIds);
  const rows = openTasks(snapshot)
    .filter(
      ({ task, occurrence }) =>
        allowed.has(task.scopeId) &&
        occurrence.scopeId === task.scopeId &&
        (occurrence.assigneeId === null || occurrence.assigneeId === personId),
    )
    .sort(
      (a, b) =>
        order.indexOf(taskAttention(a.occurrence, date)) - order.indexOf(taskAttention(b.occurrence, date)) ||
        compareOpenTasks(a, b),
    )
    .map(({ task, occurrence }): TaskWidgetRow => ({
      taskId: task.recordId,
      occurrenceId: occurrence.recordId,
      scopeId: task.scopeId,
      title: task.title,
      context: task.context,
      attention: taskAttention(occurrence, date),
      deadlineDate: occurrence.deadlineDate,
      targetDate: occurrence.targetDate,
      reviewDate: occurrence.reviewDate,
    }));
  const calendarTasks = taskCalendarEntries(snapshot, personId, 'both')
    .filter(({ task, occurrence }) => allowed.has(task.scopeId) && occurrence.scopeId === task.scopeId)
    .map(({ task, occurrence, day, completed }) => ({
      occurrenceId: occurrence.recordId,
      scopeId: task.scopeId,
      context: task.context,
      title: task.title,
      day,
      completed,
    }));
  return { version: 1, personId, timeZone: snapshot.timeZone, date, sampledAt: now, rows, calendarTasks };
}
