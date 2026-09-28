import { useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type { CommandKind } from '@our-place/contracts';
import { suggestionCompleted } from './status.js';

export function SuggestionReleasePanel({
  client,
  state,
  id,
  onError,
  compact = false,
}: {
  client: ClientPlatform;
  state: ClientState;
  id: string;
  onError: (e: unknown) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const work = state.suggestions.work.filter((w) => w.suggestionId === id);
  const release = state.suggestions.releases?.find(
    (r) => r.suggestionId === id && r.runId === work[0]?.runId,
  );
  const ready =
    work[0]?.state === 'ready' && !work.some((w) => ['queued', 'running', 'uncertain'].includes(w.state));
  if (suggestionCompleted(state.suggestions, id) || (!release && !ready)) return null;
  const active = state.suggestions.releases?.some((r) =>
    ['queued', 'preparing', 'prepared', 'deploy_queued', 'deploying', 'uncertain'].includes(r.state),
  );
  async function action(kind: CommandKind, args: unknown) {
    if (!state.session) return;
    setBusy(true);
    try {
      const result = await client.command('suggestion-release-' + id, kind, args, state.session.serverEpoch);
      if (result.status === 'Rejected') throw new Error(result.code.replaceAll('_', ' '));
      await client.refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !state.online;
  return (
    <section className="suggestion-release" aria-label="Suggestion release">
      {!compact && release && <p>{release.summary}</p>}
      {release?.state === 'prepared' && release.manifest && (
        <>
          <p className="fine">
            Tested release {release.manifest.candidateCommit.slice(0, 8)} · web and Android
          </p>
          {!compact && (
            <ul className="fine">
              {release.manifest.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <p className="fine">
            Deploy restarts the server briefly. Install the new Android download to update the phone app.
          </p>
          <button
            className="primary"
            disabled={disabled}
            onClick={() =>
              void action('DeploySuggestionRelease', {
                releaseId: release.releaseId,
                manifestDigest: release.manifestDigest,
              })
            }
          >
            Deploy tested release
          </button>
        </>
      )}
      {release && ['queued', 'prepared', 'deploy_queued'].includes(release.state) && (
        <button
          disabled={disabled}
          onClick={() => void action('CancelSuggestionRelease', { releaseId: release.releaseId })}
        >
          Cancel release
        </button>
      )}
      {ready && !active && release?.state !== 'released' && (
        <button
          disabled={disabled}
          onClick={() =>
            void action('PrepareSuggestionRelease', {
              releaseId: crypto.randomUUID(),
              suggestionId: id,
              runId: work[0]!.runId,
            })
          }
        >
          Prepare release
        </button>
      )}
      {!compact && !release && (
        <p className="fine">
          Prepare integrates this suggestion and runs checks. The running app stays unchanged until you
          deploy.
        </p>
      )}
    </section>
  );
}
