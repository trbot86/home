import type { TaskDefinition, TaskOccurrence, TaskSnapshot } from '@our-place/contracts';
export type TaskAttention = 'overdue' | 'today' | 'priority' | 'ready' | 'review' | 'upcoming' | 'anytime';
export type OpenTask = { task: TaskDefinition; occurrence: TaskOccurrence };
export function openTasks(snapshot: TaskSnapshot): OpenTask[] {
  const definitions = new Map(
    snapshot.definitions.filter((task) => task.deletedAt === null).map((task) => [task.recordId, task]),
  );
  return snapshot.occurrences
    .filter((item) => item.deletedAt === null && item.state === 'open')
    .flatMap((occurrence) => {
      const task = definitions.get(occurrence.taskId);
      return task ? [{ task, occurrence }] : [];
    });
}
export function taskAttention(item: TaskOccurrence, today: string): TaskAttention {
  if (item.deadlineDate && item.deadlineDate < today) return 'overdue';
  if (item.deadlineDate === today) return 'today';
  if (item.priority >= 2) return 'priority';
  if (item.reviewDate && item.reviewDate <= today) return 'review';
  if (item.targetDate && item.targetDate <= today) return 'ready';
  if (item.deadlineDate || item.targetDate || item.reviewDate) return 'upcoming';
  return 'anytime';
}
export function compareOpenTasks(a: OpenTask, b: OpenTask): number {
  return (
    b.occurrence.priority - a.occurrence.priority ||
    (
      a.occurrence.deadlineDate ??
      a.occurrence.targetDate ??
      a.occurrence.reviewDate ??
      '9999-12-31'
    ).localeCompare(
      b.occurrence.deadlineDate ?? b.occurrence.targetDate ?? b.occurrence.reviewDate ?? '9999-12-31',
    ) ||
    a.task.createdAt - b.task.createdAt ||
    a.task.recordId.localeCompare(b.task.recordId)
  );
}
