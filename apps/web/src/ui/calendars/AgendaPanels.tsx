import { useState } from 'react';
import {
  agendaDays,
  compareOpenTasks,
  openTasks,
  taskAttention,
  type ClientPlatform,
  type ClientState,
} from '@our-place/client';
import {
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
  limit,
  onTask,
  onAllTasks,
}: {
  state: ClientState;
  context: string;
  limit: number;
  onTask: (id: string) => void;
  onAllTasks: () => void;
}) {
  const today = calendarDateAt(Date.now(), state.tasks.timeZone);
  const tasks = openTasks(state.tasks)
    .filter(
      ({ task, occurrence }) =>
        (context === 'both' || task.context === context) &&
        (!occurrence.assigneeId || occurrence.assigneeId === state.session!.person.personId) &&
        !['upcoming', 'anytime'].includes(taskAttention(occurrence, today)),
    )
    .sort(compareOpenTasks);
  return (
    <section className="agenda-panel agenda-focus" aria-label="Your tasks today" data-agenda-section="tasks">
      <p className="eyebrow">For {state.session!.person.displayName}</p>
      <h2>Your tasks today</h2>
      <p className="fine">Assigned to you or unassigned. Open a task to complete, edit or postpone it.</p>
      {!tasks.length && <p>No tasks need your attention today.</p>}
      {tasks.slice(0, limit).map(({ task, occurrence }) => (
        <button className="agenda-task" key={occurrence.recordId} onClick={() => onTask(occurrence.recordId)}>
          <strong>{task.title}</strong>
          {occurrence.deadlineDate && <span>Deadline · {occurrence.deadlineDate}</span>}
          {occurrence.targetDate && <span>Target · {occurrence.targetDate}</span>}
          {occurrence.reviewDate && <span>Revisit · {occurrence.reviewDate}</span>}
          {occurrence.priority >= 2 && <span>Chosen priority</span>}
          {occurrence.deadlineDate && occurrence.deadlineDate < today && (
            <span className="agenda-overdue">Past deadline</span>
          )}
        </button>
      ))}
      {tasks.length > limit && (
        <button onClick={onAllTasks}>Open all tasks ({tasks.length} need attention)</button>
      )}
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
function eventTime(event: AgendaEvent, timeZone: string) {
  if (event.timing.kind === 'all_day') return 'All day';
  const format = (at: number) =>
    new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(at);
  return (
    format(event.timing.startAt) + (event.timing.endUnspecified ? '' : ` – ${format(event.timing.endAt)}`)
  );
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
      <h2>Coming up</h2>
      <div className="agenda-sources">
        {calendars.map((c) => (
          <div className="agenda-source" key={c.calendarId}>
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
      {!calendars.length && !state.agenda.issue && <p>Choose calendars in Settings to see events here.</p>}
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
              key={JSON.stringify([calendar.calendarId, event.eventId, event.instanceKey])}
            >
              <p className="agenda-time">{eventTime(event, timeZone)}</p>
              <h4>{event.title || 'Untitled event'}</h4>
              <p className="fine">
                {calendar.title}
                {event.status === 'tentative' ? ' · Tentative' : ''}
                {event.participation === 'declined' ? ' · Declined' : ''}
                {event.participation === 'needsAction' ? ' · Invitation awaiting your reply' : ''}
              </p>
              {event.location && <p>{event.location}</p>}
              {event.description && (
                <details>
                  <summary>Details</summary>
                  <p className="agenda-description">{event.description}</p>
                </details>
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
