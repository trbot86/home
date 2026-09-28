import { useState } from 'react';

/** Public setup instructions only; credentials are installed privately on the host. */
export function CalendarSetupGuide({ reload, busy }: { reload: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const origin = new URL(window.location.href);
  const secure = origin.protocol === 'https:';
  return (
    <div className="calendar-setup-guide">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="calendar-setup-steps"
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide setup guide' : 'Set up Google Calendar'}
      </button>
      {open && (
        <section id="calendar-setup-steps" aria-label="Google Calendar setup guide">
          <h3>One-time household setup</h3>
          <p>
            This registers Our Place with Google. Afterwards, each person connects their own account and
            chooses which calendars to show. Work calendars stay private.
          </p>
          <ol>
            <li>
              Open{' '}
              <a href="https://console.cloud.google.com/" target="_blank" rel="noopener noreferrer">
                Google Cloud Console
              </a>
              . Create or select a project, then enable the Google Calendar API in its API Library.
            </li>
            <li>
              In Google Auth Platform, configure the app branding and audience. For personal Google accounts,
              choose External. While the app is in Testing, add the Google accounts you want to connect as
              test users.
            </li>
            <li>
              Create an OAuth client with application type <strong>Web application</strong>. Add this
              authorized redirect URI:
              {secure ? (
                <input
                  aria-label="Google Calendar redirect URI"
                  readOnly
                  value={new URL('/oauth/calendar/callback', origin.origin).href}
                  onFocus={(event) => event.currentTarget.select()}
                />
              ) : (
                <p>
                  Open these settings at your normal household HTTPS address first. The callback is that
                  address followed by <code>/oauth/calendar/callback</code>.
                </p>
              )}
              <p>Use the normal household address you will return to for account connection.</p>
            </li>
            <li>
              Download the client credentials JSON and keep it in private local storage. Give the developer or
              setup assistant its local file path so they can configure the household server. Do not put its
              contents in a suggestion, shared note or source repository.
            </li>
            <li>
              After server configuration is installed, check again below. Then use{' '}
              <strong>Connect Google account</strong>, approve read-only calendar access, and select the
              calendars you want.
            </li>
          </ol>
          <details>
            <summary>Server configuration details</summary>
            <p>
              The server needs a private JSON file with <code>clientId</code>, <code>clientSecret</code>,{' '}
              <code>activeKeyId</code> and a <code>keys</code> map containing a generated 32-byte encryption
              key encoded as base64url. Keep encryption keys stable across restarts.
            </p>
            <p>
              Mount that file read-only in Docker and set <code>CALENDAR_CONFIG_FILE</code> to its container
              path. The server’s <code>PUBLIC_ORIGIN</code> must match the household HTTPS address above.
              Recreate only the app container, preserving its data volume and existing configuration. Calendar
              credentials belong on the server, never in the Android app.
            </p>
          </details>
          <p className="fine">
            Google’s Testing mode can require renewed authorization after seven days. Review the publishing
            settings before relying on unattended calendar refresh.
          </p>
          <p>
            <a
              href="https://developers.google.com/identity/protocols/oauth2/web-server"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google’s OAuth setup documentation
            </a>
          </p>
          <button type="button" disabled={busy} onClick={reload}>
            Check setup again
          </button>
        </section>
      )}
    </div>
  );
}
