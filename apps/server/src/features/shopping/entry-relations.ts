import type { RecipeShoppingSource } from '@our-place/contracts';
import type { Sqlite } from '../../infrastructure/database.js';
import { Rejection } from '../../application/errors.js';
import type { RecordContent } from '../records/record-registry.js';

/** Entry-owned grouping and immutable source snapshots, separate from purchase state. */
export class ShoppingEntryRelations {
  constructor(private readonly db: Sqlite) {}
  read(id: string) {
    const group = this.db.prepare('SELECT group_id FROM shopping_entry_groups WHERE entry_id=?').get(id) as
      { group_id: string } | undefined;
    const recipeSources = this.db
      .prepare(
        `SELECT source_id AS sourceId,recipe_id AS recipeId,ingredient_id AS ingredientId,
      recipe_revision AS recipeRevision,recipe_title AS recipeTitle,ingredient_text AS ingredientText,quantity_snapshot AS quantitySnapshot
      FROM recipe_shopping_sources WHERE entry_id=? ORDER BY source_id`,
      )
      .all(id) as RecipeShoppingSource[];
    return { groupId: group?.group_id ?? null, recipeSources };
  }
  clearGroup(id: string) {
    this.db.prepare('DELETE FROM shopping_entry_groups WHERE entry_id=?').run(id);
  }
  saveGroup(id: string, content: RecordContent) {
    this.clearGroup(id);
    if (!content.groupId) return;
    const group = this.db
      .prepare(
        `SELECT g.scope_id,g.list_id,r.deleted_at FROM shopping_groups g JOIN records r ON r.record_id=g.group_id WHERE group_id=?`,
      )
      .get(String(content.groupId)) as
      { scope_id: string; list_id: string; deleted_at: number | null } | undefined;
    if (
      !group ||
      group.scope_id !== content.scopeId ||
      group.list_id !== content.listId ||
      (content.deletedAt === null && group.deleted_at !== null)
    )
      throw new Rejection('group_unavailable');
    this.db
      .prepare('INSERT INTO shopping_entry_groups VALUES (?,?,?,?)')
      .run(id, content.scopeId, content.listId, content.groupId);
  }
  createSources(id: string, content: RecordContent) {
    for (const source of (content.recipeSources ?? []) as RecipeShoppingSource[]) {
      if (this.db.prepare('SELECT 1 FROM recipe_shopping_sources WHERE source_id=?').get(source.sourceId))
        throw new Rejection('id_unavailable');
      this.db
        .prepare('INSERT INTO recipe_shopping_sources VALUES (?,?,?,?,?,?,?,?,?)')
        .run(
          source.sourceId,
          id,
          content.scopeId,
          source.recipeId,
          source.ingredientId,
          source.recipeRevision,
          source.recipeTitle,
          source.ingredientText,
          source.quantitySnapshot,
        );
    }
  }
  assertSourcesUnchanged(before: RecordContent, after: RecordContent) {
    if (JSON.stringify(before.recipeSources ?? []) !== JSON.stringify(after.recipeSources ?? []))
      throw new Rejection('recipe_sources_immutable');
  }
}
