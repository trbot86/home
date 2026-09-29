import { useEffect, useState } from 'react';
import type { ClientPlatform, ClientState, StorageUsage } from '@our-place/client';
import { Icon } from './Icon.js';
import { date, size } from './format.js';

export function Storage({
  client,
  state,
  onError,
}: {
  client: ClientPlatform;
  state: ClientState;
  onError: (error: unknown) => void;
}) {
  const [server, setServer] = useState<StorageUsage | null>(null);
  const [local, setLocal] = useState<StorageEstimate | null>(null);
  const [nativeSizes, setNativeSizes] = useState<{ databaseBytes: number; mediaBytes: number } | null>(null);
  const refresh = () => {
    void client.storage().then(setServer).catch(onError);
    if (client.localStorage)
      void client
        .localStorage()
        .then((value) => {
          setNativeSizes(value);
          setLocal({ usage: value.databaseBytes + value.mediaBytes });
        })
        .catch(onError);
    else void navigator.storage?.estimate().then(setLocal);
  };
  useEffect(refresh, [client]);
  return (
    <section className="storage">
      <div className="section-heading">
        <h2>Storage</h2>
        <button onClick={refresh}>
          <Icon name="refresh" size={16} />
          Refresh sizes
        </button>
      </div>
      <div className="storage-grid">
        <article>
          <span className="storage-icon">
            <Icon name="home" size={26} />
          </span>
          <h3>Household server</h3>
          <p>Your shared records and original photos.</p>
          <dl>
            <div>
              <dt>Database & companion files</dt>
              <dd>{size(server?.databaseBytes)}</dd>
            </div>
            <div>
              <dt>Photos</dt>
              <dd>{size(server?.mediaBytes)}</dd>
            </div>
            <div>
              <dt>Uploads in progress</dt>
              <dd>{size(server?.stagingBytes)}</dd>
            </div>
          </dl>
          <p className="fine">
            {server ? `Measured ${date(server.sampledAt)}` : 'Connect to the server to measure storage.'}
          </p>
        </article>
        <article>
          <span className="storage-icon">
            <Icon name="inbox" size={26} />
          </span>
          <h3>{client.localStorage ? 'This phone' : 'This browser'}</h3>
          <p>Your local drafts, pending saves and cached entries.</p>
          <dl>
            {client.localStorage && (
              <>
                <div>
                  <dt>Database & companion files</dt>
                  <dd>{size(nativeSizes?.databaseBytes)}</dd>
                </div>
                <div>
                  <dt>Photos & cached media</dt>
                  <dd>{size(nativeSizes?.mediaBytes)}</dd>
                </div>
              </>
            )}
            <div>
              <dt>Estimated storage used</dt>
              <dd>{size(local?.usage)}</dd>
            </div>
            <div>
              <dt>Pending captures</dt>
              <dd>{state.drafts.filter((d) => d.state === 'SUBMITTED').length}</dd>
            </div>
            <div>
              <dt>Unfinished drafts</dt>
              <dd>
                {
                  state.drafts.filter((d) => d.state === 'DRAFT' && (d.text.trim() || d.attachments.length))
                    .length
                }
              </dd>
            </div>
          </dl>
          <p className="fine">
            {client.localStorage
              ? 'Native database, pending photos and saved local media.'
              : 'Browser estimates include this site’s local storage.'}
          </p>
        </article>
      </div>
    </section>
  );
}
