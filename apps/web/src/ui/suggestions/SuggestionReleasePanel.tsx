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
  id?: string;
  onError: (e: unknown) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const work = state.suggestions.work.filter((w) => w.suggestionId === id);
  const all = state.suggestions.releases || [];
  const release = id
    ? all.find((r) => r.suggestionId === id && r.runId === work[0]?.runId)
    : all.find((r) =>
        ['queued', 'preparing', 'prepared', 'deploy_queued', 'deploying', 'uncertain'].includes(r.state),
      );
  const ready = work[0]?.state === 'ready';
  if (id && (suggestionCompleted(state.suggestions, id) || (!release && !ready))) return null;
  if (!id && !release) return null;
  const members =
    release?.members || (release ? [{ suggestionId: release.suggestionId, runId: release.runId }] : []);
  async function action(kind: CommandKind, args: unknown) {
    if (!state.session) return;
    setBusy(true);
    try {
      const result = await client.command(
        'suggestion-release-' + (release?.releaseId || id),
        kind,
        args,
        state.session.serverEpoch,
      );
      if (result.status === 'Rejected') throw new Error(result.code.replaceAll('_', ' '));
      await client.refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }
  const disabled = busy || !state.online;
  const active = all.some((r) =>
    ['queued', 'preparing', 'prepared', 'deploy_queued', 'deploying', 'uncertain'].includes(r.state),
  );
  return (
    <section className={`suggestion-release${id ? '' : ' suggestion-update-batch'}`} aria-label="Suggestion release">
      {!id && release && (
        <>
          <h3>
            {release.state === 'prepared' ? 'Update ready' : 'App update'} · {members.length} suggestion
            {members.length === 1 ? '' : 's'}
          </h3>
          <ul>
            {members.map((m) => (
              <li key={m.suggestionId}>
                {state.entries.find((e) => e.inboxId === m.suggestionId)?.text || 'App suggestion'}
              </li>
            ))}
          </ul>
        </>
      )}
      {!compact && release && <p>{release.summary}</p>}
      {!id && release?.state === 'prepared' && release.manifest && (
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
            Deploy update
          </button>
        </>
      )}
      {!id && release && ['queued', 'prepared', 'deploy_queued'].includes(release.state) && (
        <button
          disabled={disabled}
          onClick={() => void action('CancelSuggestionRelease', { releaseId: release.releaseId })}
        >
          Cancel release
        </button>
      )}
      {id && release && !active && ['failed', 'cancelled'].includes(release.state) && (
        <button
          disabled={disabled}
          onClick={() =>
            void action('RetrySuggestionRelease', {
              releaseId: release.releaseId,
              replacementReleaseId: crypto.randomUUID(),
            })
          }
        >
          Retry update checks
        </button>
      )}
      {id && release?.state === 'prepared' && (
        <p className="fine">Included in the tested update. Deploy it from the App suggestions list.</p>
      )}
      {!compact && !release && (
        <p className="fine">
          Implementation is ready. The host will include it in an update and run the combined release checks
          automatically.
        </p>
      )}
    </section>
  );
}
