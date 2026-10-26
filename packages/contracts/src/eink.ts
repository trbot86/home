import { Type, type Static } from '@sinclair/typebox';
import { Id, object } from './primitives.js';

/** Authenticated human preview only; this is not a device credential or persisted configuration. */
export const EinkPreviewRequest = object({
  layout: Type.Union([Type.Literal('kitchen'), Type.Literal('desk')]),
  includePrivate: Type.Boolean(),
  calendarIds: Type.Array(Id, { maxItems: 40, uniqueItems: true }),
  days: Type.Union([Type.Literal(2), Type.Literal(7)]),
});
export type EinkPreviewRequest = Static<typeof EinkPreviewRequest>;
export type EinkPreview = {
  width: number;
  height: number;
  digest: string;
  pngBase64: string;
  bmpBase64: string;
  warnings: string[];
};
