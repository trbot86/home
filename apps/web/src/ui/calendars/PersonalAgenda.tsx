import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import {
  addCalendarDate,
  calendarDateAt,
  defaultAgendaLayout,
  type AgendaLayout,
  type SavedView,
} from '@our-place/contracts';
import type { RecordReference } from '../RecordReferences.js';
import { AgendaLayoutEditor } from './AgendaLayoutEditor.js';
import { AgendaTasks, AgendaCalendar, AgendaRecipes, AgendaProjects } from './AgendaPanels.js';
import './agenda.css';
export function PersonalAgenda({
  client,
  state,
  run,
  onError,
  onSettings,
  onTask,
  onAllTasks,
  onRecipe,
  onProject,
  onRecord,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
  onError: (error: unknown) => void;
  onSettings: () => void;
  onTask: (id: string) => void;
  onAllTasks: () => void;
  onRecipe: (id: string) => void;
  onProject: (id: string) => void;
  onRecord: (record: RecordReference) => void;
}) {
  const privateScope = state.session!.scopes.find((s) => s.kind === 'private')!.scopeId;
  const view = state.views.find(
    (v): v is Extract<SavedView, { kind: 'agenda' }> => v.kind === 'agenda' && v.scopeId === privateScope,
  );
  const layout = view?.layout ?? defaultAgendaLayout(),
    today = calendarDateAt(Date.now(), state.tasks.timeZone);
  const [start, setStart] = useState(today),
    [count, setCount] = useState<number>(layout.days),
    [context, setContext] = useState<AgendaLayout['context']>(layout.context),
    [editing, setEditing] = useState(false);
  useEffect(() => {
    setCount(layout.days);
    setContext(layout.context);
  }, [view?.revision]);
  const calendars = state.agenda.calendars.filter((c) => context === 'both' || c.context === context);
  const sections = layout.sections.filter(
    (s) => s.enabled && (context !== 'work' || !['food_soon', 'project_next'].includes(s.kind)),
  );
  return (
    <section className="agenda" aria-label="Personal agenda">
      <div className="agenda-controls">
        <label>
          Show
          <select
            aria-label="Show"
            value={context}
            onChange={(e) => setContext(e.target.value as AgendaLayout['context'])}
          >
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
          <select aria-label="Days" value={count} onChange={(e) => setCount(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <button onClick={() => setStart(today)}>Today</button>
        <button onClick={onSettings}>Manage calendars</button>
        <button onClick={() => setEditing(true)}>Customise agenda</button>
      </div>
      <p className="fine">
        Times shown in {state.tasks.timeZone}. Calendars refresh automatically about every ten minutes.
      </p>
      {!state.online && (
        <p className="calendar-message" role="status">
          Offline · showing the last download. Calendar changes and access changes will appear after
          reconnecting.
        </p>
      )}
      {!state.agenda.configured && (
        <p className="calendar-message">
          Google Calendar setup is pending. Your household sections work normally.
        </p>
      )}
      {state.agenda.needsReconnect && (
        <p className="calendar-message" role="status">
          A Google account needs reconnection in Settings. Its events are hidden until access is renewed.
        </p>
      )}
      {state.agenda.issue && (
        <p className="calendar-message" role="status">
          The selected calendars are too large to download together. Choose fewer calendars in Settings; no
          partial agenda is shown.
        </p>
      )}
      {!sections.length && (
        <p>No sections are shown in this view. Use Customise agenda to choose what you’d like here.</p>
      )}
      <div className="agenda-layout">
        {sections.map((section) =>
          section.kind === 'tasks' ? (
            <AgendaTasks
              key={section.kind}
              state={state}
              context={context}
              limit={section.limit}
              onTask={onTask}
              onAllTasks={onAllTasks}
            />
          ) : section.kind === 'calendar' ? (
            <AgendaCalendar
              key={`${section.kind}:${start}:${count}:${context}:${section.limit}`}
              client={client}
              state={state}
              calendars={calendars}
              start={start}
              count={count}
              limit={section.limit}
            />
          ) : section.kind === 'food_soon' ? (
            <AgendaRecipes
              key={`${section.kind}:${section.limit}`}
              client={client}
              state={state}
              limit={section.limit}
              onRecipe={onRecipe}
            />
          ) : (
            <AgendaProjects
              key={`${section.kind}:${section.limit}`}
              state={state}
              limit={section.limit}
              onProject={onProject}
              onRecord={onRecord}
            />
          ),
        )}
      </div>
      {editing && (
        <AgendaLayoutEditor
          client={client}
          state={state}
          view={view}
          run={run}
          onError={onError}
          close={() => setEditing(false)}
        />
      )}
    </section>
  );
}
