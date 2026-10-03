import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import { Icon } from './Icon.js';
import type { useAppVersion } from './useAppVersion.js';

export function AppUpdates({
  client,
  online,
  onError,
  version,
  notice = false,
}: {
  client: ClientPlatform;
  online: boolean;
  onError: (error: unknown) => void;
  version: ReturnType<typeof useAppVersion>;
  notice?: boolean;
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
  if (notice && (version.update !== 'available' || !online)) return null;
  return (
    <section className="app-updates" aria-label={notice ? 'Phone app update' : 'App version and updates'}>
      {notice ? (
        <p role="status">
          <strong>A phone app update is available.</strong> Install the published app to get the latest
          changes.
        </p>
      ) : (
        <>
          <div className="section-heading">
            <div>
              <h2>Android app & updates</h2>
            </div>
            <Icon name="home" size={28} />
          </div>
          <p>
            {client.appVersion
              ? version.installed
                ? `Installed phone version ${version.installed.version} · build ${version.installed.sha256.slice(0, 8)}`
                : 'Installed phone version unavailable'
              : `Web version ${__APP_VERSION__}`}
          </p>
          {client.appVersion && (
            <p className="fine">
              {version.update === 'current'
                ? 'Your phone has the published app.'
                : version.update === 'available' && online
                  ? 'A phone app update is available.'
                  : 'Update check unavailable. You can try the installation page when connected.'}
            </p>
          )}
          <p>
            Open the household installation page to download the latest Android app. Install it over the
            existing app to keep your local drafts and settings.
          </p>
        </>
      )}
      {url && (
        <a
          className="update-link outlined-action"
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
      {!notice && (
        <details>
          <summary>Android widgets</summary>
          <p>
            Add two separate widgets: voice capture for a new inbox note, and tasks with completion and date
            controls.
          </p>
          {client.openWidgetSetup ? (
            <button onClick={() => void client.openWidgetSetup!().catch(onError)}>
              Set up Android widgets
            </button>
          ) : (
            <p>
              On your phone, open Settings in the installed app and choose Set up Android widgets. You can
              also long-press an empty part of the home screen, choose Widgets, then Our place.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
