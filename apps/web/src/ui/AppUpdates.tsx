import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { Icon } from './Icon.js';

export function AppUpdates({
  client,
  online,
  onError,
}: {
  client: ClientPlatform;
  online: boolean;
  onError: (error: unknown) => void;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let alive = true;
    void (client.serverAddress ? client.serverAddress() : Promise.resolve(window.location.origin))
      .then((origin) => {
        if (alive) setUrl(new URL('/install/', origin).href);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [client]);
  return (
    <section className="app-updates">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Keep Our place close</p>
          <h2>Android app & updates</h2>
        </div>
        <Icon name="home" size={28} />
      </div>
      <p>
        Open the household installation page to download the latest Android app. Install it over the existing
        app to keep your local drafts and settings.
      </p>
      {url && (
        <a
          className="update-link"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          aria-disabled={!online}
          onClick={(event) => {
            if (!online) {
              event.preventDefault();
              return;
            }
            if (client.openExternalUrl) {
              event.preventDefault();
              void client.openExternalUrl(url).catch(onError);
            }
          }}
        >
          Open Android installation page <Icon name="arrow" size={17} />
        </a>
      )}
      <p className="fine">
        {online
          ? 'Your phone handles the download and asks before installing.'
          : 'Reconnect to the household server to check for an update.'}
      </p>
    </section>
  );
}
