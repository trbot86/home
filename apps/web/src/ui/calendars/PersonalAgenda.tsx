import { useNavigationState } from '../NavigationHistory.js';
import { useEffect, useRef, useState } from 'react';
import { usePagePreference } from '../usePagePreference.js';
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
    [count, setCount] = usePagePreference<number>(
      state,
      'agenda.days',
      layout.days,
      (v): v is number => v === 7 || v === 30,
    ),
    [context, setContext] = usePagePreference<AgendaLayout['context']>(
      state,
      'agenda.context',
      layout.context,
      (v): v is AgendaLayout['context'] => ['home', 'work', 'both'].includes(String(v)),
    ),
    [editing, setEditing] = useNavigationState('PersonalAgenda.editing', false);
  const previousLayout = useRef({ id: view?.viewId, days: layout.days, context: layout.context });
  useEffect(() => {
    if (previousLayout.current.id && previousLayout.current.id === view?.viewId) {
      if (previousLayout.current.days !== layout.days) setCount(layout.days);
      if (previousLayout.current.context !== layout.context) setContext(layout.context);
    }
    previousLayout.current = { id: view?.viewId, days: layout.days, context: layout.context };
  }, [view?.viewId, layout.days, layout.context]);
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
      <p className="fine agenda-help">
        Times shown in {state.tasks.timeZone}. Calendars refresh automatically about every ten minutes.
      </p>
      {!state.online && (
        <p className="calendar-message" role="status">
          Offline · showing the last download. Calendar changes and access changes will appear after
          reconnecting.
        </p>
      )}
      {!state.agenda.configured && (
        <p className="calendar-message agenda-help">
          Calendar connection is optional. Your tasks appear without a connected calendar.
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
              start={start}
              count={count}
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
