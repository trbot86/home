import {
  isValid,
  ShoppingGroupContent,
  shoppingGroupCommands,
  type Command,
  type Recipe,
  type ShoppingGroup,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { requireHuman, type AccessService, type HumanRequestContext } from '../access/access.js';
import type { RecordAdapter, RecordContent, TrackedRecord } from '../records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import type { ShoppingRepository } from './shopping.js';
import type { RecipesRepository } from '../recipes/recipes.js';

type Kind = keyof typeof shoppingGroupCommands;
type Context = HumanRequestContext;
export class ShoppingGroupsRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
    private readonly shopping: ShoppingRepository,
    private readonly recipes: RecipesRepository,
  ) {}
  commands(): CommandHandler {
    return {
      kinds: Object.keys(shoppingGroupCommands) as Kind[],
      execute: (context, kind, payload, now) => this.execute(context, kind as Kind, payload, now),
    };
  }
  adapter(): RecordAdapter {
    return {
      kind: 'shopping_group',
      payloadTable: 'shopping_groups',
      payloadId: 'group_id',
      get: (context, id) => this.get(context, id),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(value),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now),
      reversalOrder: (_before, content) => (content.deletedAt === null ? -1 : 1),
      assertConsistent: () => this.assertConsistent(),
    };
  }
  private content(value: unknown): RecordContent {
    if (!isValid(ShoppingGroupContent, value)) throw new Error('Invalid shopping group history');
    if (!value.name.trim()) throw new Rejection('name_required');
    return value;
  }
  get(context: Context, id: string): TrackedRecord {
    requireHuman(context);
    const row = this.db
      .prepare(
        `SELECT r.*,g.list_id,g.name,g.position,g.source_recipe_id,g.source_recipe_revision,g.source_recipe_title
      FROM records r JOIN shopping_groups g ON g.group_id=r.record_id WHERE r.record_id=?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row || !this.access.canAccess(context, String(row.scope_id))) throw new NotFound();
    return {
      recordId: id,
      kind: 'shopping_group',
      revision: Number(row.revision),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      content: this.content({
        scopeId: row.scope_id,
        deletedAt: row.deleted_at,
        listId: row.list_id,
        name: row.name,
        position: row.position,
        sourceRecipe: row.source_recipe_id
          ? {
              recipeId: row.source_recipe_id,
              revision: row.source_recipe_revision,
              title: row.source_recipe_title,
            }
          : null,
      }),
    };
  }
  project(record: TrackedRecord): ShoppingGroup {
    const { content, ...header } = record;
    return { ...header, ...this.content(content) } as ShoppingGroup;
  }
  snapshot(context: Context): ShoppingGroup[] {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind='shopping_group' AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at,r.record_id LIMIT 2001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 2000) throw new Rejection('cache_capacity_exceeded');
    return rows.map((row) => this.project(this.get(context, row.record_id)));
  }
  private liveList(context: Context, id: string, revision?: number) {
    const list = this.shopping.get(context, id, 'shopping_list');
    if (list.content.deletedAt !== null) throw new Rejection('deleted');
    if (revision !== undefined && revision !== list.revision) throw new Rejection('revision_conflict');
    return list;
  }
  private create(
    context: Context,
    id: string,
    list: TrackedRecord,
    name: string,
    sourceRecipe: ShoppingGroup['sourceRecipe'],
    now: number,
  ) {
    const position = (
      this.db
        .prepare('SELECT COALESCE(MAX(position),-1)+1 AS next FROM shopping_groups WHERE list_id=?')
        .get(list.recordId) as { next: number }
    ).next;
    this.content({
      scopeId: list.content.scopeId,
      deletedAt: null,
      listId: list.recordId,
      name,
      position,
      sourceRecipe,
    });
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db
      .prepare("INSERT INTO records VALUES (?,'shopping_group',?,1,?,?,NULL)")
      .run(id, list.content.scopeId, now, now);
    this.db
      .prepare("INSERT INTO shopping_groups VALUES (?,'shopping_group',?,?,?,?,?,?,?)")
      .run(
        id,
        list.content.scopeId,
        list.recordId,
        name,
        position,
        sourceRecipe?.recipeId ?? null,
        sourceRecipe?.revision ?? null,
        sourceRecipe?.title ?? null,
      );
    return this.get(context, id);
  }
  private setContent(context: Context, before: TrackedRecord, value: RecordContent, now: number) {
    const c = this.content(value);
    if (
      c.scopeId !== before.content.scopeId ||
      c.listId !== before.content.listId ||
      JSON.stringify(c.sourceRecipe) !== JSON.stringify(before.content.sourceRecipe)
    )
      throw new Rejection('group_identity_immutable');
    if (c.deletedAt === null) this.liveList(context, String(c.listId));
    this.db
      .prepare('UPDATE shopping_groups SET name=?,position=? WHERE group_id=?')
      .run(c.name, c.position, before.recordId);
    this.db
      .prepare('UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=?')
      .run(now, c.deletedAt, before.recordId);
    return this.get(context, before.recordId);
  }
  private execute(context: Context, kind: Kind, payload: unknown, now: number): RecordMutation {
    requireHuman(context);
    try {
      return this.mutate(context, kind, payload, now);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
  }
  private mutate(context: Context, kind: Kind, payload: unknown, now: number): RecordMutation {
    if (kind === 'CreateShoppingGroup' || kind === 'AddRecipeIngredients') {
      const args = payload as Command<'AddRecipeIngredients'>['arguments'];
      const createdLists: TrackedRecord[] = [];
      if (kind === 'AddRecipeIngredients' && args.newList) {
        const recipe = this.recipes.project(this.recipes.get(context, args.recipeId, 'recipe')) as Recipe;
        if (recipe.deletedAt !== null || recipe.revision !== args.expectedRecipeRevision)
          throw new Rejection('revision_conflict');
        const created = this.shopping.execute(
          context,
          'CreateShoppingList',
          {
            recordId: args.listId,
            scopeId: recipe.scopeId,
            ...args.newList,
          },
          now,
        );
        createdLists.push(...created.records);
      }
      const list = this.liveList(
        context,
        args.listId,
        kind === 'AddRecipeIngredients' ? args.expectedListRevision : undefined,
      );
      let recipe: Recipe | null = null;
      if (kind === 'AddRecipeIngredients') {
        recipe = this.recipes.project(this.recipes.get(context, args.recipeId, 'recipe')) as Recipe;
        if (recipe.deletedAt !== null) throw new Rejection('deleted');
        if (recipe.revision !== args.expectedRecipeRevision) throw new Rejection('revision_conflict');
        if (recipe.scopeId !== list.content.scopeId) throw new Rejection('scope_mismatch');
        for (const key of ['ingredientId', 'entryId', 'sourceId'] as const)
          if (new Set(args.ingredients.map((i) => i[key])).size !== args.ingredients.length)
            throw new Rejection('duplicate_ingredient_selection');
        if (
          args.ingredients.some(
            (item) => !recipe!.ingredients.some((i) => i.ingredientId === item.ingredientId),
          )
        )
          throw new Rejection('ingredient_unavailable');
      }
      const group = this.create(
        context,
        args.recordId,
        list,
        args.name,
        recipe ? { recipeId: recipe.recordId, revision: recipe.revision, title: recipe.title } : null,
        now,
      );
      const records = [...createdLists, group];
      if (recipe)
        for (const item of args.ingredients) {
          records.push(
            this.shopping.createEntry(
              context,
              item.entryId,
              list.recordId,
              {
                label: item.label,
                quantity: item.quantity,
                notes: item.notes,
                groupId: group.recordId,
                recipeSources: [
                  {
                    sourceId: item.sourceId,
                    recipeId: recipe.recordId,
                    ingredientId: item.ingredientId,
                    recipeRevision: recipe.revision,
                    recipeTitle: recipe.title,
                    ingredientText: recipe.ingredients.find((i) => i.ingredientId === item.ingredientId)!
                      .text,
                    quantitySnapshot: item.quantity,
                  },
                ],
              },
              now,
            ),
          );
        }
      return { records, changes: records.map((after) => ({ before: null, after })) };
    }
    const args = payload as Command<'DeleteShoppingGroup'>['arguments'];
    const before = this.get(context, args.recordId);
    if (before.revision !== args.expectedRevision) throw new Rejection('revision_conflict');
    const restoring = kind === 'RestoreShoppingGroup';
    if (restoring !== (before.content.deletedAt !== null))
      throw new Rejection(restoring ? 'not_deleted' : 'deleted');
    const result: RecordMutation = { records: [], changes: [] };
    if (kind === 'DeleteShoppingGroup') {
      const members = this.db
        .prepare(
          `SELECT r.record_id,r.revision FROM shopping_entry_groups m JOIN records r ON r.record_id=m.entry_id WHERE m.group_id=? AND r.deleted_at IS NULL ORDER BY r.record_id`,
        )
        .all(before.recordId) as { record_id: string; revision: number }[];
      if (
        args.members.length !== members.length ||
        new Set(args.members.map((i) => i.recordId)).size !== members.length ||
        members.some(
          (member) =>
            !args.members.some(
              (i) => i.recordId === member.record_id && i.expectedRevision === member.revision,
            ),
        )
      )
        throw new Rejection('group_members_changed');
      for (const member of members) {
        const moved = this.shopping.execute(
          context,
          'MoveShoppingEntry',
          {
            recordId: member.record_id,
            expectedRevision: member.revision,
            listId: before.content.listId,
            groupId: null,
          },
          now,
        );
        result.records.push(...moved.records);
        result.changes.push(...moved.changes);
      }
    }
    const content =
      kind === 'UpdateShoppingGroup'
        ? { ...before.content, name: (payload as Command<'UpdateShoppingGroup'>['arguments']).name }
        : { ...before.content, deletedAt: restoring ? null : now };
    const after = this.setContent(context, before, content, now);
    result.records.push(after);
    result.changes.push({ before, after });
    return result;
  }
  private assertConsistent() {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM shopping_groups g JOIN records r ON r.record_id=g.group_id JOIN records l ON l.record_id=g.list_id WHERE r.deleted_at IS NULL AND l.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('list_contains_groups');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM shopping_entry_groups m JOIN records e ON e.record_id=m.entry_id JOIN records g ON g.record_id=m.group_id WHERE e.deleted_at IS NULL AND g.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('group_contains_items');
  }
}
