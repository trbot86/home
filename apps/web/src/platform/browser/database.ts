import { openDB, type DBSchema } from 'idb';
import type { AttachmentDraft, Draft, EditorBuffer } from '@our-place/client';
import type {
  CommandKind,
  CommandOutcome,
  InboxEntry,
  Session,
  ShoppingSnapshot,
  TaskSnapshot,
  HomeSnapshot,
} from '@our-place/contracts';
export type Attempt = {
  key: string;
  clientId: string;
  recordId: string;
  kind: CommandKind;
  frozenJson: string;
  outcome?: CommandOutcome;
  attachmentDraftId?: string;
  uploads?: { scopeId: string; attachments: import('@our-place/contracts').Attachment[] };
};
interface LocalSchema extends DBSchema {
  drafts: { key: string; value: Draft };
  attachmentDrafts: { key: string; value: AttachmentDraft };
  media: { key: string; value: { clientId: string; mediaId: string; bytes: Blob } };
  attempts: { key: string; value: Attempt };
  editors: { key: string; value: EditorBuffer };
  cache: {
    key: string;
    value: {
      entries: InboxEntry[];
      shopping?: ShoppingSnapshot;
      tasks?: TaskSnapshot;
      home?: HomeSnapshot;
      sampledAt: number;
      serverEpoch: string;
    };
  };
  profiles: { key: string; value: Session };
  meta: { key: string; value: string | number };
}
export const localDatabase = openDB<LocalSchema>('our-place', 2, {
  upgrade(db, oldVersion) {
    if (oldVersion < 1)
      for (const store of ['drafts', 'media', 'attempts', 'editors', 'cache', 'profiles', 'meta'] as const)
        db.createObjectStore(store);
    if (oldVersion < 2) db.createObjectStore('attachmentDrafts');
  },
});
export function localKey(clientId: string, id: string): string {
  return `${clientId}:${id}`;
}
export async function digest(textOrBytes: string | ArrayBuffer): Promise<string> {
  const bytes = typeof textOrBytes === 'string' ? new TextEncoder().encode(textOrBytes) : textOrBytes;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
