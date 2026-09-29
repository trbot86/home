import { WebLink } from '../LinkedText.js';
import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { ShoppingSettings } from '@our-place/contracts';

export function IngredientStores({
  client,
  ingredients,
  appendNote,
}: {
  client: ClientPlatform;
  ingredients: string[];
  appendNote: (text: string) => void;
}) {
  const [settings, setSettings] = useState<ShoppingSettings | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [bulk, setBulk] = useState(false);
  useEffect(() => {
    let active = true;
    if (open)
      void client
        .shoppingSettings()
        .then((value) => {
          if (active) setSettings(value);
        })
        .catch(() => {
          if (active) setError('Could not load store preferences. Reconnect and reopen this section.');
        });
    return () => {
      active = false;
    };
  }, [client, open]);
  return (
    <div className="ingredient-stores">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setError('');
        }}
        aria-expanded={open}
      >
        Check nearby stores
      </button>
      {open && (
        <>
          <p className="fine">
            Search your preferred stores for each selected ingredient. These are search links, not confirmed
            stock or availability recommendations.
          </p>
          {error && <p role="alert">{error}</p>}
          {settings && (!settings.location || !settings.stores.length) && (
            <p>Set your location and preferred stores in Settings → Nearby shopping.</p>
          )}
          {settings?.location && !!settings.stores.length && (
            <>
              <label>
                <input type="checkbox" checked={bulk} onChange={(e) => setBulk(e.target.checked)} /> Larger
                order: include bulk stores
              </label>
              <p className="fine">Searching near {settings.location}. Change this in Settings.</p>
              {settings.stores
                .filter((store) => bulk || !store.bulk)
                .map((store) => (
                  <details key={store.name}>
                    <summary>
                      {store.name}
                      {store.bulk ? ' · larger orders' : ''}
                    </summary>
                    <ul>
                      {ingredients.map((ingredient, index) => {
                        const url = `https://www.google.com/search?q=${encodeURIComponent(`${store.name} ${settings.location} ${ingredient}`)}`;
                        return (
                          <li key={index}>
                            <WebLink client={client} href={url}>
                              Find {ingredient}
                            </WebLink>{' '}
                            <button
                              type="button"
                              onClick={() =>
                                appendNote(`${ingredient} — check ${store.name} (stock unverified)\n${url}`)
                              }
                            >
                              Save search to buying notes
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
