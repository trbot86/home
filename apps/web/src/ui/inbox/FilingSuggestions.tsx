import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform, ClientState } from '@our-place/client';
import type {
  FilingAdvice,
  FilingAdviceReview,
  FilingAdviceSettings,
  InboxEntry,
} from '@our-place/contracts';
import { recordReferences } from '../RecordReferences.js';

export function FilingSuggestions({
  client,
  state,
  entry,
  choose,
  disabled,
}: {
  client: ClientPlatform;
  state: ClientState;
  entry: InboxEntry;
  choose: (choice: FilingAdvice) => void;
  disabled: boolean;
}) {
  const [secure, setSecure] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<FilingAdviceSettings | null>(null);
  const [review, setReview] = useState<FilingAdviceReview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [retry, setRetry] = useState(false),
    [notice, setNotice] = useState('');
  const alive = useRef(true),
    lock = useRef(false);
  const references = recordReferences(state).filter(
    (r) =>
      r.scopeId === entry.scopeId &&
      r.deletedAt === null &&
      ['Project', 'Project page', 'Shopping list', 'Task'].includes(r.label),
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setSecure(null);
    setReview(null);
    setRetry(false);
    if (state.online)
      void Promise.all([
        client.filingAdviceSettings(),
        client.filingAdvice(entry.inboxId),
        client.recordSecurity(entry.inboxId),
      ])
        .then(([config, result, security]) => {
          if (current) {
            setSecure(security.effective);
            setSettings(config);
            setReview(result.review);
            setError('');
          }
        })
        .catch(() => {
          if (current) setError('Could not load suggestions. Reopen when connected.');
        });
    return () => {
      current = false;
    };
  }, [client, entry.inboxId, entry.revision, state.online]);
  useEffect(() => {
    let current = true;
    if (state.online && entry.filingAdvice)
      void client
        .filingAdvice(entry.inboxId)
        .then((result) => {
          if (current) setReview(result.review);
        })
        .catch(() => {});
    return () => {
      current = false;
    };
  }, [client, entry.inboxId, entry.filingAdvice?.state, entry.filingAdvice?.count, state.online]);
  async function act(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch {
      if (alive.current)
        setError('Could not finish. Refresh suggestions before retrying; your note is unchanged.');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const blocked = busy || !state.online || disabled;
  const canRequest =
    secure === false && settings?.configured && settings.enabled && settings.scopeIds.includes(entry.scopeId);
  return (
    <section aria-label="Filing suggestions" className="filing-suggestions">
      <h3>Filing suggestions</h3>
      {secure && <p>Secure items are excluded from AI context. Manage Secure in the note editor.</p>}
      <p>Suggestions never move a note by themselves. Review a choice, then press File note.</p>
      {!state.online && <p role="status">Reconnect to manage or request suggestions.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {settings && (
        <>
          {!settings.configured && (
            <p role="status">No provider is connected. Processing stays off even if you save permission.</p>
          )}
          <details>
            <summary>Suggestion setup</summary>
            <p>
              Choose what this profile may send. Text and titles can contain secrets. Photos, captions, page
              contents, history and other notes are excluded. Using a model does not by itself guarantee
              confidentiality or no training. Secure items and items inside Secure containers are always
              excluded.
            </p>
            <fieldset disabled={blocked}>
              <label>
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                />
                Allow requests from this profile
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.automatic}
                  onChange={(e) => setSettings({ ...settings, automatic: e.target.checked })}
                />
                Automatically suggest filing for unfiled inbox items
              </label>
              <p>
                Automatic mode includes existing and new items in the scopes below. It checks every few
                seconds and sends one item at a time. If destination titles are allowed, it discovers up to 20
                recently updated destinations with the same visibility. Failed or changed items require an
                explicit retry. Signing out or session expiry pauses automatic processing; save permissions
                again after signing in.
              </p>
              {state.session!.scopes.map((scope) => (
                <label key={scope.scopeId}>
                  <input
                    type="checkbox"
                    checked={settings.scopeIds.includes(scope.scopeId)}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        scopeIds: e.target.checked
                          ? [...settings.scopeIds, scope.scopeId]
                          : settings.scopeIds.filter((id) => id !== scope.scopeId),
                      })
                    }
                  />
                  {scope.kind === 'shared' ? 'Shared inbox text' : 'My private inbox text'}
                </label>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={settings.destinationTitles}
                  onChange={(e) => setSettings({ ...settings, destinationTitles: e.target.checked })}
                />
                Allow selected destination titles with the same visibility
              </label>
              <button
                type="button"
                disabled={settings.enabled && !settings.scopeIds.length}
                onClick={() =>
                  void act(async () => {
                    const { enabled, automatic, scopeIds, destinationTitles } = settings;
                    const saved = await client.saveFilingAdviceSettings(settings.revision, {
                      enabled,
                      automatic,
                      scopeIds,
                      destinationTitles,
                    });
                    if (alive.current) {
                      setSettings(saved);
                      setNotice('Suggestion permissions saved.');
                    }
                  })
                }
              >
                Save suggestion permissions
              </button>
            </fieldset>
          </details>
          {!settings.enabled && <p>Suggestions are off for this profile.</p>}
          {settings.destinationTitles && (
            <label>
              Optional destination titles (up to 20)
              <select
                multiple
                aria-label="Suggestion destination context"
                disabled={blocked}
                value={selected}
                onChange={(e) =>
                  setSelected(Array.from(e.target.selectedOptions, (o) => o.value).slice(0, 20))
                }
              >
                {references.map((r) => (
                  <option key={r.recordId} value={r.recordId}>
                    {r.label}: {r.title.slice(0, 200)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {review?.state === 'complete' && !review.choices.length && (
            <p>No matching suggestion. You can still file this note yourself.</p>
          )}
          {review?.state === 'stale' && (
            <p>This note or a destination changed. Previous suggestions are hidden.</p>
          )}
          {review?.state === 'failed' && <p>The last attempt did not produce a usable suggestion.</p>}
          {review?.state === 'attempted' && (
            <p>
              The request may still be running, or was interrupted. Refresh to check. A retry is blocked for
              the first minute.
            </p>
          )}
          {review?.choices.map((choice, index) => {
            const target =
              choice.kind === 'existing' ? references.find((r) => r.recordId === choice.recordId) : null;
            if (choice.kind === 'existing' && !target) return null;
            const label =
              choice.kind === 'category'
                ? choice.category
                : `${target!.label}: ${target!.title.slice(0, 100)}`;
            return (
              <button
                type="button"
                key={index}
                disabled={blocked}
                onClick={() => {
                  choose(choice);
                  setNotice('Suggestion selected. Review the filing form, then press File note.');
                }}
              >
                Review suggestion: {label}
              </button>
            );
          })}
          {review && review.state !== 'complete' && (
            <label>
              <input
                type="checkbox"
                disabled={blocked}
                checked={retry}
                onChange={(e) => setRetry(e.target.checked)}
              />
              Send this item again; an interrupted attempt may already have reached the provider
            </label>
          )}
          {(!review || review.state !== 'complete') && (
            <button
              type="button"
              disabled={blocked || !canRequest || (!!review && !retry)}
              onClick={() =>
                void act(async () => {
                  const result = await client.filingAdvice(entry.inboxId, {
                    expectedRevision: entry.revision,
                    expectedAttempt: review?.attempt ?? 0,
                    destinationIds: settings.destinationTitles ? selected : [],
                  });
                  if (alive.current) {
                    setReview(result.review);
                    setRetry(false);
                  }
                  await client.refresh();
                })
              }
            >
              {busy ? 'Requesting suggestions…' : review ? 'Retry suggestions' : 'Suggest filing'}
            </button>
          )}
          <button
            type="button"
            disabled={blocked}
            onClick={() =>
              void act(async () => {
                const [config, result, security] = await Promise.all([
                  client.filingAdviceSettings(),
                  client.filingAdvice(entry.inboxId),
                  client.recordSecurity(entry.inboxId),
                ]);
                if (alive.current) {
                  setSecure(security.effective);
                  setSettings(config);
                  setReview(result.review);
                  setRetry(false);
                }
              })
            }
          >
            Refresh suggestions
          </button>
        </>
      )}
    </section>
  );
}
