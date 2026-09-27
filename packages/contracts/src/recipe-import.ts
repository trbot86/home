import { Type, type Static } from '@sinclair/typebox';
import { Digest, Id, Revision, object } from './primitives.js';

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
export const RecipeExtraction = object({
  extractorVersion: Type.Literal(1),
  sourceUrl: text(4096),
  candidates: Type.Array(RecipeCandidate, { minItems: 1, maxItems: 8 }),
  warnings: Type.Array(text(100), { maxItems: 40 }),
});
export type RecipeExtraction = Static<typeof RecipeExtraction>;
export const RecipeImportField = Type.Union(
  (['title', 'description', 'author', 'yieldText', 'times', 'ingredients', 'steps', 'photo'] as const).map(
    (value) => Type.Literal(value),
  ),
);
export type RecipeImportField = Static<typeof RecipeImportField>;
export const recipeImportCommands = {
  ImportRecipe: object({
    recordId: Id,
    importId: Id,
    scopeId: Id,
    url: Type.String({ minLength: 1, maxLength: 4096 }),
    collectionIds: Type.Array(Id, { maxItems: 50 }),
  }),
  RequestRecipeImport: object({
    recordId: Id,
    expectedRevision: Revision,
    importId: Id,
    url: Type.String({ minLength: 1, maxLength: 4096 }),
  }),
  ApplyRecipeImport: object({
    recordId: Id,
    expectedRevision: Revision,
    importId: Id,
    candidateId: Digest,
    fields: Type.Array(RecipeImportField, { minItems: 1, maxItems: 8 }),
  }),
  CancelRecipeImport: object({ importId: Id }),
} as const;
export type RecipeImportSummary = {
  importId: string;
  recipeId: string;
  sourceUrl: string;
  requestedAt: number;
  state: 'queued' | 'running' | 'ready' | 'review' | 'failed' | 'complete' | 'abandoned' | 'paused';
  errorCode: string | null;
  candidateCount: number;
  appliedChangeSetId: string | null;
};
