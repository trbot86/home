import { Type, type Static } from '@sinclair/typebox';
import { object } from './primitives.js';

export const ShoppingPreferences = object({
  location: Type.String({ maxLength: 200 }),
  stores: Type.Array(
    object({
      name: Type.String({ minLength: 1, maxLength: 200 }),
      bulk: Type.Boolean(),
    }),
    { maxItems: 12 },
  ),
});
export type ShoppingPreferences = Static<typeof ShoppingPreferences>;
export type ShoppingSettings = ShoppingPreferences & { revision: number };
