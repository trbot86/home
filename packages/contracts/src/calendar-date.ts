/** Civil dates have no UTC offset. Convert an instant only at an explicit timezone boundary. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}
export function calendarDateAt(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  const value = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  if (!isCalendarDate(value)) throw new RangeError('Calendar date is outside the supported range');
  return value;
}
export type CalendarUnit = 'days' | 'weeks' | 'months';

function isCalendarInterval(count: number, unit: CalendarUnit): boolean {
  return (
    Number.isSafeInteger(count) && Math.abs(count) <= 36500 && ['days', 'weeks', 'months'].includes(unit)
  );
}
function civilDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}
function shiftCalendarDate(value: string, count: number, unit: CalendarUnit): string {
  const date = civilDate(value),
    day = date.getUTCDate();
  if (unit === 'months') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + count);
    const last = new Date(date.getTime());
    last.setUTCMonth(last.getUTCMonth() + 1, 0);
    date.setUTCDate(Math.min(day, last.getUTCDate()));
  } else date.setUTCDate(day + count * (unit === 'weeks' ? 7 : 1));
  const result = `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  if (!isCalendarDate(result)) throw new RangeError('Calendar date is outside the supported range');
  return result;
}

export function addCalendarDate(value: string, count: number, unit: CalendarUnit): string {
  if (!isCalendarDate(value) || !isCalendarInterval(count, unit))
    throw new RangeError('Invalid calendar interval');
  return shiftCalendarDate(value, count, unit);
}

/**
 * First slot strictly after afterDate in the sequence starting at anchorDate.
 * Each monthly slot clamps from the anchor, so February never shifts March.
 * The caller chooses the cutoff (for example completion or recording day);
 * this calculation neither reads the clock nor decides missed-work policy.
 */
export function nextAnchoredCalendarDate(
  anchorDate: string,
  count: number,
  unit: CalendarUnit,
  afterDate: string,
): string {
  if (
    !isCalendarDate(anchorDate) ||
    !isCalendarDate(afterDate) ||
    !isCalendarInterval(count, unit) ||
    count <= 0
  )
    throw new RangeError('Invalid anchored calendar interval');
  if (afterDate < anchorDate) return anchorDate;
  const anchor = civilDate(anchorDate),
    after = civilDate(afterDate);
  if (unit === 'months') {
    const elapsedMonths =
        (after.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + after.getUTCMonth() - anchor.getUTCMonth(),
      offset = Math.floor(elapsedMonths / count) * count,
      candidate = shiftCalendarDate(anchorDate, offset, unit);
    return candidate > afterDate ? candidate : shiftCalendarDate(anchorDate, offset + count, unit);
  }
  // UTC is only a coordinate system for civil-date arithmetic here, not the
  // household timezone. There are no daylight-saving-length days in this sum.
  const elapsedDays = (after.getTime() - anchor.getTime()) / 86400000,
    periodDays = count * (unit === 'weeks' ? 7 : 1),
    nextSlot = Math.floor(elapsedDays / periodDays) + 1;
  return shiftCalendarDate(anchorDate, nextSlot * count, unit);
}
