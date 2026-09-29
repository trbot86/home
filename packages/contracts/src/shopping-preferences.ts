import { Type, type Static } from '@sinclair/typebox';
import { object } from './primitives.js';

export const ShoppingPreferences = object({
  defaultStore: Type.Optional(Type.String({ maxLength: 200 })),
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

export type IngredientSourcingRequest = {
  expectedRevision: number;
  expectedPreferencesRevision: number;
  expectedAttempt: number;
  ingredientIds: string[];
};
export type IngredientSourcingReview = {
  attempt: number;
  recipeRevision: number;
  preferencesRevision: number;
  ingredientIds: string[];
  exceptionIds: string[];
  state: 'working' | 'complete' | 'failed' | 'stale';
};
