import { useState } from 'react';
import type { ActivityItem, ClientPlatform, ClientState } from '@our-place/client';
import type { RecordReference } from '../RecordReferences.js';
import { AttachmentGallery } from '../AttachmentGallery.js';
import { LinkedText } from '../LinkedText.js';
import { Icon } from '../Icon.js';
const labels = { task: 'Task completed', purchase: 'Bought', cooking: 'Cooked', maintenance: 'Maintenance' };
const icons = { task: 'check', purchase: 'shopping', cooking: 'food', maintenance: 'home' } as const;
export function ActivityCard({
  item,
  client,
  state,
  references,
  onRecord,
}: {
  item: ActivityItem;
  client: ClientPlatform;
  state: ClientState;
  references: Map<string, RecordReference>;
  onRecord: (record: RecordReference) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const session = state.session!,
    timeZone = state.tasks.timeZone;
  const time = (value: number) =>
    new Intl.DateTimeFormat(undefined, { timeZone, hour: 'numeric', minute: '2-digit' }).format(value);
  const open = (id: string) => {
    const record = references.get(id);
    if (record) onRecord(record);
  };
  return (
    <article
      className="activity-card"
      key={item.recordId}
      aria-label={`${item.kinds.map((kind) => labels[kind]).join(' / ')}: ${item.title}`}
    >
      <div className="activity-mark">
        <Icon name={icons[item.kinds[0]!]} />
      </div>
      <div className="activity-content">
        <div className="activity-meta">
          <span>
            {item.kinds.map((kind) => labels[kind]).join(' / ')} · {item.personName ?? 'Person not recorded'}
          </span>
          <time dateTime={new Date(item.occurredAt).toISOString()}>{time(item.occurredAt)}</time>
        </div>
        <h3>{item.title}</h3>
        <p className="activity-audience">
          {item.context === 'work' ? 'Work' : 'Home'}
          {session.scopes.find((s) => s.scopeId === item.scopeId)?.kind === 'private'
            ? ' · Just me'
            : ' · Shared'}
          {item.sourceDeleted ? ' · Source deleted; record retained' : ''}
        </p>
        {(item.notes.length > 0 || item.attachments.length > 0) && (
          <details className="activity-details" onToggle={(e) => setExpanded(e.currentTarget.open)}>
            <summary>Notes & photos{item.attachments.length ? ` · ${item.attachments.length}` : ''}</summary>
            {expanded &&
              item.notes.map((note, index) => (
                <p className="activity-note" key={index}>
                  <LinkedText client={client} text={note} />
                </p>
              ))}
            {expanded && <AttachmentGallery client={client} attachments={item.attachments} />}
          </details>
        )}
        <div className="activity-actions">
          {references.has(item.recordId) && (
            <button
              disabled={!state.online}
              title={!state.online ? 'Reconnect to load full record history.' : undefined}
              onClick={() => open(item.recordId)}
            >
              Open history
            </button>
          )}
          {item.links
            .filter((link) => references.has(link.recordId))
            .map((link) => (
              <button key={link.recordId} onClick={() => open(link.recordId)}>
                {link.label}
              </button>
            ))}
        </div>
      </div>
    </article>
  );
}
