import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ClientPlatform } from '@our-place/client';
import type { InboxEntry } from '@our-place/contracts';

const entryId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A link identifies a note; it never grants access or embeds its text. */
export function noteIdFromUrl(href: string, origin: string): string | null {
  try {
    const url = new URL(href);
    const id = url.searchParams.get('entry');
    return url.origin === new URL(origin).origin &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.searchParams.size === 1 &&
      id !== null &&
      entryId.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

function noteTitle(entry: InboxEntry): string {
  if (entry.deletedAt !== null) return 'Deleted note';
  const title =
    entry.text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || 'Photo note';
  return title.length > 90 ? title.slice(0, 89) + '…' : title;
}

type NoteLinks = {
  origin: string;
  titles: ReadonlyMap<string, string>;
  open: (id: string) => Promise<void>;
};
const Context = createContext<NoteLinks | null>(null);
export const useNoteLinks = () => useContext(Context);

export function NoteLinksProvider({
  client,
  entries,
  open,
  children,
}: {
  client: ClientPlatform;
  entries: InboxEntry[];
  open: (id: string) => Promise<void>;
  children: ReactNode;
}) {
  const [origin, setOrigin] = useState('');
  useEffect(() => {
    let alive = true;
    void (client.serverAddress ? client.serverAddress() : Promise.resolve(window.location.origin))
      .then((value) => {
        if (alive) setOrigin(new URL(value).origin);
      })
      .catch(() => {
        /* Copy remains unavailable until this installation has an address. */
      });
    return () => {
      alive = false;
    };
  }, [client]);
  // Only the current profile's authorized snapshot supplies titles.
  const titles = useMemo(() => new Map(entries.map((entry) => [entry.inboxId, noteTitle(entry)])), [entries]);
  return <Context.Provider value={{ origin, titles, open }}>{children}</Context.Provider>;
}

export function CopyNoteLink({ id }: { id: string }) {
  const context = useNoteLinks();
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState('');
  return (
    <div className="copy-note-link">
      <button
        type="button"
        disabled={!context?.origin}
        onClick={() => {
          if (!context?.origin) return;
          const url = new URL('/', context.origin);
          url.searchParams.set('entry', id);
          void navigator.clipboard
            ?.writeText(url.href)
            .then(() => {
              setCopied(true);
              setFallback('');
            })
            .catch(() => setFallback(url.href));
          if (!navigator.clipboard) setFallback(url.href);
        }}
      >
        Copy link
      </button>
      {copied && (
        <span role="status" className="fine">
          Link copied
        </span>
      )}
      {fallback && (
        <label className="fine">
          Select and copy this link
          <input
            aria-label="Note link"
            readOnly
            value={fallback}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}
