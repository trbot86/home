import { useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import { agendaDays } from '@our-place/client';
import { addCalendarDate, calendarDateAt, taskCalendarEntries } from '@our-place/contracts';
import { AgendaCalendar } from './AgendaPanels.js';
import './agenda.css';
export function TaskCalendar({
  client,
  state,
  onTask,
}: {
  client: ClientPlatform;
  state: ClientState;
  onTask: (id: string) => void;
}) {
  const today = calendarDateAt(Date.now(), state.tasks.timeZone);
  const [month, setMonth] = useState(today.slice(0, 7) + '-01');
  const [selected, setSelected] = useState(today);
  const [context, setContext] = useState('both');
  const weekday = new Date(`${month}T12:00:00Z`).getUTCDay();
  const start = addCalendarDate(month, -((weekday + 6) % 7), 'days');
  const days = Array.from({ length: 42 }, (_, i) => addCalendarDate(start, i, 'days'));
  const calendars = state.agenda.calendars.filter((c) => context === 'both' || c.context === context);
  const events = [
    ...agendaDays(calendars, start, 21, state.tasks.timeZone),
    ...agendaDays(calendars, addCalendarDate(start, 21, 'days'), 21, state.tasks.timeZone),
  ];
  const tasks = taskCalendarEntries(state.tasks, state.session!.person.personId, context);
  const move = (n: number) => {
    const next = addCalendarDate(month, n, 'months');
    setMonth(next);
    setSelected(next);
  };
  return (
    <section className="agenda task-calendar" aria-label="Calendar">
      <div className="agenda-controls">
        <button aria-label="Previous month" onClick={() => move(-1)}>
          ←
        </button>
        <strong>
          {new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
            new Date(month + 'T12:00:00Z'),
          )}
        </strong>
        <button aria-label="Next month" onClick={() => move(1)}>
          →
        </button>
        <button
          onClick={() => {
            setMonth(today.slice(0, 7) + '-01');
            setSelected(today);
          }}
        >
          Today
        </button>
        <label>
          Show
          <select value={context} onChange={(e) => setContext(e.target.value)}>
            <option value="both">Home + Work</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
          </select>
        </label>
      </div>
      <div className="calendar-month" aria-label="Choose a calendar day">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span className="calendar-weekday" key={d}>
            {d}
          </span>
        ))}
        {days.map((day) => {
          const items = tasks.filter((t) => t.day === day),
            count = items.length + (events.find((e) => e.date === day)?.events.length ?? 0);
          return (
            <button
              key={day}
              className={`calendar-day ${day.slice(0, 7) !== month.slice(0, 7) ? 'outside-month' : ''}`}
              aria-label={`${day}, ${count} entries`}
              aria-pressed={selected === day}
              aria-current={today === day ? 'date' : undefined}
              onClick={() => setSelected(day)}
            >
              <span>{Number(day.slice(8))}</span>
              <span className="calendar-pips" aria-hidden="true">
                {Array.from({ length: Math.min(count, 5) }, (_, i) => <i key={i} className={i < items.length ? (items[i]?.completed ? 'completed' : 'task') : 'event'} />)}
              </span>
            </button>
          );
        })}
      </div>
      <h2 className="calendar-selected-date">{selected}</h2>
      <div className="agenda-layout">
        <section className="agenda-panel" aria-label="Calendar tasks">
          <h2>Tasks</h2>
          {tasks
            .filter((t) => t.day === selected)
            .map((t) => (
              <button
                className={`agenda-task priority-row-${t.occurrence.priority}`}
                key={`${t.occurrence.recordId}:${t.day}`}
                onClick={() => onTask(t.occurrence.recordId)}
              >
                <strong>
                  {t.completed ? '✓ ' : ''}
                  {t.task.title}
                </strong>
                {t.completed && <span>Completed</span>}
              </button>
            ))}
          {!tasks.some((t) => t.day === selected) && <p>No tasks on this date.</p>}
        </section>
        <AgendaCalendar
          key={`${selected}:${context}`}
          client={client}
          state={state}
          calendars={calendars}
          start={selected}
          count={1}
          limit={100}
        />
      </div>
    </section>
  );
}
