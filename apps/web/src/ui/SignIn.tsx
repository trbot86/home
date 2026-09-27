import { useEffect, useState, type FormEvent } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { AuthenticationOptions } from '@our-place/contracts';
import { Icon } from './Icon.js';
export function SignIn({ client, onError }: { client: ClientPlatform; onError: (error: unknown) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<AuthenticationOptions | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      const address = client.serverAddress ? await client.serverAddress() : '';
      if (!alive) return;
      setServer(address);
      if (!client.serverAddress || address) {
        const value = await client.authenticationOptions();
        if (alive) setOptions(value);
      }
    })().catch(onError);
    return () => {
      alive = false;
    };
  }, [client]);
  async function chooseProfile(name: string) {
    if (busy) return;
    setBusy(true);
    try {
      await client.login(name, '');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (!options) {
        if (client.configureServer) await client.configureServer(server);
        setOptions(await client.authenticationOptions());
        return;
      }
      await client.login(username, password);
      setPassword('');
    } catch (error) {
      onError(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="sign-in">
      <section className="welcome">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="home" />
          </span>
          Our place<span className="brand-dot">.</span>
        </div>
        <p className="eyebrow">A little less to remember</p>
        <h1>
          Life together.
          <br />A place for the details.
        </h1>
        <p>Save the thought, the photo, the thing you don’t want to forget. Find it here when you need it.</p>
        <div className="welcome-note">
          <Icon name="inbox" size={28} />
          <div>
            <strong>Start with the inbox</strong>
            <p>No organising required. Just get it down.</p>
          </div>
        </div>
      </section>
      <form
        className="login-panel"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <p className="eyebrow">Your household</p>
        <h2>Welcome home</h2>
        <p>
          {options?.mode === 'trusted-network'
            ? 'Who’s using Our place?'
            : options
              ? 'Sign in to your own space.'
              : 'Connect to your household.'}
        </p>
        {client.configureServer && (
          <label>
            Household server
            <input
              type="url"
              required
              value={server}
              onChange={(e) => {
                setServer(e.target.value);
                setOptions(null);
              }}
              placeholder="https://your-household-server"
              autoCapitalize="none"
              autoComplete="url"
              spellCheck={false}
            />
          </label>
        )}
        {options?.mode === 'password' && (
          <>
            <label>
              Username
              <input
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoCapitalize="none"
                spellCheck={false}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        )}
        {options?.mode === 'trusted-network' ? (
          <div className="profile-choices">
            {options.profiles.map((profile) => (
              <button
                key={profile.personId}
                type="button"
                className="profile-choice"
                disabled={busy}
                onClick={() => {
                  void chooseProfile(profile.username);
                }}
              >
                <span className="avatar" aria-hidden="true">{profile.displayName.slice(0, 1)}</span>
                <span>{profile.displayName}</span>
                <Icon name="arrow" />
              </button>
            ))}
          </div>
        ) : (
          <button className="primary" disabled={busy}>
            {busy ? 'Opening…' : options ? 'Sign in' : 'Connect'}
            <Icon name="arrow" />
          </button>
        )}
        <p className="fine">
          {options?.mode === 'trusted-network'
            ? 'No password needed. This device remembers your profile; switch using the profile menu.'
            : 'Shared things stay shared. Personal things stay yours.'}
        </p>
      </form>
    </main>
  );
}
