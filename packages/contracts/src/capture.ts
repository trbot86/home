import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, object } from './primitives.js';

/** A capture adapter cannot choose a person, scope, list, or arbitrary app command. */
export const CaptureRequest = object({
  operationId: Id,
  expectedServerEpoch: Id,
  capturedAt: Instant,
  destination: Type.Union([Type.Literal('inbox'), Type.Literal('shopping')]),
  text: Type.String({ minLength: 1, maxLength: 1000 }),
});
export type CaptureRequest = Static<typeof CaptureRequest>;
