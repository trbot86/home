import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { ShoppingSettings as Settings } from '@our-place/contracts';

export function ShoppingSettings({ client, state }: { client: ClientPlatform; state: ClientState }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    if (state.online)
      void client
        .shoppingSettings()
        .then((value) => {
          if (active) setSettings(value);
        })
        .catch(() => {
          if (active) setMessage('Could not load shopping preferences.');
        });
    return () => {
      active = false;
    };
  }, [client, state.online, reload]);
  return (
    <section className="storage" aria-label="Shopping preferences">
      <p>
        For {state.session!.person.displayName}, across your devices. These preferences build store searches;
        they do not verify stock. Your location is sent to a search provider only when you open a search link.
      </p>
      {settings && (
        <form
          className="task-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || !state.online) return;
            setBusy(true);
            setMessage('');
            const { revision, ...preferences } = settings;
            void client
              .shoppingSettings({ expectedRevision: revision, preferences })
              .then((value) => {
                setSettings(value);
                setMessage('Shopping preferences saved.');
              })
              .catch(() =>
                setMessage(
                  'Could not confirm the save. Retry, or reload if another device changed these settings.',
                ),
              )
              .finally(() => setBusy(false));
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.requestSubmit();
            }
          }}
        >
          <fieldset disabled={busy || !state.online}>
            <label className="task-field">
              City or postal code
              <input
                value={settings.location}
                maxLength={200}
                onChange={(e) => setSettings({ ...settings, location: e.target.value })}
              />
            </label>
            <label className="task-field">
              Default store
              <input
                value={settings.defaultStore ?? ''}
                maxLength={200}
                placeholder="Store assumed for ordinary ingredients"
                onChange={(e) => setSettings({ ...settings, defaultStore: e.target.value })}
              />
            </label>
            <p className="fine">
              Sourcing shows exceptions to this store. Missing information keeps the default assumption.
            </p>
            {settings.stores.map((store, index) => (
              <div className="shopping-store-setting" key={index}>
                <label className="task-field">
                  Store {index + 1}
                  <input
                    value={store.name}
                    required
                    maxLength={200}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        stores: settings.stores.map((s, i) =>
                          i === index ? { ...s, name: e.target.value } : s,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={store.bulk}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        stores: settings.stores.map((s, i) =>
                          i === index ? { ...s, bulk: e.target.checked } : s,
                        ),
                      })
                    }
                  />{' '}
                  Prefer for larger orders
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setSettings({ ...settings, stores: settings.stores.filter((_, i) => i !== index) })
                  }
                >
                  Remove store {index + 1}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={settings.stores.length >= 12}
              onClick={() =>
                setSettings({ ...settings, stores: [...settings.stores, { name: '', bulk: false }] })
              }
            >
              Add store
            </button>
          </fieldset>
          <button className="primary" disabled={busy || !state.online}>
            Save shopping preferences
          </button>
        </form>
      )}
      {!state.online && <p>Reconnect to change preferences.</p>}
      {message && <p role="status">{message}</p>}
      <button disabled={busy || !state.online} onClick={() => setReload((n) => n + 1)}>
        Reload shopping preferences
      </button>
    </section>
  );
}
