import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

type Snapshot = Map<string, unknown>;

/** Only opaque tokens enter browser history. Record selectors stay in this page's memory. */
class NavigationHistory {
  values: Snapshot = new Map();
  listeners = new Map<string, (value: unknown, present: boolean) => void>();
  snapshots = new Map<string, Snapshot>();
  token = '';
  owner = '';
  enabled = false;
  restoring = false;
  generation = 0;
  flushers = new Set<() => Promise<unknown>>();
  pending = false;

  constructor(readonly native: boolean) {}

  boundary(owner: string) {
    if (this.owner === owner) return;
    this.owner = owner;
    this.generation++;
    this.enabled = !!owner && !this.native;
    this.pending = false;
    this.snapshots.clear();
    if (this.enabled) this.record(true);
  }

  record(replace = false) {
    if (!this.enabled) return;
    this.token = crypto.randomUUID();
    this.snapshots.set(this.token, new Map(this.values));
    if (this.snapshots.size > 200) this.snapshots.delete(this.snapshots.keys().next().value!);
    const url = new URL(window.location.href);
    if (!replace) url.searchParams.delete('entry');
    const state = { ourPlaceNavigation: this.token };
    if (replace) window.history.replaceState(state, '', url);
    else window.history.pushState(state, '', url);
  }

  changed() {
    if (this.enabled && !this.restoring) {
      this.generation++;
      this.pending = true;
    }
  }

  commit() {
    if (!this.pending) return;
    this.pending = false;
    this.record();
  }

  pop = (event: PopStateEvent) => {
    if (!this.enabled) return;
    const generation = ++this.generation;
    this.pending = false;
    const token = event.state?.ourPlaceNavigation;
    void (async () => {
      try {
        await Promise.all([...this.flushers].map((flush) => flush()));
      } catch {
        // Keep the mounted editor and its text if durable storage failed.
        if (generation === this.generation) this.record(true);
        return;
      }
      if (generation !== this.generation || !this.enabled) return;
      const snapshot = this.snapshots.get(token) ?? new Map();
      const known = this.snapshots.has(token);
      this.token = token;
      this.values = new Map(snapshot);
      this.restoring = true;
      for (const [key, listener] of this.listeners) listener(snapshot.get(key), snapshot.has(key));
      this.restoring = false;
      if (!known) window.dispatchEvent(new Event('ourplace:navigation-fallback'));
    })();
  };
}

const Context = createContext<NavigationHistory | null>(null);
export function NavigationHistoryProvider({ native, children }: { native: boolean; children: ReactNode }) {
  const [history] = useState(() => new NavigationHistory(native));
  useLayoutEffect(() => {
    window.addEventListener('popstate', history.pop);
    return () => {
      window.removeEventListener('popstate', history.pop);
      history.pending = false;
    };
  }, [history]);
  return <Context.Provider value={history}>{children}</Context.Provider>;
}

export function useNavigationBoundary(owner: string) {
  const history = useContext(Context);
  useLayoutEffect(() => {
    history?.boundary(owner);
  }, [history, owner]);
}

/** Use only for navigation selectors, never form contents or cached server records. */
export function useNavigationState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const history = useContext(Context);
  const initialRef = useRef(initial);
  const defaultValue = () =>
    typeof initialRef.current === 'function' ? (initialRef.current as () => T)() : initialRef.current;
  const [value, setValue] = useState<T>(() =>
    history?.values.has(key) ? (history.values.get(key) as T) : defaultValue(),
  );
  const valueRef = useRef(value);
  const keyRef = useRef(key);
  valueRef.current = value;
  if (keyRef.current !== key) {
    keyRef.current = key;
    initialRef.current = initial;
    valueRef.current = history?.values.has(key) ? (history.values.get(key) as T) : defaultValue();
    setValue(valueRef.current);
  }
  useLayoutEffect(() => {
    if (!history || history.native) return;
    history.values.set(key, valueRef.current);
    // Include newly mounted panel defaults in the current step, without adding a step.
    if (!history.pending) history.snapshots.get(history.token)?.set(key, valueRef.current);
    history.listeners.set(key, (next, present) => {
      valueRef.current = present ? (next as T) : defaultValue();
      setValue(valueRef.current);
    });
    return () => {
      history.listeners.delete(key);
      history.values.delete(key);
    };
  }, [history, key]);
  useLayoutEffect(() => {
    history?.commit();
  });
  const update: Dispatch<SetStateAction<T>> = (action) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(valueRef.current) : action;
    if (Object.is(next, valueRef.current)) return;
    valueRef.current = next;
    setValue(next);
    if (history && !history.native) {
      history.values.set(key, next);
      history.changed();
    }
  };
  return [value, update];
}

/** Editors register their full write queue, including saves not yet sent to storage. */
export function useNavigationFlush(flush: () => Promise<unknown>) {
  const history = useContext(Context);
  const current = useRef(flush);
  current.current = flush;
  useLayoutEffect(() => {
    if (!history || history.native) return;
    const callback = () => current.current();
    history.flushers.add(callback);
    return () => {
      // A linked screen may already have unmounted this form. Retain its queue
      // until it drains, so immediate Back cannot read an older stored draft.
      void callback().then(
        () => history.flushers.delete(callback),
        () => history.flushers.delete(callback),
      );
    };
  }, [history]);
}

export function useNavigationWrite(onError: (error: unknown) => void) {
  const history = useContext(Context);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  useNavigationFlush(async () => {
    try {
      let last;
      do {
        last = pending.current;
        await last;
      } while (last !== pending.current);
    } catch (error) {
      onError(error);
      throw error;
    }
  });
  return (write: () => Promise<unknown>) => {
    if (history?.native) return write();
    pending.current = pending.current.catch(() => {}).then(write);
    return pending.current;
  };
}

export function useFlushNavigation() {
  const history = useContext(Context);
  return async () => {
    if (history) await Promise.all([...history.flushers].map((flush) => flush()));
  };
}
