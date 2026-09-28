import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import type {
  FilingAdvice,
  FilingAdviceReview,
  FilingAdviceSettings,
  InboxEntry,
} from '@our-place/contracts';
import { FilingAdviceActions } from './FilingAdviceActions.js';
import './filing.css';

export function FilingSuggestions({
  client,
  state,
  entry,
  choose,
  disabled,
  onSettings,
  run,
  done,
  compact = false,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  choose: (choice: FilingAdvice, preserveDraft?: boolean) => void;
  disabled: boolean;
  onSettings: () => void;
  run: RunRecordCommand;
  done: () => void;
  compact?: boolean;
}) {
  const cached = (): FilingAdviceReview | null =>
    entry.filingAdvice?.attempt !== undefined
      ? {
          state: entry.filingAdvice.state,
          attempt: entry.filingAdvice.attempt,
          choices: entry.filingAdvice.choices ?? [],
        }
      : null;
  const [review, setReview] = useState(cached),
    [settings, setSettings] = useState<FilingAdviceSettings | null>(null);
  const [secure, setSecure] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setReview(cached());
  }, [entry.revision, entry.filingAdvice]);
  useEffect(() => {
    let current = true;
    if (state.online && (!compact || expanded))
      void Promise.all([
        client.filingAdviceSettings(),
        client.filingAdvice(entry.inboxId),
        client.recordSecurity(entry.inboxId),
      ])
        .then(([config, result, security]) => {
          if (current) {
            setSettings(config);
            setReview(result.review);
            setSecure(security.effective);
          }
        })
        .catch(() => {
          if (current) setError('Could not load suggestions. Try again when connected.');
        });
    return () => {
      current = false;
    };
  }, [client, entry.inboxId, entry.revision, state.online, compact, expanded]);
  async function request(refreshOnly = false) {
    if (lock.current || disabled || !state.online) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const [config, result, security] = await Promise.all([
        client.filingAdviceSettings(),
        client.filingAdvice(entry.inboxId),
        client.recordSecurity(entry.inboxId),
      ]);
      if (!alive.current) return;
      setSettings(config);
      setSecure(security.effective);
      setReview(result.review);
      if (refreshOnly) return;
      if (security.effective) {
        setError('Secure notes are excluded from suggestions.');
        return;
      }
      if (!config.configured) {
        setError('The suggestion service is not connected.');
        return;
      }
      if (!config.enabled || !config.scopeIds.includes(entry.scopeId)) {
        setError('Enable suggestions for this visibility in Settings.');
        setExpanded(true);
        return;
      }
      if (result.review?.state === 'complete') return;
      const response = await client.filingAdvice(entry.inboxId, {
        expectedRevision: entry.revision,
        expectedAttempt: result.review?.attempt ?? 0,
      });
      if (alive.current) setReview(response.review);
      await client.refresh();
    } catch {
      if (alive.current)
        setError('Suggestions are unavailable right now. Your note is unchanged; try again shortly.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const blocked = disabled || busy || !state.online;
  return (
    <section aria-label="Filing suggestions" className={`filing-suggestions ${compact ? 'compact' : ''}`}>
      {review?.state === 'complete' && review.choices.length > 0 && (
        <>
          <span className="filing-suggestion-label">Suggested</span>
          <FilingAdviceActions
            client={client}
            state={state}
            entry={entry}
            review={review}
            run={run}
            disabled={blocked}
            edit={choose}
            done={done}
          />
        </>
      )}
      {review?.state === 'failed' && <p role="status">Suggestions couldn't be loaded. Try again.</p>}
      {review?.state === 'stale' && <p role="status">Suggestions changed. Refresh them before filing.</p>}
      {review?.state === 'attempted' && <p role="status">Getting suggestions…</p>}
      {review?.state === 'complete' && !review.choices.length && (
        <p>No confident match. Choose a destination yourself.</p>
      )}
      {error && <p role="status">{error}</p>}
      {review?.state !== 'complete' && (
        <button
          type="button"
          disabled={blocked || secure === true || settings?.enabled === false}
          title={review ? 'Try suggesting this note again' : ''}
          onClick={() => void request(review?.state === 'attempted')}
        >
          {busy
            ? 'Getting suggestions…'
            : review?.state === 'attempted'
              ? 'Check suggestions'
              : review
                ? 'Retry suggestions'
                : 'Suggest filing'}
        </button>
      )}
      <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
        <summary>More options</summary>
        {secure && <p>Secure notes are excluded from suggestions.</p>}
        <button type="button" onClick={onSettings}>
          Manage note suggestions in Settings
        </button>
        <button type="button" disabled={blocked} onClick={() => void request(true)}>
          Refresh suggestions
        </button>
        {review?.state === 'attempted' && (
          <>
            <button type="button" disabled={blocked} onClick={() => void request()}>
              Retry interrupted request
            </button>
            <p className="fine">
              Wait at least a minute before retrying. The earlier request may already have been sent.
            </p>
          </>
        )}
        <p className="fine">
          Tap a suggestion to file. Undo restores the note. Titles are selected automatically using your
          Settings permissions.
        </p>
      </details>
    </section>
  );
}
