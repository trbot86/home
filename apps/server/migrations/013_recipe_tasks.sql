-- The task owns its cooking link. Initial tasks cook one recipe; meal bundles can
-- extend this relation separately without changing recipe identity or revision.
CREATE TABLE task_recipe_links (
  task_id TEXT PRIMARY KEY NOT NULL,
  scope_id TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'cooking' CHECK(purpose='cooking'),
  FOREIGN KEY(task_id,scope_id) REFERENCES tasks(task_id,scope_id),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id)
) STRICT;
CREATE INDEX task_recipe_links_recipe ON task_recipe_links(recipe_id,task_id);
