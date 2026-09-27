import {
  emptyRecipes,
  isValid,
  recipeCommands,
  recipeContentSchemas,
  type Attachment,
  type Command,
  type Recipe,
  type RecipeAdjustment,
  type RecipeIngredient,
  type RecipeKind,
  type RecipeRecord,
  type RecipeSnapshot,
  type RecipeStep,
} from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { NotFound, Rejection } from '../../application/errors.js';
import { publicWebUrl } from '../../infrastructure/public-web.js';
import { AccessService, requireHuman, type HumanRequestContext as RequestContext } from '../access/access.js';
import type {
  RecordAdapter,
  RecordChange,
  RecordContent,
  TrackedRecord,
} from '../records/record-registry.js';
import type { CommandHandler, RecordMutation } from '../records/command-handler.js';
import { AttachmentRepository } from '../media/attachments.js';

type RecipeCommandKind = keyof typeof recipeCommands;
const tables: Record<RecipeKind, [string, string]> = {
  recipe: ['recipes', 'recipe_id'],
  recipe_collection: ['recipe_collections', 'recipe_collection_id'],
  recipe_cooking_record: ['recipe_cooking_records', 'cooking_record_id'],
};
type Header = {
  record_id: string;
  kind: RecipeKind;
  scope_id: string;
  revision: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};
type RecipeContent = Omit<Recipe, 'recordId' | 'kind' | 'revision' | 'createdAt' | 'updatedAt'>;

