import {
  addCalendarDate,
  calendarDateAt,
  openTasks,
  compareOpenTasks,
  taskAttention,
  type TaskSnapshot,
  type ShoppingSnapshot,
  type RecipeSnapshot,
  type SavedView,
  type AgendaCalendarSnapshot,
  type EinkPreviewRequest,
} from '@our-place/contracts';

export type DisplayRow = { title: string; detail?: string; prefix?: string };
export type DisplaySection = { title: string; rows: DisplayRow[]; empty: string };
export type DisplayModel = {
  layout: 'kitchen' | 'desk';
  title: string;
  date: string;
  footer: string;
  sections: DisplaySection[];
  warnings: string[];
};
type Inputs = {
  personId: string;
  displayName: string;
  sharedScopes: string[];
  privateScopes: string[];
  tasks: TaskSnapshot;
  shopping: ShoppingSnapshot;
  recipes: RecipeSnapshot;
  views: SavedView[];
  calendars: AgendaCalendarSnapshot[];
  now: number;
};
const attentionOrder = ['overdue', 'today', 'priority', 'ready', 'review', 'upcoming', 'anytime'];
const dayLabel = (date: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(date + 'T12:00:00Z'));

/** Filter scope and calendar visibility before any text reaches the renderer. No note bodies or secrets. */
export function displayProjection(input: Inputs, request: EinkPreviewRequest): DisplayModel {
  const kitchen = request.layout === 'kitchen';
  const scopes = new Set([
    ...input.sharedScopes,
    ...(!kitchen && request.includePrivate ? input.privateScopes : []),
  ]);
  const today = calendarDateAt(input.now, input.tasks.timeZone),
    end = addCalendarDate(today, request.days, 'days');
  const taskRows = openTasks(input.tasks)
    .filter(
      ({ task, occurrence }) =>
        scopes.has(task.scopeId) &&
        occurrence.scopeId === task.scopeId &&
        (kitchen
          ? task.context === 'home'
          : occurrence.assigneeId === null || occurrence.assigneeId === input.personId),
    )
    .sort(
      (a, b) =>
        attentionOrder.indexOf(taskAttention(a.occurrence, today)) -
          attentionOrder.indexOf(taskAttention(b.occurrence, today)) || compareOpenTasks(a, b),
    )
    .map(({ task, occurrence }): DisplayRow => {
      const parts: string[] = [];
      if (occurrence.deadlineDate) parts.push(`Due ${dayLabel(occurrence.deadlineDate)}`);
      else if (occurrence.targetDate) parts.push(`Target ${dayLabel(occurrence.targetDate)}`);
      else if (occurrence.reviewDate) parts.push(`Review ${dayLabel(occurrence.reviewDate)}`);
      else if (occurrence.priority > 1) parts.push('Priority');
      return { title: task.title, detail: parts.join(' · ') };
    });
  const selected = new Set(request.calendarIds);
  const calendars = input.calendars.filter(
    (c) => selected.has(c.calendarId) && scopes.has(c.scopeId) && (!kitchen || c.context === 'home'),
  );
  const events = calendars
    .flatMap((c) =>
      c.events
        .filter(
          (e) =>
            e.participation !== 'declined' &&
            ((!kitchen && request.includePrivate) ||
              (e.visibility !== 'private' && e.visibility !== 'confidential')),
        )
        .map((e) => {
          const start =
            e.timing.kind === 'all_day'
              ? e.timing.startDate
              : calendarDateAt(e.timing.startAt, input.tasks.timeZone);
          const until =
            e.timing.kind === 'all_day'
              ? e.timing.endDate
              : calendarDateAt(e.timing.endAt, input.tasks.timeZone);
          if (start >= end || (e.timing.kind === 'all_day' ? until <= today : e.timing.endAt <= input.now))
            return null;
          const day = start < today ? today : start;
          const time =
            e.timing.kind === 'all_day'
              ? 'All day'
              : new Intl.DateTimeFormat('en-US', {
                  timeZone: input.tasks.timeZone,
                  hour: 'numeric',
                  minute: '2-digit',
                  hour12: true,
                })
                  .format(e.timing.startAt)
                  .replace(' AM', 'a')
                  .replace(' PM', 'p');
          return {
            sort: `${day}/${e.timing.kind === 'all_day' ? '0' : String(e.timing.startAt).padStart(15, '0')}`,
            title: e.title || '(Untitled event)',
            prefix: `${day === today ? 'Today' : dayLabel(day).split(',')[0]}\n${time}`,
          };
        }),
    )
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.sort.localeCompare(b.sort) || a.title.localeCompare(b.title));
  const calendarRows = events.map(({ title, prefix }) => ({ title, prefix }));
  const groceryIds = new Set(
    input.shopping.lists
      .filter((l) => input.sharedScopes.includes(l.scopeId) && l.purpose === 'groceries' && !l.deletedAt)
      .map((l) => l.recordId),
  );
  const groceryRows = input.shopping.entries
    .filter(
      (e) =>
        groceryIds.has(e.listId) &&
        input.sharedScopes.includes(e.scopeId) &&
        !e.deletedAt &&
        e.state === 'needed',
    )
    .sort((a, b) => a.position - b.position || a.recordId.localeCompare(b.recordId))
    .map((e) => ({ title: e.quantity ? `${e.label} · ${e.quantity}` : e.label }));
  const pins = input.views
    .filter((v) => v.kind === 'food_soon' && input.sharedScopes.includes(v.scopeId))
    .flatMap((v) => v.pins.map((p) => p.recordId));
  const meals = [...new Set(pins)].flatMap((id) => {
    const recipe = input.recipes.recipes.find(
      (r) => r.recordId === id && input.sharedScopes.includes(r.scopeId) && !r.deletedAt,
    );
    return recipe ? [{ title: recipe.title }] : [];
  });
  const warnings: string[] = [];
  if (!calendars.length) warnings.push('Choose calendars to include in this preview.');
  if (
    calendars.some(
      (c) =>
        c.errorCode ||
        c.refreshedAt === null ||
        c.window === null ||
        calendarDateAt(c.window.until, input.tasks.timeZone) < end,
    )
  )
    warnings.push('Some calendars have incomplete or stale cached data. Check Calendar settings.');
  return {
    layout: request.layout,
    title: kitchen ? 'Kitchen' : `${input.displayName} · Desk`,
    date: dayLabel(today),
    footer: kitchen
      ? 'Shared home information'
      : request.includePrivate
        ? 'Private items included'
        : 'Shared items only',
    warnings,
    sections: kitchen
      ? [
          {
            title: request.days === 2 ? 'Today & tomorrow' : 'Next 7 days',
            rows: calendarRows,
            empty: calendars.length ? 'No upcoming events' : 'No calendars selected',
          },
          { title: 'Chores', rows: taskRows, empty: 'No open chores' },
          { title: 'Make soon', rows: meals, empty: 'Pin recipes in Our Place' },
          { title: 'Groceries', rows: groceryRows, empty: 'Nothing needed' },
        ]
      : [
          { title: 'Your tasks', rows: taskRows, empty: 'No open tasks' },
          {
            title: request.days === 2 ? 'Today & tomorrow' : 'Next 7 days',
            rows: calendarRows,
            empty: calendars.length ? 'No upcoming events' : 'No calendars selected',
          },
        ],
  };
}
