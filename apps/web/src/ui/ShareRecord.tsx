import { useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { SharingPreview } from '@our-place/contracts';

const kindNames: Record<string, string> = {
  inbox: 'note',
  task: 'task',
  task_occurrence: 'scheduled task',
  task_completion: 'completion',
  suggestion_workflow: 'suggestion discussion',
  suggestion_message: 'discussion message',
};
export function ShareRecord({
  client,
  state,
  recordId,
  scopeId,
  close,
}: {
  client: ClientPlatform;
  state: ClientState;
  recordId: string;
  scopeId: string;
  close: () => void;
}) {
  const [preview, setPreview] = useState<SharingPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (state.session?.scopes.find((scope) => scope.scopeId === scopeId)?.kind !== 'private')
    return <p>Shared with household</p>;
  async function review() {
    setBusy(true);
    setError('');
    try {
      setPreview(await client.sharingPreview(recordId));
    } catch {
      setError('Unable to review sharing. Connect and try again.');
    } finally {
      setBusy(false);
    }
  }
  async function share() {
    if (!preview || !state.session || busy) return;
    setBusy(true);
    setError('');
    try {
      const outcome = await client.command(
        recordId,
        'ShareRecords',
        { recordId, token: preview.token },
        state.session.serverEpoch,
      );
      if (outcome.status === 'Applied') {
        await client.refresh();
        close();
      } else {
        setPreview(null);
        setError('Sharing was not completed. Review again; related items may have changed.');
      }
    } catch {
      setError('Sharing could not be confirmed. Reconnect and refresh before trying again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Sharing">
      <p>Just me</p>
      {!preview ? (
        <button
          type="button"
          disabled={busy || !state.online || state.pendingEdits.includes(recordId)}
          onClick={() => void review()}
        >
          Share with household
        </button>
      ) : (
        <>
          <p>
            Share all {preview.records.length} items below, including photos, deleted items and previous
            history. This cannot be undone. Unsaved edits are kept on this device; save them before sharing if
            you want to include them.
          </p>
          {preview.notices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
          <ul>
            {preview.records.map((record) => (
              <li key={record.recordId}>
                {record.title} ({kindNames[record.kind] ?? record.kind.replaceAll('_', ' ')})
                {record.deleted ? ' — deleted' : ''}
              </li>
            ))}
          </ul>
          <button type="button" disabled={busy} onClick={() => void share()}>
            Share these items
          </button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)}>
            Cancel sharing
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