/** Recipe content owns ingredients, directions, collection memberships and household adjustments. */
export class RecipesRepository {
  private readonly attachments: AttachmentRepository;
  constructor(
    private readonly db: Sqlite,
    private readonly access: AccessService,
  ) {
    this.attachments = new AttachmentRepository(db, access);
  }
  commands(): CommandHandler {
    return {
      kinds: Object.keys(recipeCommands) as RecipeCommandKind[],
      execute: (context, kind, payload, now) =>
        this.execute(context, kind as RecipeCommandKind, payload, now),
    };
  }
  adapters(): RecordAdapter[] {
    return (Object.keys(tables) as RecipeKind[]).map((kind) => ({
      kind,
      supportsAttachments: kind !== 'recipe_collection',
      payloadTable: tables[kind][0],
      payloadId: tables[kind][1],
      get: (context, id) => this.get(context, id, kind),
      project: (record) => this.project(record),
      validateContent: (value) => this.content(kind, value),
      setContent: (context, before, content, now) => this.setContent(context, before, content, now),
      reversalOrder: (_before, content) =>
        (kind === 'recipe_collection' ? -3 : kind === 'recipe_cooking_record' ? 2 : 0) *
        (content.deletedAt === null ? 1 : -1),
      ...(kind === 'recipe' ? { assertConsistent: () => this.assertConsistent() } : {}),
    }));
  }
  private content(kind: RecipeKind, value: unknown): RecordContent {
    if (!isValid(recipeContentSchemas[kind], value)) throw new Error('Invalid recipe history content');
    const c = value as RecordContent;
    if (kind === 'recipe') {
      const recipe = c as RecipeContent;
      if (!recipe.title.trim()) throw new Rejection('title_required');
      if (recipe.sourceUrl !== null) {
        try {
          publicWebUrl(recipe.sourceUrl);
        } catch {
          throw new Rejection('invalid_source_url');
        }
      }
      for (const [items, key] of [
        [recipe.ingredients, 'ingredientId'],
        [recipe.steps, 'stepId'],
        [recipe.adjustments, 'adjustmentId'],
      ] as const) {
        const identities = items.map((item) => (item as unknown as Record<string, unknown>)[key]);
        if (new Set(identities).size !== items.length) throw new Rejection('duplicate_recipe_child');
        if (items.some((item) => !('text' in item ? item.text : item.body).trim()))
          throw new Rejection('recipe_text_required');
      }
      if (new Set(recipe.collectionIds).size !== recipe.collectionIds.length)
        throw new Rejection('duplicate_collection');
    } else if (kind === 'recipe_collection' && !String(c.name).trim()) throw new Rejection('name_required');
    return c;
  }
  get(context: RequestContext, id: string, expectedKind?: RecipeKind): TrackedRecord {
    requireHuman(context);
    const row = this.db.prepare('SELECT * FROM records WHERE record_id=?').get(id) as Header | undefined;
    if (
      !row ||
      !Object.hasOwn(tables, row.kind) ||
      (expectedKind && row.kind !== expectedKind) ||
      !this.access.canAccess(context, row.scope_id)
    )
      throw new NotFound();
    const [table, key] = tables[row.kind];
    const data = this.db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as Record<string, unknown>;
    if (!data) throw new Error('Recipe payload missing');
    let fields: Record<string, unknown>;
    if (row.kind === 'recipe') {
      fields = {
        title: data.title,
        description: data.description,
        sourceUrl: data.source_url,
        author: data.author,
        yieldText: data.yield_text,
        prepTime: JSON.parse(String(data.prep_time_json)),
        cookTime: JSON.parse(String(data.cook_time_json)),
        totalTime: JSON.parse(String(data.total_time_json)),
        archived: data.archived === 1,
        ingredients: this.db
          .prepare(
            'SELECT ingredient_id AS ingredientId,text FROM recipe_ingredients WHERE recipe_id=? AND retired_at IS NULL ORDER BY position',
          )
          .all(id),
        steps: this.db
          .prepare(
            'SELECT step_id AS stepId,text FROM recipe_steps WHERE recipe_id=? AND retired_at IS NULL ORDER BY position',
          )
          .all(id),
        adjustments: this.db
          .prepare(
            'SELECT adjustment_id AS adjustmentId,person_id AS personId,body,created_at AS createdAt,updated_at AS updatedAt FROM recipe_adjustments WHERE recipe_id=? AND deleted_at IS NULL ORDER BY created_at,adjustment_id',
          )
          .all(id),
        collectionIds: (
          this.db
            .prepare(
              'SELECT recipe_collection_id AS id FROM recipe_collection_memberships WHERE recipe_id=? AND removed_at IS NULL ORDER BY position',
            )
            .all(id) as { id: string }[]
        ).map((item) => item.id),
      };
    } else if (row.kind === 'recipe_collection') fields = { name: data.name, role: data.role };
    else
      fields = {
        recipeId: data.recipe_id,
        completionId: data.completion_id,
        cookedAt: data.cooked_at,
        cookedByPersonId: data.cooked_by_person_id,
        notes: data.notes,
      };
    return {
      recordId: id,
      kind: row.kind,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      content: this.content(row.kind, {
        ...fields,
        scopeId: row.scope_id,
        deletedAt: row.deleted_at,
        ...(row.kind === 'recipe_collection' ? {} : { attachments: this.attachments.list(id) }),
      }),
    };
  }
  project(record: TrackedRecord): RecipeRecord {
    const { recordId, kind, revision, createdAt, updatedAt } = record;
    return {
      recordId,
      kind,
      revision,
      createdAt,
      updatedAt,
      ...this.content(kind as RecipeKind, record.content),
    } as RecipeRecord;
  }
  snapshot(context: RequestContext): RecipeSnapshot {
    requireHuman(context);
    const rows = this.db
      .prepare(
        `SELECT r.record_id FROM records r JOIN visibility_scopes s USING(scope_id)
      WHERE r.kind IN ('recipe','recipe_collection','recipe_cooking_record') AND (s.kind='shared' OR s.owner_person_id=?) ORDER BY r.created_at,r.record_id LIMIT 4001`,
      )
      .all(context.personId) as { record_id: string }[];
    if (rows.length > 4000) throw new Rejection('cache_capacity_exceeded');
    const snapshot = emptyRecipes();
    for (const row of rows) {
      const record = this.project(this.get(context, row.record_id));
      if (record.kind === 'recipe') snapshot.recipes.push(record);
      else if (record.kind === 'recipe_collection') snapshot.collections.push(record);
      else snapshot.cookingRecords.push(record);
    }
    return snapshot;
  }
  private require(context: RequestContext, id: string, kind: RecipeKind, revision?: number): TrackedRecord {
    let record: TrackedRecord;
    try {
      record = this.get(context, id, kind);
    } catch (error) {
      if (error instanceof NotFound) throw new Rejection('unavailable');
      throw error;
    }
    if (revision !== undefined && record.revision !== revision) throw new Rejection('revision_conflict');
    return record;
  }
  private checkReferences(context: RequestContext, kind: RecipeKind, id: string, c: RecordContent): void {
    this.access.requireScope(context, c.scopeId);
    if (kind === 'recipe') {
      for (const collectionId of c.collectionIds as string[]) {
        const collection = this.require(context, collectionId, 'recipe_collection');
        if (collection.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
        if (c.deletedAt === null && collection.content.deletedAt !== null)
          throw new Rejection('collection_unavailable');
      }
      if (
        c.deletedAt !== null &&
        this.db
          .prepare(
            `SELECT 1 FROM recipe_cooking_records c JOIN records r ON r.record_id=c.cooking_record_id WHERE c.recipe_id=? AND r.deleted_at IS NULL LIMIT 1`,
          )
          .get(id)
      )
        throw new Rejection('recipe_has_cooking_records');
    } else if (kind === 'recipe_collection') {
      if (
        c.deletedAt !== null &&
        this.db
          .prepare(
            `SELECT 1 FROM recipe_collection_memberships m JOIN records r ON r.record_id=m.recipe_id WHERE m.recipe_collection_id=? AND m.removed_at IS NULL AND r.deleted_at IS NULL LIMIT 1`,
          )
          .get(id)
      )
        throw new Rejection('collection_not_empty');
    } else {
      const recipe = this.require(context, String(c.recipeId), 'recipe');
      if (recipe.content.scopeId !== c.scopeId) throw new Rejection('scope_mismatch');
      if (c.deletedAt === null && recipe.content.deletedAt !== null)
        throw new Rejection('recipe_unavailable');
      if (c.cookedByPersonId !== null) {
        const scope = this.db
          .prepare('SELECT owner_person_id FROM visibility_scopes WHERE scope_id=?')
          .get(c.scopeId) as { owner_person_id: string | null };
        if (
          !this.db.prepare('SELECT 1 FROM people WHERE person_id=?').get(c.cookedByPersonId) ||
          (scope.owner_person_id !== null && scope.owner_person_id !== c.cookedByPersonId)
        )
          throw new Rejection('performer_unavailable');
      }
    }
  }
  private saveChildren(id: string, c: RecipeContent, now: number): void {
    this.saveLines(
      id,
      'recipe_ingredients',
      'ingredient_id',
      c.ingredients.map((item) => ({ id: item.ingredientId, text: item.text })),
      now,
    );
    this.saveLines(
      id,
      'recipe_steps',
      'step_id',
      c.steps.map((item) => ({ id: item.stepId, text: item.text })),
      now,
    );
    for (const adjustment of c.adjustments) {
      const old = this.db
        .prepare('SELECT recipe_id,person_id,created_at FROM recipe_adjustments WHERE adjustment_id=?')
        .get(adjustment.adjustmentId) as
        { recipe_id: string; person_id: string; created_at: number } | undefined;
      if (
        old &&
        (old.recipe_id !== id ||
          old.person_id !== adjustment.personId ||
          old.created_at !== adjustment.createdAt)
      )
        throw new Rejection('id_unavailable');
    }
    this.db
      .prepare('UPDATE recipe_adjustments SET deleted_at=? WHERE recipe_id=? AND deleted_at IS NULL')
      .run(now, id);
    const adjustmentInsert = this.db.prepare(`INSERT INTO recipe_adjustments VALUES (?,?,?,?,?,?,NULL)
      ON CONFLICT(adjustment_id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at,deleted_at=NULL`);
    for (const a of c.adjustments)
      adjustmentInsert.run(a.adjustmentId, id, a.personId, a.body, a.createdAt, a.updatedAt);
    this.db
      .prepare(
        'UPDATE recipe_collection_memberships SET removed_at=? WHERE recipe_id=? AND removed_at IS NULL',
      )
      .run(now, id);
    const membershipInsert = this.db.prepare(`INSERT INTO recipe_collection_memberships VALUES (?,?,?,?,NULL)
      ON CONFLICT(recipe_id,recipe_collection_id) DO UPDATE SET position=excluded.position,removed_at=NULL`);
    c.collectionIds.forEach((collectionId, position) =>
      membershipInsert.run(id, collectionId, c.scopeId, position),
    );
  }
  private saveLines(
    id: string,
    table: 'recipe_ingredients' | 'recipe_steps',
    key: 'ingredient_id' | 'step_id',
    lines: { id: string; text: string }[],
    now: number,
  ): void {
    for (const line of lines) {
      const old = this.db.prepare(`SELECT recipe_id FROM ${table} WHERE ${key}=?`).get(line.id) as
        { recipe_id: string } | undefined;
      if (old && old.recipe_id !== id) throw new Rejection('id_unavailable');
    }
    this.db.prepare(`UPDATE ${table} SET retired_at=? WHERE recipe_id=? AND retired_at IS NULL`).run(now, id);
    const put = this.db.prepare(
      `INSERT INTO ${table} VALUES (?,?,?,?,NULL) ON CONFLICT(${key}) DO UPDATE SET position=excluded.position,text=excluded.text,retired_at=NULL`,
    );
    lines.forEach((line, position) => put.run(line.id, id, position, line.text));
  }
  private savePayload(kind: RecipeKind, id: string, c: RecordContent, now: number): void {
    if (kind === 'recipe') {
      this.db
        .prepare(
          `INSERT INTO recipes VALUES (?,'recipe',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(recipe_id) DO UPDATE SET
        title=excluded.title,description=excluded.description,source_url=excluded.source_url,author=excluded.author,yield_text=excluded.yield_text,
        prep_time_json=excluded.prep_time_json,cook_time_json=excluded.cook_time_json,total_time_json=excluded.total_time_json,archived=excluded.archived`,
        )
        .run(
          id,
          c.scopeId,
          c.title,
          c.description,
          c.sourceUrl,
          c.author,
          c.yieldText,
          JSON.stringify(c.prepTime),
          JSON.stringify(c.cookTime),
          JSON.stringify(c.totalTime),
          c.archived ? 1 : 0,
        );
      this.saveChildren(id, c as RecipeContent, now);
    } else if (kind === 'recipe_collection')
      this.db
        .prepare(
          `INSERT INTO recipe_collections VALUES (?,'recipe_collection',?,?,?) ON CONFLICT(recipe_collection_id) DO UPDATE SET name=excluded.name`,
        )
        .run(id, c.scopeId, c.name, c.role);
    else
      this.db
        .prepare(
          `INSERT INTO recipe_cooking_records VALUES (?,'recipe_cooking_record',?,?,?,?,?,?) ON CONFLICT(cooking_record_id) DO UPDATE SET cooked_at=excluded.cooked_at,cooked_by_person_id=excluded.cooked_by_person_id,notes=excluded.notes`,
        )
        .run(id, c.scopeId, c.recipeId, c.completionId, c.cookedAt, c.cookedByPersonId, c.notes);
  }
  private create(
    context: RequestContext,
    kind: RecipeKind,
    id: string,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    const c = this.content(kind, value);
    this.checkReferences(context, kind, id, c);
    if (this.db.prepare('SELECT 1 FROM records WHERE record_id=?').get(id))
      throw new Rejection('id_unavailable');
    this.db.prepare('INSERT INTO records VALUES (?,?,?,1,?,?,NULL)').run(id, kind, c.scopeId, now, now);
    this.savePayload(kind, id, c, now);
    if (kind !== 'recipe_collection')
      this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
        creating: true,
        live: true,
      });
    return this.get(context, id, kind);
  }
  private setContent(
    context: RequestContext,
    before: TrackedRecord,
    value: RecordContent,
    now: number,
  ): TrackedRecord {
    requireHuman(context);
    const kind = before.kind as RecipeKind,
      c = this.content(kind, value),
      id = before.recordId;
    if (!this.db.inTransaction) throw new Error('Recipe changes must share the content transaction');
    if (c.scopeId !== before.content.scopeId) throw new Rejection('scope_change_not_supported');
    if (kind === 'recipe_collection' && c.role !== before.content.role)
      throw new Rejection('collection_role_is_fixed');
    if (
      kind === 'recipe_cooking_record' &&
      (c.recipeId !== before.content.recipeId || c.completionId !== before.content.completionId)
    )
      throw new Rejection('cooking_relationship_is_fixed');
    this.checkReferences(context, kind, id, c);
    const changed = this.db
      .prepare(
        'UPDATE records SET revision=revision+1,updated_at=?,deleted_at=? WHERE record_id=? AND revision=?',
      )
      .run(now, c.deletedAt, id, before.revision);
    if (changed.changes !== 1) throw new Rejection('revision_conflict');
    this.savePayload(kind, id, c, now);
    if (kind !== 'recipe_collection')
      this.attachments.replace(context, id, c.scopeId, c.attachments as Attachment[], now, {
        live: c.deletedAt === null,
      });
    return this.get(context, id, kind);
  }
  private execute(
    context: RequestContext,
    kind: RecipeCommandKind,
    payload: unknown,
    now: number,
  ): RecordMutation {
    requireHuman(context);
    if (!this.db.inTransaction) throw new Error('Recipe commands must share the content transaction');
    const changes: RecordChange[] = [];
    const create = (type: RecipeKind, id: string, c: RecordContent) => {
      const after = this.create(context, type, id, c, now);
      changes.push({ before: null, after });
      return after;
    };
    const result = () => ({ records: changes.map((change) => change.after), changes });
    if (kind === 'EnsureRecipeCollections') {
      const args = payload as Command<'EnsureRecipeCollections'>['arguments'];
      this.access.requireScope(context, args.scopeId);
      const records = (['want_to_try', 'favourites'] as const).map((role) => {
        const existing = this.db
          .prepare('SELECT recipe_collection_id AS id FROM recipe_collections WHERE scope_id=? AND role=?')
          .get(args.scopeId, role) as { id: string } | undefined;
        if (existing) {
          const before = this.get(context, existing.id, 'recipe_collection');
          if (before.content.deletedAt === null) return before;
          const after = this.setContent(context, before, { ...before.content, deletedAt: null }, now);
          changes.push({ before, after });
          return after;
        }
        return create('recipe_collection', role === 'want_to_try' ? args.wantToTryId : args.favouritesId, {
          scopeId: args.scopeId,
          deletedAt: null,
          name: role === 'want_to_try' ? 'Want to try' : 'Favourites',
          role,
        });
      });
      return { records, changes };
    }
    if (
      kind === 'CreateRecipe' ||
      kind === 'CreateRecipeCollection' ||
      kind === 'CreateRecipeCookingRecord'
    ) {
      const { recordId, ...fields } = payload as Command<'CreateRecipe'>['arguments'];
      if (kind === 'CreateRecipe')
        create('recipe', recordId, {
          ...fields,
          deletedAt: null,
          attachments: [],
          archived: false,
          adjustments: [],
        });
      else if (kind === 'CreateRecipeCollection')
        create('recipe_collection', recordId, { ...fields, deletedAt: null, role: null });
      else {
        if ((fields as unknown as { cookedAt: number }).cookedAt > now + 300000)
          throw new Rejection('cooking_in_future');
        create('recipe_cooking_record', recordId, {
          ...fields,
          deletedAt: null,
          completionId: null,
          attachments: [],
        });
      }
      return result();
    }
    const { recordId, expectedRevision, ...fields } = payload as Command<'UpdateRecipe'>['arguments'];
    const type = kind.includes('CookingRecord')
      ? 'recipe_cooking_record'
      : kind.includes('RecipeCollection') && kind !== 'SetRecipeCollections'
        ? 'recipe_collection'
        : 'recipe';
    const before = this.require(context, recordId, type, expectedRevision);
    let c = { ...before.content };
    if (kind.startsWith('Delete') || kind.startsWith('Restore')) {
      const deleting = kind.startsWith('Delete');
      if (deleting === (before.content.deletedAt !== null))
        throw new Rejection(deleting ? 'already_deleted' : 'not_deleted');
      if (type === 'recipe_collection' && c.role !== null && deleting)
        throw new Rejection('builtin_collection');
      if (type === 'recipe_cooking_record' && c.completionId)
        throw new Rejection('use_completion_history_to_undo');
      c.deletedAt = deleting ? now : null;
    } else {
      if (before.content.deletedAt !== null) throw new Rejection('deleted');
      if (kind === 'SetRecipeAdjustment' || kind === 'RemoveRecipeAdjustment') {
        const args = payload as Command<'SetRecipeAdjustment'>['arguments'];
        const adjustments = [...(c.adjustments as RecipeAdjustment[])],
          existing = adjustments.find((item) => item.adjustmentId === args.adjustmentId);
        if (kind === 'RemoveRecipeAdjustment') {
          if (!existing) throw new Rejection('adjustment_unavailable');
          c.adjustments = adjustments.filter((item) => item !== existing);
        } else {
          if (!existing && adjustments.length >= 100) throw new Rejection('recipe_note_limit');
          const adjustment = existing
            ? { ...existing, body: args.body, updatedAt: now }
            : {
                adjustmentId: args.adjustmentId,
                personId: context.personId,
                body: args.body,
                createdAt: now,
                updatedAt: now,
              };
          c.adjustments = [...adjustments.filter((item) => item !== existing), adjustment].sort(
            (a, b) => a.createdAt - b.createdAt || a.adjustmentId.localeCompare(b.adjustmentId),
          );
        }
      } else c = { ...c, ...fields };
      if (kind === 'UpdateRecipeCookingRecord' && Number(c.cookedAt) > now + 300000)
        throw new Rejection('cooking_in_future');
    }
    changes.push({ before, after: this.setContent(context, before, c, now) });
    return result();
  }
  private assertConsistent(): void {
    if (
      this.db
        .prepare(
          `SELECT 1 FROM recipe_collection_memberships m JOIN records r ON r.record_id=m.recipe_id JOIN records c ON c.record_id=m.recipe_collection_id
      WHERE r.deleted_at IS NULL AND m.removed_at IS NULL AND c.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('collection_not_empty');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM recipe_cooking_records c JOIN records r ON r.record_id=c.cooking_record_id JOIN records p ON p.record_id=c.recipe_id
      WHERE r.deleted_at IS NULL AND p.deleted_at IS NOT NULL LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('recipe_has_cooking_records');
    if (
      this.db
        .prepare(
          `SELECT 1 FROM recipe_cooking_records c JOIN records r ON r.record_id=c.cooking_record_id JOIN records t ON t.record_id=c.completion_id
      WHERE (r.deleted_at IS NULL)<>(t.deleted_at IS NULL) LIMIT 1`,
        )
        .get()
    )
      throw new Rejection('cooking_completion_dependency_changed');
  }
}
