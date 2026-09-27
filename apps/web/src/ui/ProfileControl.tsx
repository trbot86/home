import { useEffect, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { AuthenticationOptions, Person } from '@our-place/contracts';

export function ProfileControl({
  client,
  person,
  online,
  disabled,
  onSwitch,
  onError,
}: {
  client: ClientPlatform;
  person: Person;
  online: boolean;
  disabled: boolean;
  onSwitch: (username: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [options, setOptions] = useState<AuthenticationOptions | null>(null);
  useEffect(() => {
    if (!online) return;
    let alive = true;
    void client
      .authenticationOptions()
      .then((value) => {
        if (alive) setOptions(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [client, person.personId, online]);
  return (
    <div className="profile">
      <span className="avatar">{person.displayName.slice(0, 1)}</span>
      <div>
        {options?.mode === 'trusted-network' ? (
          <select
            aria-label="Current profile"
            value={person.personId}
            disabled={disabled}
            title={disabled ? 'Connect and finish saving to switch profiles' : 'Switch profile'}
            onChange={(event) => {
              const profile = options.profiles.find((value) => value.personId === event.target.value);
              if (profile) void onSwitch(profile.username);
            }}
          >
            {options.profiles.map((profile) => (
              <option value={profile.personId} key={profile.personId}>
                {profile.displayName}
              </option>
            ))}
          </select>
        ) : (
          <>
            <strong>{person.displayName}</strong>
            {options?.mode === 'password' && (
              <button
                className="text-button"
                onClick={() => {
                  void client.logout().catch(onError);
                }}
              >
                Sign out
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
