import { useEffect, useRef, useState } from 'react';
import type { ClientPlatform } from '@our-place/client';
/** Durable editor text only. Frozen network attempts remain owned by ClientPlatform. */
export function useSavedForm<T extends Record<string, string>>(
  client: ClientPlatform,
  key: string,
  initial: () => T,
  revision: number,
  serverEpoch: string,
  onError: (error: unknown) => void,
) {
  const [values, setValues] = useState(initial),
    [baseRevision, setBaseRevision] = useState(revision),
    [epoch, setEpoch] = useState(serverEpoch),
    [ready, setReady] = useState(false);
  const current = useRef(values),
    write = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    let alive = true;
    void client
      .readEditor(key)
      .then((saved) => {
        if (!alive) return;
        if (saved) {
          const parsed = JSON.parse(saved.text);
          if (!parsed || Object.keys(current.current).some((field) => typeof parsed[field] !== 'string'))
            throw new Error('Saved form needs recovery');
          current.current = parsed as T;
          setValues(current.current);
          setBaseRevision(saved.baseRevision);
          setEpoch(saved.serverEpoch);
        }
        setReady(true);
      })
      .catch(onError);
    return () => {
      alive = false;
    };
  }, [client, key]);
  function save(next = current.current) {
    // Chain writes so closing a dialog can wait for the last keystroke to reach durable storage.
    const text = JSON.stringify(next);
    write.current = write.current
      .catch(() => {})
      .then(() => client.saveEditor(key, text, baseRevision, epoch));
    return write.current;
  }
  function field(name: keyof T, value: string) {
    current.current = { ...current.current, [name]: value };
    setValues(current.current);
    void save().catch(onError);
  }
  async function reset() {
    await write.current.catch(() => {});
    await client.clearEditor(key);
    current.current = initial();
    setValues(current.current);
    setBaseRevision(revision);
    setEpoch(serverEpoch);
  }
  async function clear() {
    await write.current;
    await client.clearEditor(key);
  }
  return { values, field, ready, baseRevision, epoch, save, clear, reset, flush: () => write.current };
}
