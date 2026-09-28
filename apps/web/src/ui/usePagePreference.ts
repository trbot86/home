import { useState, type SetStateAction } from 'react';
import type { ClientState } from '@our-place/client';

/** Device-local view choices, partitioned by installation and profile. No note data. */
export function usePagePreference<T>(
  state: ClientState,
  name: string,
  fallback: T,
  valid: (value: unknown) => value is T,
  fresh = false,
) {
  const key = `our-place:view:${state.session?.installationId}:${state.session?.person.personId}:${name}`;
  const read = (): T => {
    if (!fresh)
      try {
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (valid(parsed)) return parsed;
      } catch {
        /* Storage can be unavailable; in-memory navigation still works. */
      }
    return fallback;
  };
  const [saved, setSaved] = useState(() => ({ key, value: read() }));
  const value = saved.key === key ? saved.value : read();
  const set = (next: SetStateAction<T>) =>
    setSaved((previous) => {
      const current = previous.key === key ? previous.value : read();
      const updated = typeof next === 'function' ? (next as (v: T) => T)(current) : next;
      if (!valid(updated)) return previous;
      try {
        localStorage.setItem(key, JSON.stringify(updated));
      } catch {
        /* Best effort. */
      }
      return { key, value: updated };
    });
  return [value, set] as const;
}
