import { useState } from 'react';
import {
  householdActivity,
  filterActivity,
  defaultActivityFilter,
  type ActivityFilter,
  type ActivityItem,
  type ClientPlatform,
  type ClientState,
} from '@our-place/client';
import { calendarDateAt } from '@our-place/contracts';
import { recordReferences, type RecordReference } from '../RecordReferences.js';
import { Icon } from '../Icon.js';
import './activity.css';
import { ActivityCard } from './ActivityCard.js';

export function Activity({
  client,
  state,
  onRecord,
}: {
  client: ClientPlatform;
  state: ClientState;
  onRecord: (record: RecordReference) => void;
}) {
  const [filter, setFilter] = useState(defaultActivityFilter),
    [limit, setLimit] = useState(20);
  const items = filterActivity(householdActivity(state), state, filter);
  const visible = items.slice(0, limit);
  const references = new Map(recordReferences(state).map((r) => [r.recordId, r]));
  const timeZone = state.tasks.timeZone;
  const groups = new Map<string, ActivityItem[]>();
  for (const item of visible) {
    const day = calendarDateAt(item.occurredAt, timeZone);
    groups.set(day, [...(groups.get(day) ?? []), item]);
  }
  function field<K extends keyof ActivityFilter>(name: K, value: ActivityFilter[K]) {
    setFilter((previous) => ({ ...previous, [name]: value }));
    setLimit(20);
  }
  const dayLabel = (day: string) =>
    new Intl.DateTimeFormat(undefined, {
      timeZone: 'UTC',
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${day}T12:00:00Z`));
  return (
    <section className="activity" aria-label="Recently done">
      <div className="activity-filters">
        <label>
          Visibility
          <select
            aria-label="Activity visibility"
            value={filter.visibility}
            onChange={(e) => field('visibility', e.target.value as ActivityFilter['visibility'])}
          >
            <option value="shared">Shared</option>
            <option value="private">Just me</option>
            <option value="all">Shared + mine</option>
          </select>
        </label>
        <label>
          Done by
          <select
            aria-label="Activity person"
            value={filter.personId}
            onChange={(e) => field('personId', e.target.value)}
          >
            <option value="everyone">Everyone</option>
            {state.tasks.people.map((person) => (
              <option key={person.personId} value={person.personId}>
                {person.displayName}
              </option>
            ))}
            <option value="unrecorded">Person not recorded</option>
          </select>
        </label>
        <label>
          Home / Work
          <select
            aria-label="Activity context"
            value={filter.context}
            onChange={(e) => field('context', e.target.value as ActivityFilter['context'])}
          >
            <option value="both">Home + Work</option>
            <option value="home">Home</option>
            <option value="work">Work</option>
          </select>
        </label>
        <label>
          Kind
          <select
            aria-label="Activity kind"
            value={filter.kind}
            onChange={(e) => field('kind', e.target.value as ActivityFilter['kind'])}
          >
            <option value="all">Everything</option>
            <option value="task">Tasks</option>
            <option value="purchase">Purchases</option>
            <option value="cooking">Cooking</option>
            <option value="maintenance">Maintenance</option>
          </select>
        </label>
        <label className="activity-search">
          Find something
          <input
            type="search"
            aria-label="Search activity"
            value={filter.search}
            onChange={(e) => field('search', e.target.value)}
            placeholder="A task, purchase or note…"
          />
        </label>
      </div>
      <p className="fine activity-explanation">
        Actual dates, newest first · Times in {timeZone}. Linked cooking and maintenance completions appear
        once.
      </p>
      {!state.online && (
        <p role="status" className="notice">
          Showing downloaded activity. New work appears after reconnecting. Notes and available photos can
          still be read here.
        </p>
      )}
      {!items.length ? (
        <div className="activity-empty">
          <Icon name="check" size={32} />
          <h2>Nothing in this view yet.</h2>
          <p>
            Completed tasks, purchases, cooking and service records will appear here. Try changing the filters
            to see more.
          </p>
        </div>
      ) : (
        [...groups].map(([day, rows]) => (
          <section className="activity-day" key={day} aria-label={dayLabel(day)}>
            <h2>{dayLabel(day)}</h2>
            {rows.map((item) => (
              <ActivityCard
                key={item.recordId}
                item={item}
                client={client}
                state={state}
                references={references}
                onRecord={onRecord}
              />
            ))}
          </section>
        ))
      )}
      {items.length > 0 && (
        <p className="fine">
          Showing {visible.length} of {items.length} in this view.
        </p>
      )}
      {visible.length < items.length && (
        <button className="activity-more" onClick={() => setLimit((n) => n + 20)}>
          Show more activity
        </button>
      )}
    </section>
  );
}
