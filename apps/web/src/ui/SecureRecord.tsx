import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { RecordSecurity } from '@our-place/contracts';

export function SecureRecord({
  client,
  state,
  recordId,
}: {
  client: ClientPlatform;
  state: ClientState;
  recordId: string;
}) {
  const [value, setValue] = useState<RecordSecurity | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setValue(null);
    if (state.online)
      void client
        .recordSecurity(recordId)
        .then((next) => {
          if (alive) {
            setValue(next);
            setError('');
          }
        })
        .catch(() => {
          if (alive) setError('Could not load Secure status. Reopen when connected.');
        });
    return () => {
      alive = false;
    };
  }, [client, recordId, state.online, state.session?.clientId]);
  async function save(secure: boolean) {
    if (!value || !state.session || busy) return;
    setBusy(true);
    setError('');
    try {
      setValue(
        await client.recordSecurity(recordId, {
          secure,
          expectedRevision: value.revision,
          expectedServerEpoch: state.session.serverEpoch,
        }),
      );
      await client.refresh();
    } catch {
      setValue(null);
      setError(
        'Secure change could not be confirmed. Reopen when connected to check before adding sensitive text.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="AI privacy">
      <label>
        <input
          type="checkbox"
          checked={value?.secure ?? false}
          disabled={!state.online || !value || busy || state.pendingEdits.includes(recordId)}
          onChange={(event) => void save(event.target.checked)}
        />
        Secure — exclude from AI context
      </label>
      {value?.effective && !value.secure && (
        <p>
          Protected by a Secure container. Turning this item's own flag off cannot remove that protection.
        </p>
      )}
      <p>
        Applies to this item and its contained items. This prevents future AI requests; it cannot recall
        content already sent. It does not encrypt the item.
      </p>
      {state.online && !value && !error && <p>Checking Secure status…</p>}
      {busy && <p>Saving Secure setting…</p>}
      {!state.online && <p>Reconnect to check or change Secure status.</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
