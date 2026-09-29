import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { FilingAdviceSettings } from '@our-place/contracts';
export function FilingSettings({ client, state }: { client: ClientPlatform; state: ClientState }) {
  const [settings, setSettings] = useState<FilingAdviceSettings | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [retry, setRetry] = useState(0);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    if (state.online)
      void client
        .filingAdviceSettings()
        .then((s) => {
          if (current) {
            setSettings(s);
            setError('');
          }
        })
        .catch(() => {
          if (current) setError('Could not load note suggestion settings. Try again.');
        });
    return () => {
      current = false;
    };
  }, [client, state.online, retry]);
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch {
      if (alive.current)
        setError(
          'Could not save. Reload settings before trying again; your permissions have not been confirmed.',
        );
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const blocked = busy || !state.online;
  return (
    <section className="storage" aria-label="Note suggestion settings">
      <p>
        For {state.session!.person.displayName}. These permissions apply to all of your notes in the selected
        scopes.
      </p>
      {!state.online && <p role="status">Reconnect to change suggestion settings.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <button disabled={blocked} onClick={() => setRetry((v) => v + 1)}>
          Reload suggestion settings
        </button>
      )}
      {!settings && !error && state.online && <p role="status">Loading suggestion settings…</p>}
      {settings && (
        <>
          {!settings.configured && (
            <p role="status">No provider is connected. Processing stays off even if you save permission.</p>
          )}
          <div className="filing-permissions">
            <p>
              Choose which inbox text this profile may send for suggestions. Photos, page contents, history
              and Secure items are excluded. Notes are never moved automatically.
            </p>
            <fieldset disabled={blocked}>
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                />
                Allow requests from this profile
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.automatic}
                  onChange={(e) => setSettings({ ...settings, automatic: e.target.checked })}
                />
                Automatically suggest filing for unfiled inbox items
              </label>
              <p>
                Automatic mode includes existing and new notes in the scopes below. Failed or changed notes
                require an explicit retry.
              </p>
              {state.session!.scopes.map((scope) => (
                <label key={scope.scopeId}>
                  <input
                    type="checkbox"
                    checked={settings.scopeIds.includes(scope.scopeId)}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        scopeIds: e.target.checked
                          ? [...settings.scopeIds, scope.scopeId]
                          : settings.scopeIds.filter((id) => id !== scope.scopeId),
                      })
                    }
                  />
                  {scope.kind === 'shared' ? 'Shared inbox text' : 'My private inbox text'}
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={settings.destinationTitles}
                  onChange={(e) => setSettings({ ...settings, destinationTitles: e.target.checked })}
                />
                Allow selected destination titles with the same visibility
              </label>
              <button
                type="button"
                disabled={settings.enabled && !settings.scopeIds.length}
                onClick={() =>
                  void act(async () => {
                    const { enabled, automatic, scopeIds, destinationTitles } = settings;
                    const saved = await client.saveFilingAdviceSettings(settings.revision, {
                      enabled,
                      automatic,
                      scopeIds,
                      destinationTitles,
                    });
                    if (alive.current) {
                      setSettings(saved);
                      setNotice('Suggestion permissions saved.');
                    }
                  })
                }
              >
                Save suggestion permissions
              </button>
            </fieldset>
          </div>
        </>
      )}
    </section>
  );
}
