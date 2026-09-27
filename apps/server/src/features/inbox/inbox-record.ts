import { Type } from '@sinclair/typebox';
import {
  Attachment,
  EntryCategory,
  Id,
  Instant,
  Source,
  isValid,
  type InboxEntry,
} from '@our-place/contracts';
import { contentOf, InboxRepository, type InboxContent } from './inbox.js';
import type { RecordAdapter, RecordContent, TrackedRecord } from '../records/record-registry.js';

const contentSchema = Type.Object(
  {
    scopeId: Id,
    text: Type.String({ maxLength: 20000 }),
    capturedAt: Instant,
    source: Source,
    attachments: Type.Array(Attachment, { maxItems: 20 }),
    deletedAt: Type.Union([Instant, Type.Null()]),
    // Retained version-1 deltas predate capture categories.
    category: Type.Optional(EntryCategory),
  },
  { additionalProperties: false },
);
export function trackInbox(entry: InboxEntry): TrackedRecord {
  return {
    recordId: entry.inboxId,
    kind: 'inbox',
    revision: entry.revision,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    content: contentOf(entry),
  };
}
function decode(content: unknown): InboxContent {
  if (!isValid(contentSchema, content)) throw new Error('Invalid inbox history content');
  return { ...content, category: content.category ?? 'inbox' };
}
function project(record: TrackedRecord): InboxEntry {
  return {
    ...decode(record.content),
    inboxId: record.recordId,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
export function inboxRecordAdapter(inbox: InboxRepository): RecordAdapter {
  return {
    kind: 'inbox',
    supportsAttachments: true,
    payloadTable: 'inbox_entries',
    payloadId: 'inbox_id',
    get: (context, id) => trackInbox(inbox.get(context, id)),
    setContent: (context, before, content, now) =>
      trackInbox(inbox.setContent(context, project(before), decode(content), now)),
    validateContent: (content): RecordContent => decode(content),
    project,
  };
}
