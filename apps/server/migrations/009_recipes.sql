INSERT INTO record_kinds VALUES ('recipe'),('recipe_collection'),('recipe_cooking_record');
CREATE TABLE recipes (
  recipe_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'recipe' CHECK(record_kind='recipe'),
  scope_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, source_url TEXT,
  author TEXT NOT NULL, yield_text TEXT NOT NULL,
  prep_time_json TEXT NOT NULL CHECK(json_valid(prep_time_json)),
  cook_time_json TEXT NOT NULL CHECK(json_valid(cook_time_json)),
  total_time_json TEXT NOT NULL CHECK(json_valid(total_time_json)),
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  UNIQUE(recipe_id,scope_id),
  FOREIGN KEY(recipe_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE recipe_ingredients (
  ingredient_id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id),
  position INTEGER NOT NULL CHECK(position>=0), text TEXT NOT NULL, retired_at INTEGER,
  UNIQUE(recipe_id,ingredient_id)
) STRICT;
CREATE UNIQUE INDEX recipe_ingredient_position ON recipe_ingredients(recipe_id,position) WHERE retired_at IS NULL;
CREATE TABLE recipe_steps (
  step_id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id),
  position INTEGER NOT NULL CHECK(position>=0), text TEXT NOT NULL, retired_at INTEGER,
  UNIQUE(recipe_id,step_id)
) STRICT;
CREATE UNIQUE INDEX recipe_step_position ON recipe_steps(recipe_id,position) WHERE retired_at IS NULL;
CREATE TABLE recipe_adjustments (
  adjustment_id TEXT PRIMARY KEY NOT NULL, recipe_id TEXT NOT NULL REFERENCES recipes(recipe_id),
  person_id TEXT NOT NULL REFERENCES people(person_id), body TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER
) STRICT;
CREATE INDEX recipe_adjustments_parent ON recipe_adjustments(recipe_id,deleted_at,created_at,adjustment_id);
CREATE TABLE recipe_collections (
  recipe_collection_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'recipe_collection' CHECK(record_kind='recipe_collection'),
  scope_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT CHECK(role IN ('want_to_try','favourites')),
  UNIQUE(recipe_collection_id,scope_id), UNIQUE(scope_id,role),
  FOREIGN KEY(recipe_collection_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(recipe_collection_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE recipe_collection_memberships (
  recipe_id TEXT NOT NULL, recipe_collection_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0), removed_at INTEGER,
  PRIMARY KEY(recipe_id,recipe_collection_id),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id),
  FOREIGN KEY(recipe_collection_id,scope_id) REFERENCES recipe_collections(recipe_collection_id,scope_id)
) STRICT;
CREATE INDEX recipe_memberships_collection ON recipe_collection_memberships(recipe_collection_id,removed_at,recipe_id);
CREATE TABLE recipe_cooking_records (
  cooking_record_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'recipe_cooking_record' CHECK(record_kind='recipe_cooking_record'),
  scope_id TEXT NOT NULL, recipe_id TEXT NOT NULL, completion_id TEXT UNIQUE,
  cooked_at INTEGER NOT NULL, cooked_by_person_id TEXT REFERENCES people(person_id), notes TEXT NOT NULL,
  FOREIGN KEY(cooking_record_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(cooking_record_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id),
  FOREIGN KEY(completion_id,scope_id) REFERENCES task_completions(completion_id,scope_id)
) STRICT;
CREATE INDEX recipe_cooking_recipe ON recipe_cooking_records(recipe_id,cooked_at DESC,cooking_record_id);

-- Stable child identities cannot move to another recipe, including after retirement.
CREATE TRIGGER recipe_ingredient_owner BEFORE UPDATE OF recipe_id ON recipe_ingredients
WHEN OLD.recipe_id IS NOT NEW.recipe_id BEGIN SELECT RAISE(ABORT,'ingredient ownership is immutable'); END;
CREATE TRIGGER recipe_step_owner BEFORE UPDATE OF recipe_id ON recipe_steps
WHEN OLD.recipe_id IS NOT NEW.recipe_id BEGIN SELECT RAISE(ABORT,'step ownership is immutable'); END;
CREATE TRIGGER recipe_adjustment_owner BEFORE UPDATE OF recipe_id,person_id,created_at ON recipe_adjustments
WHEN OLD.recipe_id IS NOT NEW.recipe_id OR OLD.person_id IS NOT NEW.person_id OR OLD.created_at IS NOT NEW.created_at
BEGIN SELECT RAISE(ABORT,'adjustment ownership is immutable'); END;
