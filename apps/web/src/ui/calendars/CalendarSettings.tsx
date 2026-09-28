import { useEffect, useRef, useState } from 'react';
import type { CalendarSettings as Settings, BeginCalendarConnection } from '@our-place/contracts';
import type { ClientPlatform, ClientState, RunRecordCommand } from '@our-place/client';
import { Icon } from '../Icon.js';
import { date } from '../format.js';
import './calendars.css';

function connectionError(error: unknown) {
  const code = error instanceof Error ? error.message.replaceAll(' ', '_') : '';
  if (
    [
      'calendar_authorization_expired',
      'calendar_authorization_restart_required',
      'calendar_connection_changed',
    ].includes(code)
  )
    return 'This connection expired or belongs to another session. Start again from the profile you want to connect.';
  if (code === 'calendar_account_mismatch')
    return 'That is a different Google account. Reconnect with the original account, or add it as a separate connection.';
  if (code === 'calendar_account_already_connected')
    return 'This Google account is already connected to your profile.';
  if (code === 'calendar_authentication_required')
    return 'Google access could not be verified. Start again and allow the requested calendar access.';
  if (code === 'calendar_not_configured') return 'Google Calendar has not been set up on this server yet.';
  return 'Could not reach the calendar service. Your saved household data is unchanged; try again when connected.';
}
export function CalendarSettings({
  client,
  state,
  run,
}: {
  client: ClientPlatform;
  state: ClientState;
  run: RunRecordCommand;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [busy, setBusy] = useState(false),
    [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading'),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [label, setLabel] = useState('Google account'),
    [externalUrl, setExternalUrl] = useState(''),
    [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [handoffId, setHandoffId] = useState(() =>
    new URL(window.location.href).searchParams.get('calendarConnect'),
  );
  const alive = useRef(true),
    operation = useRef(false);
  const browser = !!client.calendarSettings;
  const person = state.session!.person,
    privateScope = state.session!.scopes.find((s) => s.kind === 'private')!,
    sharedScope = state.session!.scopes.find((s) => s.kind === 'shared')!;
  useEffect(() => {
    alive.current = true;
    if (!browser)
      void client.serverAddress!()
        .then((origin) => {
          if (alive.current) setExternalUrl(new URL('/?settings=calendars', origin).href);
        })
        .catch((e) => {
          if (alive.current) setError(connectionError(e));
        });
    return () => {
      alive.current = false;
    };
  }, [client, browser]);
  useEffect(() => {
    let current = true;
    if (browser && state.online) {
      setLoadState('loading');
      void client.calendarSettings!()
        .then((value) => {
          if (current) {
            setSettings(value);
            setLoadState('ready');
            setError('');
          }
        })
        .catch((e) => {
          if (current) {
            setLoadState('error');
            setError(connectionError(e));
          }
        });
    }
    return () => {
      current = false;
    };
  }, [client, browser, state.online]);
  async function act(work: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(connectionError(e));
    } finally {
      operation.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function reload() {
    setLoadState('loading');
    try {
      const value = await client.calendarSettings!();
      if (alive.current) {
        setSettings(value);
        setLoadState('ready');
      }
    } catch (e) {
      if (alive.current) setLoadState('error');
      throw e;
    }
  }
  const available = state.online && loadState === 'ready' && !!settings?.configured;
  const connectHelp = !state.online
    ? 'Reconnect to the household server to connect a Google account.'
    : loadState === 'loading'
      ? 'Loading calendar settings…'
      : loadState === 'error'
        ? 'Calendar settings could not be loaded. Try again before connecting an account.'
        : !settings?.configured
          ? 'Google Calendar isn’t set up on this server yet. The household owner needs to set up Google access before you can connect an account. Entering a label cannot add a calendar until setup is complete.'
          : 'Google opens in this browser to ask for access. Event editing stays in Google Calendar for now.';
  function clearHandoff() {
    setHandoffId(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('calendarConnect');
    window.history.replaceState(null, '', url);
  }
  async function begin(reconnect?: BeginCalendarConnection['reconnect'], existingLabel?: string) {
    if (!available || (!reconnect && !label.trim())) return;
    const result = await client.beginCalendarConnection!({
      label: existingLabel ?? (label.trim() || 'Google account'),
      ...(reconnect ? { reconnect } : {}),
    });
    if (!alive.current) return;
    const url = new URL(result.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth')
      throw new Error('invalid_calendar_destination');
    window.location.assign(url.href);
  }
  return (
    <section className="calendar-settings" aria-labelledby="calendar-settings-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your day, in one place</p>
          <h2 id="calendar-settings-title">Google Calendar</h2>
        </div>
        <Icon name="tasks" size={26} />
      </div>
      <p>
        Connect calendars for <strong>{person.displayName}</strong>. Work calendars stay private. Choose
        explicitly which home calendars to share.
      </p>
      {!state.online && <p role="status">Reconnect to the household server to manage calendars.</p>}
      {error && (
        <p className="calendar-message calendar-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="calendar-message" role="status">
          {notice}
        </p>
      )}
      {!browser ? (
        <>
          <p>
            Use your browser to connect Google securely. Select {person.displayName} there before connecting;
            your Android drafts stay here.
          </p>
          {externalUrl && (
            <a
              className="update-link"
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={!state.online}
              onClick={(e) => {
                if (!state.online) e.preventDefault();
                else if (client.openExternalUrl) {
                  e.preventDefault();
                  void act(() => client.openExternalUrl!(externalUrl));
                }
              }}
            >
              Open calendar settings in browser <Icon name="arrow" size={17} />
            </a>
          )}
        </>
      ) : (
        <>
          {handoffId === 'cancelled' ? (
            <p className="calendar-message" role="status">
              Google connection cancelled. No account was added.
            </p>
          ) : (
            handoffId && (
              <div className="calendar-return">
                <p>
                  You’re back in Our place. Finish connecting for <strong>{person.displayName}</strong>.
                </p>
                <button
                  className="primary"
                  disabled={!available || busy}
                  onClick={() =>
                    void act(async () => {
                      await client.finishCalendarConnection!(handoffId);
                      if (!alive.current) return;
                      clearHandoff();
                      setNotice('Account connected. Choose the calendars you want below.');
                      await reload();
                    })
                  }
                >
                  Finish connecting
                </button>
                <button disabled={busy} onClick={clearHandoff}>
                  Dismiss
                </button>
              </div>
            )
          )}
          <form
            className="calendar-connect"
            onSubmit={(e) => {
              e.preventDefault();
              if (!available || busy || !label.trim()) return;
              void act(() => begin());
            }}
          >
            <label>
              Account label
              <input
                value={label}
                maxLength={300}
                disabled={!available || busy}
                aria-describedby="calendar-connect-help"
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Personal or Work"
              />
            </label>
            <button
              className="primary"
              aria-describedby="calendar-connect-help"
              disabled={!available || busy || !label.trim()}
            >
              Connect Google account
            </button>
          </form>
          <p id="calendar-connect-help" className="calendar-message" role="status">
            {connectHelp}
          </p>
          {state.online && loadState === 'error' && (
            <button disabled={busy} onClick={() => void act(reload)}>
              Try loading calendar settings again
            </button>
          )}
          <div className="calendar-connections">
            {settings?.connections
              .filter((c) => c.state !== 'disconnected')
              .map((connection) => (
                <article className="calendar-connection" key={connection.connectionId}>
                  <div className="section-heading">
                    <h3>{connection.label}</h3>
                    <span className="calendar-state">
                      {connection.state === 'needs_auth' ? 'Reconnect needed' : 'Connected'}
                    </span>
                  </div>
                  {connection.errorCode && (
                    <p className="calendar-message" role="status">
                      {connection.state === 'needs_auth'
                        ? 'Google access needs to be renewed.'
                        : 'The calendar list could not be refreshed. Try again shortly.'}
                    </p>
                  )}
                  {connection.lastAttemptAt && (
                    <p className="fine">Last checked {date(connection.lastAttemptAt)}</p>
                  )}
                  <div className="calendar-actions">
                    {connection.state === 'needs_auth' ? (
                      <button
                        disabled={busy || !available}
                        onClick={() =>
                          void act(() =>
                            begin(
                              { connectionId: connection.connectionId, generation: connection.generation },
                              connection.label,
                            ),
                          )
                        }
                      >
                        Reconnect
                      </button>
                    ) : (
                      <button
                        disabled={busy || !available}
                        onClick={() =>
                          void act(async () => {
                            await client.discoverCalendars!(connection.connectionId);
                            await reload();
                          })
                        }
                      >
                        Refresh calendars
                      </button>
                    )}
                    <button
                      disabled={busy || !state.online}
                      onClick={() => setConfirmDisconnect(connection.connectionId)}
                    >
                      Disconnect
                    </button>
                  </div>
                  {confirmDisconnect === connection.connectionId && (
                    <div className="calendar-return">
                      <p>
                        Remove this connection and its calendar cache from Our place? Your events in Google
                        Calendar stay there.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const outcome = await run(
                              { recordId: connection.connectionId },
                              'DisconnectCalendar',
                              {
                                connectionId: connection.connectionId,
                                expectedGeneration: connection.generation,
                              },
                              'Calendar disconnected',
                            );
                            if (outcome?.status === 'Applied' && alive.current) setConfirmDisconnect(null);
                            await reload();
                          })
                        }
                      >
                        Confirm disconnect
                      </button>
                      <button disabled={busy} onClick={() => setConfirmDisconnect(null)}>
                        Keep connection
                      </button>
                    </div>
                  )}
                  {connection.state === 'active' && connection.calendars.length === 0 && (
                    <p className="fine">No calendars loaded yet. Refresh the list to try again.</p>
                  )}
                  {connection.calendars.map((calendar) => (
                    <div className="calendar-source" key={calendar.calendarId}>
                      <div>
                        <h4>{calendar.title || 'Untitled calendar'}</h4>
                        <p className="fine">
                          {calendar.timeZone}
                          {calendar.primary ? ' · Primary' : ''}
                        </p>
                      </div>
                      <label>
                        Show in Our place
                        <select
                          aria-label={`Visibility for ${calendar.title || 'Untitled calendar'}`}
                          disabled={
                            busy ||
                            !state.online ||
                            connection.state !== 'active' ||
                            calendar.accessRole === 'freeBusyReader'
                          }
                          value={
                            calendar.scopeId === null
                              ? 'hidden'
                              : calendar.scopeId === sharedScope.scopeId
                                ? 'shared_home'
                                : calendar.context === 'work'
                                  ? 'private_work'
                                  : 'private_home'
                          }
                          onChange={(e) => {
                            const selection = e.target.value;
                            void act(async () => {
                              await run(
                                { recordId: calendar.calendarId },
                                'SelectCalendar',
                                {
                                  calendarId: calendar.calendarId,
                                  expectedRevision: calendar.revision,
                                  scopeId:
                                    selection === 'hidden'
                                      ? null
                                      : selection === 'shared_home'
                                        ? sharedScope.scopeId
                                        : privateScope.scopeId,
                                  context: selection === 'private_work' ? 'work' : 'home',
                                },
                                'Calendar selection saved',
                              );
                              await reload();
                            });
                          }}
                        >
                          <option value="hidden">Not shown</option>
                          <option value="private_home">Home · only me</option>
                          <option value="private_work">Work · only me</option>
                          <option value="shared_home">Home · household</option>
                        </select>
                      </label>
                      {calendar.accessRole === 'freeBusyReader' && (
                        <p className="fine">
                          Google grants availability access only; event details are unavailable.
                        </p>
                      )}
                    </div>
                  ))}
                </article>
              ))}
          </div>
        </>
      )}
    </section>
  );
}
