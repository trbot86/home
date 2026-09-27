import type { CommandKind, CommandOutcome, TaskSnapshot, TaskRecord } from '@our-place/contracts';
export type TaskRun = (
  target: { recordId: string },
  kind: CommandKind,
  args: unknown,
  label: string,
  epoch?: string,
) => Promise<CommandOutcome | null>;
export const taskRecords = (snapshot: TaskSnapshot): TaskRecord[] => [
  ...snapshot.definitions,
  ...snapshot.occurrences,
  ...snapshot.completions,
];
export const priorityNames = ['No priority', 'Normal', 'Important', 'Top priority'];
export const displayDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
export function localDateTime(instant: number): string {
  const date = new Date(instant),
    pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
