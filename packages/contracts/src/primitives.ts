import { Type, type TSchema } from '@sinclair/typebox';
export const Id = Type.String({ pattern: '^[a-zA-Z0-9_-]{8,80}$' });
export const Instant = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Digest = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
