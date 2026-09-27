import type { RecipeFields } from '@our-place/contracts';

/** Keep source text in storage, but present parsed durations in everyday units. */
export function recipeDuration(value: RecipeFields['totalTime']): string {
  if (value.minutes === null) return value.text;
  const seconds = Math.round(value.minutes * 60);
  const days = Math.floor(seconds / 86400),
    hours = Math.floor((seconds % 86400) / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remainder = seconds % 60;
  return (
    [
      days ? `${days} ${days === 1 ? 'day' : 'days'}` : '',
      hours ? `${hours} hr` : '',
      minutes ? `${minutes} min` : '',
      remainder ? `${remainder} sec` : '',
    ]
      .filter(Boolean)
      .join(' ') || '0 min'
  );
}
