import { calendarDateAt, addCalendarDate } from './calendar-date.js';
import { openTasks, compareOpenTasks, type OpenTask } from './task-views.js';
import type { TaskSnapshot, TaskOccurrence, TaskDefinition } from './tasks.js';
export const approximateLabels = { asap: 'ASAP', week: 'This week', month: 'This month' } as const;
export const taskCalendarDate = (o: TaskOccurrence) =>
  o.approximateDate ? null : (o.targetDate ?? o.deadlineDate ?? o.reviewDate);
export function planningGroups(snapshot: TaskSnapshot, personId: string, context: string, today: string) {
  const weekEnd = addCalendarDate(today, 7, 'days');
  const monthEnd = addCalendarDate(today.slice(0, 7) + '-01', 1, 'months');
  const labels = ['Today / ASAP', 'Next 7 days', 'This month', 'Later', 'Anytime'];
  const groups = labels.map((label) => ({ label, dated: [] as OpenTask[], undated: [] as OpenTask[] }));
  for (const item of openTasks(snapshot)) {
    const o = item.occurrence;
    if ((context !== 'both' && item.task.context !== context) || (o.assigneeId && o.assigneeId !== personId))
      continue;
    const date = [o.deadlineDate, o.targetDate, o.reviewDate].filter((d): d is string => !!d).sort()[0];
    const bucket = date
      ? date <= today
        ? 0
        : date <= weekEnd
          ? 1
          : date < monthEnd
            ? 2
            : 3
      : o.approximateDate === 'asap'
        ? 0
        : o.approximateDate === 'week'
          ? 1
          : o.approximateDate === 'month'
            ? 2
            : 4;
    groups[bucket]![date ? 'dated' : 'undated'].push(item);
  }
  for (const g of groups) {
    g.dated.sort(
      (a, b) =>
        (
          [a.occurrence.deadlineDate, a.occurrence.targetDate, a.occurrence.reviewDate]
            .filter(Boolean)
            .sort()[0] ?? ''
        ).localeCompare(
          [b.occurrence.deadlineDate, b.occurrence.targetDate, b.occurrence.reviewDate]
            .filter(Boolean)
            .sort()[0] ?? '',
        ) || compareOpenTasks(a, b),
    );
    g.undated.sort(compareOpenTasks);
  }
  return groups;
}
export type TaskCalendarEntry = {
  day: string;
  task: TaskDefinition;
  occurrence: TaskOccurrence;
  completed: boolean;
  completionOnly: boolean;
};
export function taskCalendarEntries(
  snapshot: TaskSnapshot,
  personId: string,
  context: string,
): TaskCalendarEntry[] {
  const definitions = new Map(
    snapshot.definitions.filter((t) => t.deletedAt === null).map((t) => [t.recordId, t]),
  );
  const completions = new Map(
    snapshot.completions.filter((c) => c.deletedAt === null).map((c) => [c.occurrenceId, c]),
  );
  const entries: TaskCalendarEntry[] = [];
  for (const occurrence of snapshot.occurrences) {
    const task = definitions.get(occurrence.taskId);
    if (
      !task ||
      occurrence.deletedAt !== null ||
      occurrence.state === 'cancelled' ||
      (context !== 'both' && task.context !== context) ||
      (occurrence.assigneeId && occurrence.assigneeId !== personId)
    )
      continue;
    const completion = occurrence.state === 'completed' ? completions.get(occurrence.recordId) : undefined;
    const completedDay = completion ? calendarDateAt(completion.completedAt, snapshot.timeZone) : null;
    const planned = occurrence.calendarVisible !== false ? taskCalendarDate(occurrence) : null;
    if (planned)
      entries.push({
        day: planned,
        task,
        occurrence,
        completed: completedDay === planned,
        completionOnly: false,
      });
    if (completedDay && completedDay !== planned)
      entries.push({ day: completedDay, task, occurrence, completed: true, completionOnly: true });
  }
  return entries.sort((a, b) => a.day.localeCompare(b.day) || a.task.title.localeCompare(b.task.title));
}
