import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { BackupStatus } from '@our-place/contracts';
import { Icon } from './Icon.js';
const date = (value: number) => new Date(value).toLocaleString();
const size = (value: number) =>
  value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MB`;
export function BackupPanel({
  client,
  online,
  onError,
}: {
  client: ClientPlatform;
  online: boolean;
  onError: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setStatus(await client.backups());
  };
  useEffect(() => {
    void refresh().catch(onError);
    const timer = setInterval(() => {
      if (online) void refresh().catch(onError);
    }, 5000);
    return () => clearInterval(timer);
  }, [client, online]);
  async function create() {
    setBusy(true);
    try {
      await client.createBackup();
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="backups">
      <div className="section-heading">
        <div>
          <p className="eyebrow">A way back</p>
          <h2>Household backups</h2>
        </div>
        <button
          className="primary"
          disabled={!online || busy || status?.running || !status?.destinationAvailable}
          onClick={() => {
            void create();
          }}
        >
          <Icon name="plus" size={16} />
          {busy || status?.running ? 'Making a backup…' : 'Back up now'}
        </button>
      </div>
      <p className="fine">
        A snapshot of the household database and its original photos. You can keep using the app while it
        saves.
      </p>
      {status && !status.destinationAvailable && (
        <p className="notice">
          {status.configured
            ? 'The backup folder is unavailable. Your household data is still accessible.'
            : 'Choose a dedicated backup folder during server setup to enable exports.'}
        </p>
      )}
      <div className="backup-list">
        {status?.runs.slice(0, 8).map((run) => (
          <article key={run.runId}>
            <span className="storage-icon">
              <Icon name={run.available ? 'check' : 'clock'} />
            </span>
            <div>
              <strong>{date(run.snapshotAt ?? run.startedAt)}</strong>
              <p className="fine">
                {run.state === 'complete'
                  ? run.available
                    ? 'Export available'
                    : 'Export not found at last check'
                  : run.state === 'running'
                    ? 'Saving and verifying…'
                    : run.state === 'pruned'
                      ? 'Removed by local retention policy'
                      : 'Export did not finish'}
                {run.verifiedAt ? ` · Verified ${date(run.verifiedAt)}` : ''}
              </p>
            </div>
            <span>{run.byteLength === null ? '—' : size(run.byteLength)}</span>
          </article>
        ))}
      </div>
      {!status?.runs.length && <p className="fine backup-empty">Your completed backups will appear here.</p>}
      <div className="external-backup">
        <Icon name="home" size={18} />
        <div>
          <strong>
            {status?.externalStatus === 'verified'
              ? 'Secondary copy verified'
              : status?.externalStatus === 'failed'
                ? 'Secondary copy needs attention'
                : 'Secondary copy not reported'}
          </strong>
          <p>
            {status?.secondaryCopy
              ? `Checked ${date(status.secondaryCopy.checkedAt)}.${status.secondaryCopy.snapshotAt ? ` Latest copied snapshot: ${date(status.secondaryCopy.snapshotAt)}.` : ''} This reports the last copy check, not live drive availability.`
              : 'A separate destination protects your completed backups if the server drive fails.'}
          </p>
        </div>
      </div>
      {status && (
        <p className="fine">
          Availability checked {date(status.checkedAt)}. Backup files are managed on the server.
        </p>
      )}
    </section>
  );
}
