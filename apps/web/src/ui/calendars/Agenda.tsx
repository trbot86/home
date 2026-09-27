import { useState } from 'react';
import {
  agendaDays,
  compareOpenTasks,
  openTasks,
  taskAttention,
  type ClientPlatform,
  type ClientState,
} from '@our-place/client';
import { addCalendarDate, calendarDateAt, type AgendaEvent } from '@our-place/contracts';
import { date } from '../format.js';
import { WebLink } from '../LinkedText.js';
import './agenda.css';

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
export function Agenda({
  client,
  state,
  onSettings,
  onTask,
}: {
  client: ClientPlatform;
  state: ClientState;
  onSettings: () => void;
  onTask: (id: string) => void;
}) {
  const timeZone = state.tasks.timeZone,
    today = calendarDateAt(Date.now(), timeZone);
  const [start, setStart] = useState(today),
    [count, setCount] = useState(7),
    [context, setContext] = useState('both');
  const snapshot = state.agenda;
  const calendars = snapshot.calendars.filter((c) => context === 'both' || c.context === context);
  const days = agendaDays(calendars, start, count, timeZone);
  const through = addCalendarDate(start, count - 1, 'days');
  const tasks = openTasks(state.tasks)
    .filter(
      ({ task, occurrence }) =>
        (context === 'both' || task.context === context) &&
        (!occurrence.assigneeId || occurrence.assigneeId === state.session!.person.personId) &&
        !['upcoming', 'anytime'].includes(taskAttention(occurrence, today)),
    )
    .sort(compareOpenTasks);
  return (
    <section className="agenda" aria-label="Personal agenda">
      <div className="agenda-controls">
        <label>
          Show
          <select value={context} onChange={(e) => setContext(e.target.value)}>
            <option value="both">Home + Work</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
          </select>
        </label>
        <label>
          Starting
          <input
            type="date"
            value={start}
            min={addCalendarDate(today, -7, 'days')}
            max={addCalendarDate(today, 30, 'days')}
            onChange={(e) => {
              if (e.target.value && e.target.validity.valid) setStart(e.target.value);
            }}
          />
        </label>
        <label>
          Days
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <button onClick={() => setStart(today)}>Today</button>
        <button onClick={onSettings}>Manage calendars</button>
      </div>
      <p className="fine">
        Times shown in {timeZone}. Calendars refresh automatically about every ten minutes.
      </p>
      {!state.online && (
        <p className="calendar-message" role="status">
          Offline · showing the last download. Calendar changes and access changes will appear after
          reconnecting.
        </p>
      )}
      {!snapshot.configured && (
        <p className="calendar-message">
          Google Calendar setup is pending. Your household tasks are available below.
        </p>
      )}
      {snapshot.needsReconnect && (
        <p className="calendar-message" role="status">
          A Google account needs reconnection in Settings. Its events are hidden until access is renewed.
        </p>
      )}
      {snapshot.issue && (
        <p className="calendar-message" role="status">
          The selected calendars are too large to download together. Choose fewer calendars in Settings; no
          partial agenda is shown.
        </p>
      )}
      <div className="agenda-layout">
        <section className="agenda-focus" aria-label="Your tasks today">
          <p className="eyebrow">For {state.session!.person.displayName}</p>
          <h2>Your tasks today</h2>
          <p className="fine">Assigned to you or unassigned. Open a task to complete, edit or postpone it.</p>
          {tasks.length === 0 && <p>No tasks need your attention today.</p>}
          {tasks.slice(0, 12).map(({ task, occurrence }) => (
            <button
              key={occurrence.recordId}
              className="agenda-task"
              onClick={() => onTask(occurrence.recordId)}
            >
              <strong>{task.title}</strong>
              <span>
                {occurrence.deadlineDate
                  ? `Deadline · ${occurrence.deadlineDate}`
                  : occurrence.reviewDate
                    ? `Revisit · ${occurrence.reviewDate}`
                    : occurrence.targetDate
                      ? `Target · ${occurrence.targetDate}`
                      : 'Chosen priority'}
              </span>
              {occurrence.deadlineDate && occurrence.deadlineDate < today && (
                <span className="agenda-overdue">Past deadline</span>
              )}
            </button>
          ))}
          {tasks.length > 12 && <p>{tasks.length - 12} more in Tasks.</p>}
        </section>
        <section className="agenda-events" aria-label="Calendar events">
          <h2>Coming up</h2>
          <div className="agenda-sources">
            {calendars.map((c) => (
              <div key={c.calendarId} className="agenda-source">
                <strong>{c.title || 'Untitled calendar'}</strong>
                <span>{c.context === 'work' ? 'Work · private' : 'Home'}</span>
                <span>
                  {c.refreshedAt === null
                    ? 'Waiting for the first download'
                    : `Updated ${date(c.refreshedAt)}`}
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
          {calendars.length === 0 && !snapshot.issue && (
            <p>Choose calendars in Settings to see events here.</p>
          )}
          {calendars.length > 0 && !days.some((day) => day.events.length) && (
            <p>No events in the saved calendars for these dates.</p>
          )}
          {days
            .filter((day) => day.events.length > 0)
            .map((day) => (
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
        </section>
      </div>
    </section>
  );
}
