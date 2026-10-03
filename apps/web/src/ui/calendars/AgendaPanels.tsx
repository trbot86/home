import { CalendarDescription } from './CalendarDescription.js';
import { useState, type CSSProperties } from 'react';
import { agendaDays, openTasks, type ClientPlatform, type ClientState } from '@our-place/client';
import {
  planningGroups,
  approximateLabels,
  addCalendarDate,
  calendarDateAt,
  type AgendaCalendarSnapshot,
  type AgendaEvent,
} from '@our-place/contracts';
import { date } from '../format.js';
import { WebLink } from '../LinkedText.js';
import { Photo } from '../Photo.js';
import { recordReferences, type RecordReference } from '../RecordReferences.js';

export function AgendaTasks({
  state,
  context,
  start,
  count,
  limit,
  onTask,
  onAllTasks,
}: {
  state: ClientState;
  context: string;
  start: string;
  count: number;
  limit: number;
  onTask: (id: string) => void;
  onAllTasks: () => void;
}) {
  const today = calendarDateAt(Date.now(), state.tasks.timeZone);
  const through = addCalendarDate(start, count - 1, 'days');
  const groups = planningGroups(state.tasks, state.session!.person.personId, context, today).map((group) => ({
    ...group,
    dated: group.dated.filter(
      ({ occurrence: o }) =>
        o.priority >= 2 ||
        [o.deadlineDate, o.targetDate, o.reviewDate].some(
          (d) => d && (d <= today || (d >= start && d <= through)),
        ),
    ),
  }));
  const total = groups.reduce((n, g) => n + g.dated.length + g.undated.length, 0);
  let remaining = limit;
  const row = ({ task, occurrence }: ReturnType<typeof openTasks>[number]) => {
    const due =
      occurrence.deadlineDate && occurrence.deadlineDate < today
        ? occurrence.deadlineDate
        : (occurrence.targetDate ?? occurrence.deadlineDate ?? occurrence.reviewDate);
    const dateKind =
      due === occurrence.deadlineDate ? 'Deadline' : due === occurrence.targetDate ? 'Target' : 'Revisit';
    const fullDate = due ? `${dateKind}: ${due}` : '';
    const late = !!due && due < today;
    const compact = !due
      ? ''
      : late
        ? 'LATE'
        : due === today
          ? 'Today'
          : new Intl.DateTimeFormat(
              'en-US',
              due <= addCalendarDate(today, 7, 'days')
                ? { weekday: 'short', timeZone: 'UTC' }
                : { month: 'short', day: 'numeric', timeZone: 'UTC' },
            ).format(new Date(`${due}T12:00:00Z`));
    return (
      <button
        className={`agenda-task priority-row-${occurrence.priority}`}
        key={occurrence.recordId}
        onClick={() => onTask(occurrence.recordId)}
      >
        <span className="agenda-task-heading">
          <strong>{task.title}</strong>
          {compact && (
            <span
              className={`agenda-compact-date ${late ? 'is-late' : ''}`}
              title={fullDate}
              aria-label={fullDate}
            >
              {compact}
            </span>
          )}
        </span>
        <span className="agenda-task-meta">
          {occurrence.deadlineDate && <span>Deadline · {occurrence.deadlineDate}</span>}
          {occurrence.targetDate && <span>Target · {occurrence.targetDate}</span>}
          {occurrence.reviewDate && <span>Revisit · {occurrence.reviewDate}</span>}
          {occurrence.approximateDate && <span>{approximateLabels[occurrence.approximateDate]}</span>}
          {occurrence.priority >= 2 && (
            <span className={`task-priority priority-${occurrence.priority}`}>Important</span>
          )}
          {occurrence.deadlineDate && occurrence.deadlineDate < today && (
            <span className="agenda-overdue">Past deadline</span>
          )}
        </span>
      </button>
    );
  };
  return (
    <section className="agenda-panel agenda-focus" aria-label="Your tasks" data-agenda-section="tasks">
      <h2>Your tasks</h2>
      {!total && <p>No tasks need attention today or are scheduled for these dates.</p>}
      {groups.map((group) => {
        const dated = group.dated.slice(0, remaining);
        remaining -= dated.length;
        const undated = group.undated.slice(0, remaining);
        remaining -= undated.length;
        return dated.length + undated.length ? (
          <section className="agenda-task-group" key={group.label} aria-label={group.label}>
            <h3>{group.label}</h3>
            {dated.map(row)}
            {undated.length > 0 && (
              <>
                <p className="agenda-undated">Undated</p>
                {undated.map(row)}
              </>
            )}
          </section>
        ) : null;
      })}
      {total > limit && <button onClick={onAllTasks}>Open all tasks ({total} in this view)</button>}
    </section>
  );
}

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${day}T12:00:00Z`));
function eventTime(event: AgendaEvent, timeZone: string, day: string) {
  if (event.timing.kind === 'all_day') return 'All day';
  const at = event.timing.startAt;
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const time = `${part('hour')}:${part('minute')}${part('dayPeriod') === 'AM' ? 'a' : 'p'}`;
  // Keep the original start date clear when an event continues into another day.
  return calendarDateAt(at, timeZone) === day
    ? time
    : `${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at)} ${time}`;
}
function calendarStyle(id: string): CSSProperties {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { '--calendar-color': `hsl(${hash % 360} 55% 72%)` } as CSSProperties;
}
export function AgendaCalendar({
  client,
  state,
  calendars,
  start,
  count,
  limit,
}: {
  client: ClientPlatform;
  state: ClientState;
  calendars: AgendaCalendarSnapshot[];
  start: string;
  count: number;
  limit: number;
}) {
  const [extra, setExtra] = useState(0),
    timeZone = state.tasks.timeZone,
    today = calendarDateAt(Date.now(), timeZone),
    through = addCalendarDate(start, count - 1, 'days');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const eventKey = (calendarId: string, event: AgendaEvent) =>
    JSON.stringify([calendarId, event.eventId, event.instanceKey]);
  const days = agendaDays(calendars, start, count, timeZone),
    total = days.reduce((sum, day) => sum + day.events.length, 0);
  let remaining = limit + extra;
  const visible = days.flatMap((day) => {
    const events = day.events.slice(0, remaining);
    remaining -= events.length;
    return events.length ? [{ ...day, events }] : [];
  });
  return (
    <section
      className="agenda-panel agenda-events"
      aria-label="Calendar events"
      data-agenda-section="calendar"
    >
      <h2>Calendar events</h2>
      {!calendars.length && !state.agenda.issue && (
        <p>No calendars selected. You can add calendars in Settings; tasks appear independently.</p>
      )}
      {calendars.length > 0 && total === 0 && <p>No events in the saved calendars for these dates.</p>}
      {visible.map((day) => (
        <section className="agenda-day" key={day.date} aria-label={day.date}>
          <h3>
            {day.date === today ? 'Today · ' : ''}
            {dayLabel(day.date)}
          </h3>
          {day.events.map(({ calendar, event }) => (
            <article
              className={`agenda-event ${event.participation === 'declined' ? 'agenda-declined' : ''}`}
              style={calendarStyle(calendar.calendarId)}
              title={calendar.title}
              aria-label={`${event.title || 'Untitled event'} — ${calendar.title}`}
              key={JSON.stringify([calendar.calendarId, event.eventId, event.instanceKey])}
            >
              <div className="agenda-event-heading">
                <p className="agenda-time">{eventTime(event, timeZone, day.date)}</p>
                <div className="agenda-event-title">
                  {event.description && (
                    <button
                      className="agenda-details-toggle"
                      title="Event details"
                      aria-label={`Details for ${event.title || 'Untitled event'}`}
                      aria-expanded={expanded.has(eventKey(calendar.calendarId, event))}
                      onClick={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous),
                            key = eventKey(calendar.calendarId, event);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    >
                      {expanded.has(eventKey(calendar.calendarId, event)) ? '▾' : '▸'}
                    </button>
                  )}
                  <h4>{event.title || 'Untitled event'}</h4>
                </div>
              </div>
              <p className="fine">
                {event.status === 'tentative' ? ' · Tentative' : ''}
                {event.participation === 'declined' ? ' · Declined' : ''}
                {event.participation === 'needsAction' ? ' · Invitation awaiting your reply' : ''}
              </p>
              {event.location && <p>{event.location}</p>}
              {event.description && expanded.has(eventKey(calendar.calendarId, event)) && (
                <CalendarDescription client={client} text={event.description} />
              )}
              {event.sourceUrl && (
                <WebLink client={client} href={event.sourceUrl}>
                  Open in Google Calendar
                </WebLink>
              )}
            </article>
          ))}
        </section>
      ))}
      {total > limit + extra && (
        <button onClick={() => setExtra(extra + limit)}>
          Show more calendar entries ({total - limit - extra} remaining)
        </button>
      )}
      <div className="agenda-sources" aria-label="Calendar sources">
        {calendars.map((c) => (
          <div className="agenda-source" key={c.calendarId} style={calendarStyle(c.calendarId)}>
            <strong>{c.title || 'Untitled calendar'}</strong>
            <span>{c.context === 'work' ? 'Work · private' : 'Home'}</span>
            <span>
              {c.refreshedAt === null ? 'Waiting for the first download' : `Updated ${date(c.refreshedAt)}`}
            </span>
            {c.errorCode && (
              <span role="status">
                Refresh unavailable.{' '}
                {c.refreshedAt === null
                  ? 'No events have been downloaded.'
                  : 'Showing the previous download.'}
              </span>
            )}
            {c.window &&
              (calendarDateAt(c.window.from, timeZone) >= start ||
                calendarDateAt(c.window.until, timeZone) <= through) && (
                <span role="status">Some selected dates are outside this download.</span>
              )}
          </div>
        ))}
      </div>
    </section>
  );
}
export function AgendaRecipes({
  client,
  state,
  limit,
  onRecipe,
}: {
  client: ClientPlatform;
  state: ClientState;
  limit: number;
  onRecipe: (id: string) => void;
}) {
  const ids = [
    ...new Set(
      state.views.filter((v) => v.kind === 'food_soon').flatMap((v) => v.pins.map((p) => p.recordId)),
    ),
  ];
  const recipes = ids.flatMap((id) => {
    const recipe = state.recipes.recipes.find(
      (r) => r.recordId === id && !r.archived && r.deletedAt === null,
    );
    return recipe ? [recipe] : [];
  });
  const [extra, setExtra] = useState(0);
  return (
    <section className="agenda-panel" aria-label="Make soon recipes" data-agenda-section="food_soon">
      <p className="eyebrow">Home</p>
      <h2>Make soon</h2>
      {!recipes.length && <p>Pin recipes as “Make soon” in Food to see them here.</p>}
      <div className="agenda-recipes">
        {recipes.slice(0, limit + extra).map((recipe) => (
          <button key={recipe.recordId} onClick={() => onRecipe(recipe.recordId)} className="agenda-recipe">
            {recipe.attachments[0] && (
              <Photo client={client} id={recipe.attachments[0].mediaId} descriptor={recipe.attachments[0]} />
            )}
            <strong>{recipe.title}</strong>
          </button>
        ))}
      </div>
      {recipes.length > limit + extra && (
        <button onClick={() => setExtra(extra + limit)}>
          Show more recipes ({recipes.length - limit - extra} remaining)
        </button>
      )}
    </section>
  );
}
export function AgendaProjects({
  state,
  limit,
  onRecord,
  onProject,
}: {
  state: ClientState;
  limit: number;
  onRecord: (ref: RecordReference) => void;
  onProject: (id: string) => void;
}) {
  const references = new Map(recordReferences(state).map((r) => [r.recordId, r]));
  const pins = state.views.flatMap((view) => {
    if (view.kind !== 'project_next') return [];
    const project = state.projects.projects.find(
      (p) => p.recordId === view.projectId && !p.archived && p.deletedAt === null,
    );
    return project
      ? view.pins.flatMap((pin) => {
          const reference = references.get(pin.recordId);
          return reference && reference.deletedAt === null ? [{ project, reference }] : [];
        })
      : [];
  });
  const [extra, setExtra] = useState(0);
  return (
    <section className="agenda-panel" aria-label="Project priorities" data-agenda-section="project_next">
      <p className="eyebrow">Home</p>
      <h2>Project priorities</h2>
      {!pins.length && <p>Pin the next steps on a project board to bring them here.</p>}
      {pins.slice(0, limit + extra).map(({ project, reference }) => (
        <article className="agenda-project-pin" key={`${project.recordId}:${reference.recordId}`}>
          <button onClick={() => onProject(project.recordId)} className="fine">
            {project.title}
          </button>
          <button className="agenda-task" onClick={() => onRecord(reference)}>
            <span>{reference.label}</span>
            <strong>{reference.title}</strong>
          </button>
        </article>
      ))}
      {pins.length > limit + extra && (
        <button onClick={() => setExtra(extra + limit)}>
          Show more project priorities ({pins.length - limit - extra} remaining)
        </button>
      )}
    </section>
  );
}
