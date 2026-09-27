import { Type, type Static } from '@sinclair/typebox';
import { Digest, object } from './primitives.js';

const text = (maxLength: number) => Type.String({ maxLength });
const duration = object({
  text: text(80),
  minutes: Type.Union([Type.Number({ minimum: 0, maximum: 5256000 }), Type.Null()]),
});
/** Extracted source only. Household notes, memberships, task links and shopping are not model/parser outputs. */
export const RecipeCandidate = object({
  candidateId: Digest,
  kind: Type.Union([Type.Literal('recipe'), Type.Literal('bookmark')]),
  format: Type.Union([Type.Literal('json-ld'), Type.Literal('microdata'), Type.Literal('page-metadata')]),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  description: text(10000),
  author: text(500),
  yieldText: text(300),
  prepTime: duration,
  cookTime: duration,
  totalTime: duration,
  ingredients: Type.Array(text(2000), { maxItems: 300 }),
  steps: Type.Array(text(10000), { maxItems: 200 }),
  imageUrls: Type.Array(text(4096), { maxItems: 12 }),
});
export type RecipeCandidate = Static<typeof RecipeCandidate>;
export type RecipeExtraction = {
  extractorVersion: 1;
  sourceUrl: string;
  candidates: RecipeCandidate[];
  warnings: string[];
};
