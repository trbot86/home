INSERT INTO record_kinds VALUES ('shopping_group');
CREATE TABLE shopping_groups (
  group_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'shopping_group' CHECK(record_kind='shopping_group'),
  scope_id TEXT NOT NULL, list_id TEXT NOT NULL, name TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0),
  source_recipe_id TEXT, source_recipe_revision INTEGER, source_recipe_title TEXT,
  CHECK((source_recipe_id IS NULL AND source_recipe_revision IS NULL AND source_recipe_title IS NULL)
    OR (source_recipe_id IS NOT NULL AND source_recipe_revision IS NOT NULL AND source_recipe_revision>=1 AND source_recipe_title IS NOT NULL)),
  UNIQUE(group_id,scope_id,list_id),
  FOREIGN KEY(group_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(group_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(list_id,scope_id) REFERENCES shopping_lists(shopping_list_id,scope_id),
  FOREIGN KEY(source_recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id)
) STRICT;
CREATE INDEX shopping_groups_list ON shopping_groups(list_id,position);
CREATE UNIQUE INDEX shopping_entry_list_scope ON shopping_entries(shopping_entry_id,scope_id,shopping_list_id);
-- Membership belongs to the entry: moving one item revises that item, not every neighbour.
CREATE TABLE shopping_entry_groups (
  entry_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, list_id TEXT NOT NULL, group_id TEXT NOT NULL,
  FOREIGN KEY(entry_id,scope_id,list_id) REFERENCES shopping_entries(shopping_entry_id,scope_id,shopping_list_id),
  FOREIGN KEY(group_id,scope_id,list_id) REFERENCES shopping_groups(group_id,scope_id,list_id)
) STRICT;
CREATE INDEX shopping_entry_groups_group ON shopping_entry_groups(group_id,entry_id);
CREATE TABLE recipe_shopping_sources (
  source_id TEXT PRIMARY KEY NOT NULL, entry_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL, ingredient_id TEXT NOT NULL, recipe_revision INTEGER NOT NULL CHECK(recipe_revision>=1),
  recipe_title TEXT NOT NULL, ingredient_text TEXT NOT NULL, quantity_snapshot TEXT NOT NULL,
  FOREIGN KEY(entry_id,scope_id) REFERENCES shopping_entries(shopping_entry_id,scope_id),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id),
  FOREIGN KEY(recipe_id,ingredient_id) REFERENCES recipe_ingredients(recipe_id,ingredient_id)
) STRICT;
CREATE INDEX recipe_shopping_sources_entry ON recipe_shopping_sources(entry_id,source_id);
CREATE TRIGGER recipe_shopping_source_immutable BEFORE UPDATE ON recipe_shopping_sources
BEGIN SELECT RAISE(ABORT,'recipe shopping snapshots are immutable'); END;
