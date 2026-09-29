import { Type, type Static } from '@sinclair/typebox';
import { Id, Instant, Revision, object } from './primitives.js';
import { Attachments } from './attachments.js';
export const ShoppingPurpose = Type.Union(
  (['groceries', 'household', 'wants', 'gifts'] as const).map((value) => Type.Literal(value)),
);
const name = Type.String({ minLength: 1, maxLength: 300 });
const quantity = Type.String({ maxLength: 120 });
const notes = Type.String({ maxLength: 10000 });
const nullableId = Type.Union([Id, Type.Null()]);
const commonContent = { scopeId: Id, deletedAt: Type.Union([Instant, Type.Null()]) };
export const ShoppingListFields = { name, purpose: ShoppingPurpose, notes: Type.Optional(notes) };
export const RestockItemFields = {
  name,
  model: Type.String({ maxLength: 500 }),
  quantity,
  notes,
  productUrl: Type.Union([Type.String({ maxLength: 4096, pattern: '^https?://[^\\s]+$' }), Type.Null()]),
};
export const ShoppingEntryFields = { label: name, quantity, notes };
export const RecipeShoppingSource = object({
  sourceId: Id,
  recipeId: Id,
  ingredientId: Id,
  recipeRevision: Revision,
  recipeTitle: name,
  ingredientText: Type.String({ maxLength: 2000 }),
  quantitySnapshot: quantity,
});
export type RecipeShoppingSource = Static<typeof RecipeShoppingSource>;
export const ShoppingGroupContent = object({
  ...commonContent,
  listId: Id,
  name,
  position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  sourceRecipe: Type.Union([object({ recipeId: Id, revision: Revision, title: name }), Type.Null()]),
});
export const PurchaseItem = object({ purchaseItemId: Id, shoppingEntryId: Id, label: name, quantity });
export const shoppingContentSchemas = {
  shopping_list: object({ ...commonContent, ...ShoppingListFields }),
  // Optional so stored history and snapshots from older clients remain readable.
  restock_item: object({ ...commonContent, ...RestockItemFields, attachments: Type.Optional(Attachments) }),
  shopping_entry: object({
    ...commonContent,
    ...ShoppingEntryFields,
    listId: Id,
    restockItemId: nullableId,
    state: Type.Union([Type.Literal('needed'), Type.Literal('purchased'), Type.Literal('cancelled')]),
    position: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    // Optional for pre-group history and requests retained on offline devices.
    groupId: Type.Optional(nullableId),
    recipeSources: Type.Optional(Type.Array(RecipeShoppingSource, { maxItems: 100 })),
  }),
  purchase: object({
    ...commonContent,
    boughtAt: Instant,
    buyerPersonId: Id,
    buyerName: Type.String({ maxLength: 300 }),
    notes,
    items: Type.Array(PurchaseItem, { minItems: 1, maxItems: 100 }),
    attachments: Type.Optional(Attachments),
  }),
} as const;
export type ShoppingKind = keyof typeof shoppingContentSchemas;
type Header<K extends string> = {
  recordId: string;
  kind: K;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
export type ShoppingList = Header<'shopping_list'> & Static<typeof shoppingContentSchemas.shopping_list>;
export type RestockItem = Header<'restock_item'> & Static<typeof shoppingContentSchemas.restock_item>;
export type ShoppingEntry = Header<'shopping_entry'> & Static<typeof shoppingContentSchemas.shopping_entry>;
export type Purchase = Header<'purchase'> & Static<typeof shoppingContentSchemas.purchase>;
export type ShoppingGroup = Header<'shopping_group'> & Static<typeof ShoppingGroupContent>;
export type ShoppingRecord = ShoppingList | RestockItem | ShoppingEntry | Purchase | ShoppingGroup;
export type ShoppingSnapshot = {
  lists: ShoppingList[];
  restockItems: RestockItem[];
  entries: ShoppingEntry[];
  purchases: Purchase[];
  groups: ShoppingGroup[];
};
export const emptyShopping = (): ShoppingSnapshot => ({
  lists: [],
  restockItems: [],
  entries: [],
  purchases: [],
  groups: [],
});
const target = { recordId: Id, expectedRevision: Revision };
export const shoppingCommands = {
  CreateShoppingList: object({ recordId: Id, scopeId: Id, ...ShoppingListFields }),
  UpdateShoppingList: object({ ...target, ...ShoppingListFields }),
  CreateRestockItem: object({ recordId: Id, scopeId: Id, ...RestockItemFields }),
  UpdateRestockItem: object({ ...target, ...RestockItemFields }),
  AddShoppingEntry: object({
    recordId: Id,
    listId: Id,
    groupId: Type.Optional(nullableId),
    ...ShoppingEntryFields,
  }),
  NeedRestockItem: object({ recordId: Id, listId: Id, restockItemId: Id, expectedRestockRevision: Revision }),
  UpdateShoppingEntry: object({ ...target, ...ShoppingEntryFields }),
  MoveShoppingEntry: object({ ...target, listId: Id, groupId: Type.Optional(nullableId) }),
  PurchaseShoppingEntry: object({ ...target, purchaseId: Id, purchaseItemId: Id, boughtAt: Instant }),
  DeleteShoppingRecord: object(target),
  RestoreShoppingRecord: object(target),
} as const;
export const shoppingGroupCommands = {
  CreateShoppingGroup: object({ recordId: Id, listId: Id, name }),
  UpdateShoppingGroup: object({ ...target, name }),
  DeleteShoppingGroup: object({ ...target, members: Type.Array(object(target), { maxItems: 2000 }) }),
  RestoreShoppingGroup: object(target),
  AddRecipeIngredients: object({
    recordId: Id,
    recipeId: Id,
    expectedRecipeRevision: Revision,
    listId: Id,
    expectedListRevision: Revision,
    newList: Type.Optional(object({ ...ShoppingListFields })),
    listNotes: Type.Optional(notes),
    name,
    ingredients: Type.Array(object({ ingredientId: Id, entryId: Id, sourceId: Id, ...ShoppingEntryFields }), {
      minItems: 1,
      maxItems: 100,
    }),
  }),
} as const;
