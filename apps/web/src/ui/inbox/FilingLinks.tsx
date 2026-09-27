import type { ClientState } from '@our-place/client';
import { filingOf, type InboxEntry } from '@our-place/contracts';
import { recordReferences, type RecordReference } from '../RecordReferences.js';
import { useNoteLinks } from '../NoteLinks.js';

export function FilingLinks({
  entry,
  state,
  open,
  remove,
}: {
  entry: InboxEntry;
  state: ClientState;
  open: (record: RecordReference) => void;
  remove?: (recordId: string) => void;
}) {
  const refs = new Map(recordReferences(state).map((r) => [r.recordId, r]));
  const destinations = filingOf(entry).destinations;
  if (!destinations.length) return null;
  return (
    <div className="filing-links" aria-label="Filed destinations">
      {destinations.map((d) => {
        const target = refs.get(d.recordId);
        return (
          <div key={d.recordId}>
            {target && target.deletedAt === null ? (
              <button onClick={() => open(target)}>
                {target.label}: {target.title}
              </button>
            ) : (
              <span>Destination unavailable · original note kept</span>
            )}
            {remove && (
              <button
                aria-label={`Unlink ${target?.title ?? 'unavailable destination'}`}
                title="Remove this link; keep the destination"
                disabled={
                  !state.online || state.pendingEdits.includes(entry.inboxId) || entry.deletedAt !== null
                }
                onClick={() => remove(d.recordId)}
              >
                Unlink
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Backlinks are derived only from the current person's authorised captures. */
export function CaptureSources({ recordId, state }: { recordId: string; state: ClientState }) {
  const links = useNoteLinks();
  const sources = state.entries.filter(
    (e) => e.deletedAt === null && filingOf(e).destinations.some((d) => d.recordId === recordId),
  );
  if (!sources.length) return null;
  return (
    <div className="capture-sources" aria-label="Original captures">
      {sources.map((source) => (
        <button key={source.inboxId} onClick={() => void links?.open(source.inboxId).catch(() => {})}>
          Original note{source.attachments.length ? ' & photos' : ''}:{' '}
          {source.text.trim().split(/\r?\n/)[0]?.slice(0, 90) || 'Photo capture'}
        </button>
      ))}
    </div>
  );
}
