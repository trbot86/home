import { Type, type Static } from '@sinclair/typebox';
import { Id, Digest, Revision, object } from './primitives.js';
export const Attachment = object({
  attachmentId: Id,
  mediaId: Id,
  digest: Digest,
  byteLength: Type.Integer({ minimum: 1, maximum: 25 * 1024 * 1024 }),
  mimeType: Type.Union([Type.Literal('image/jpeg'), Type.Literal('image/png'), Type.Literal('image/webp')]),
  caption: Type.Optional(Type.String({ maxLength: 1000 })),
  position: Type.Integer({ minimum: 0, maximum: 19 }),
});
export type Attachment = Static<typeof Attachment>;
export const Attachments = Type.Array(Attachment, { maxItems: 20 });
export const SetRecordAttachments = object({ recordId: Id, expectedRevision: Revision, attachments: Attachments });
