import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';

const nullableId = Type.Union([Id, Type.Null()]);
const duration = object({
  text: Type.String({ maxLength: 80 }),
  minutes: Type.Union([Type.Number({ minimum: 0, maximum: 5256000 }), Type.Null()]),
});
export const RecipeIngredient = object({
  ingredientId: Id,
  text: Type.String({ minLength: 1, maxLength: 2000 }),
});
export const RecipeStep = object({ stepId: Id, text: Type.String({ minLength: 1, maxLength: 10000 }) });
export const RecipeAdjustment = object({
  adjustmentId: Id,
  personId: Id,
  body: Type.String({ minLength: 1, maxLength: 20000 }),
  createdAt: Instant,
  updatedAt: Instant,
});
export type RecipeIngredient = Static<typeof RecipeIngredient>;
export type RecipeStep = Static<typeof RecipeStep>;
export type RecipeAdjustment = Static<typeof RecipeAdjustment>;
export const RecipeFields = {
  title: Type.String({ minLength: 1, maxLength: 300 }),
  description: Type.String({ maxLength: 10000 }),
  sourceUrl: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  author: Type.String({ maxLength: 500 }),
  yieldText: Type.String({ maxLength: 300 }),
  prepTime: duration,
  cookTime: duration,
  totalTime: duration,
  ingredients: Type.Array(RecipeIngredient, { maxItems: 300 }),
  steps: Type.Array(RecipeStep, { maxItems: 200 }),
};
export const RecipeCollectionRole = Type.Union([
  Type.Literal('want_to_try'),
  Type.Literal('favourites'),
  Type.Null(),
]);
export const CookingFields = {
  cookedAt: Instant,
  cookedByPersonId: nullableId,
  notes: Type.String({ maxLength: 20000 }),
};
const common = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]) };
export const recipeContentSchemas = {
  recipe: object({
    ...common,
    ...RecipeFields,
    attachments: Attachments,
    archived: Type.Boolean(),
    collectionIds: Type.Array(Id, { maxItems: 50 }),
    adjustments: Type.Array(RecipeAdjustment, { maxItems: 100 }),
  }),
  recipe_collection: object({
    ...common,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    role: RecipeCollectionRole,
  }),
  recipe_cooking_record: object({
    ...common,
    recipeId: Id,
    completionId: nullableId,
    ...CookingFields,
    attachments: Attachments,
  }),
};
export type RecipeKind = keyof typeof recipeContentSchemas;
type Header<K extends RecipeKind> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type Recipe = Header<'recipe'> & Static<typeof recipeContentSchemas.recipe>;
export type RecipeCollection = Header<'recipe_collection'> &
  Static<typeof recipeContentSchemas.recipe_collection>;
export type RecipeCookingRecord = Header<'recipe_cooking_record'> &
  Static<typeof recipeContentSchemas.recipe_cooking_record>;
export type RecipeRecord = Recipe | RecipeCollection | RecipeCookingRecord;
export type RecipeSnapshot = {
  recipes: Recipe[];
  collections: RecipeCollection[];
  cookingRecords: RecipeCookingRecord[];
};
export const emptyRecipes = (): RecipeSnapshot => ({ recipes: [], collections: [], cookingRecords: [] });
const sourceFieldsSchema = object(RecipeFields);
export type RecipeFields = Static<typeof sourceFieldsSchema>;
export const emptyRecipeFields = (): RecipeFields => ({
  title: '',
  description: '',
  sourceUrl: null,
  author: '',
  yieldText: '',
  prepTime: { text: '', minutes: null },
  cookTime: { text: '', minutes: null },
  totalTime: { text: '', minutes: null },
  ingredients: [],
  steps: [],
});
const target = { recordId: Id, expectedRevision: Revision };
export const recipeCommands = {
  EnsureRecipeCollections: object({ scopeId: Id, wantToTryId: Id, favouritesId: Id }),
  CreateRecipeCollection: object({
    recordId: Id,
    scopeId: Id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
  }),
  RenameRecipeCollection: object({ ...target, name: Type.String({ minLength: 1, maxLength: 100 }) }),
  DeleteRecipeCollection: object(target),
  RestoreRecipeCollection: object(target),
  CreateRecipe: object({
    recordId: Id,
    scopeId: Id,
    ...RecipeFields,
    collectionIds: Type.Array(Id, { maxItems: 50 }),
  }),
  UpdateRecipe: object({ ...target, ...RecipeFields }),
  SetRecipeCollections: object({ ...target, collectionIds: Type.Array(Id, { maxItems: 50 }) }),
  SetRecipeArchived: object({ ...target, archived: Type.Boolean() }),
  SetRecipeAdjustment: object({
    ...target,
    adjustmentId: Id,
    body: Type.String({ minLength: 1, maxLength: 20000 }),
  }),
  RemoveRecipeAdjustment: object({ ...target, adjustmentId: Id }),
  DeleteRecipe: object(target),
  RestoreRecipe: object(target),
  CreateRecipeCookingRecord: object({ recordId: Id, scopeId: Id, recipeId: Id, ...CookingFields }),
  UpdateRecipeCookingRecord: object({ ...target, ...CookingFields }),
  DeleteRecipeCookingRecord: object(target),
  RestoreRecipeCookingRecord: object(target),
} as const;
