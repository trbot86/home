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
  const [selected, setSelected] = useState<string[]>([]);
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
  const seen = new Set<string>();
  const candidates = state.suggestions.work.filter((w) => {
    if (seen.has(w.suggestionId)) return false;
    seen.add(w.suggestionId);
    return (
      w.state === 'ready' &&
      w.runId &&
      !suggestionCompleted(state.suggestions, w.suggestionId) &&
      state.entries.some((e) => e.inboxId === w.suggestionId && e.deletedAt === null) &&
      !all.some((r) => r.runId === w.runId && r.state === 'released')
    );
  });
  const chosen = candidates.filter((w) => selected.includes(w.runId!));
  const selectedScope = state.entries.find((e) => e.inboxId === chosen[0]?.suggestionId)?.scopeId;
  if (!id && !release && !candidates.length) return null;
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
      setSelected([]);
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
    <section
      className={`suggestion-release${id ? '' : ' suggestion-update-batch'}`}
      aria-label="Suggestion release"
    >
      {!id && !active && candidates.length > 0 && (
        <>
          <h3>Ready for update</h3>
          <p>
            Choose suggestions to combine. Prepare selected integrates them and runs release tests; Deploy
            update appears when they pass.
          </p>
          <div className="suggestion-release-choices">
            {candidates.map((w) => {
              const entry = state.entries.find((e) => e.inboxId === w.suggestionId)!;
              const previous = all.find((r) => r.runId === w.runId);
              return (
                <label key={w.runId}>
                  <input
                    type="checkbox"
                    checked={selected.includes(w.runId!)}
                    disabled={
                      disabled ||
                      (!selected.includes(w.runId!) &&
                        (chosen.length >= 20 ||
                          (selectedScope !== undefined && entry.scopeId !== selectedScope)))
                    }
                    onChange={(e) =>
                      setSelected((current) =>
                        e.target.checked ? [...current, w.runId!] : current.filter((r) => r !== w.runId),
                      )
                    }
                  />
                  <span>
                    {entry.text}
                    {previous?.state === 'failed' && <small>{previous.summary}</small>}
                  </span>
                </label>
              );
            })}
          </div>
          <p className="fine">
            Select up to 20 suggestions with the same visibility. Failed checks can be retried here.
          </p>
          <button
            className="primary"
            disabled={disabled || !chosen.length}
            onClick={() =>
              void action('PrepareSuggestionBatch', {
                releaseId: crypto.randomUUID(),
                members: chosen.map((w) => ({ suggestionId: w.suggestionId, runId: w.runId! })),
              })
            }
          >
            Prepare selected ({chosen.length})
          </button>
        </>
      )}
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
          Implementation is ready. Select it in the App suggestions list to prepare and test a combined
          update.
        </p>
      )}
    </section>
  );
}
