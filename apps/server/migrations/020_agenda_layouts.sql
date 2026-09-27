-- Extend the existing presentation model without revising content, pins or receipts.
CREATE TABLE saved_views_next (
  view_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  kind TEXT NOT NULL CHECK(kind IN ('food_soon','project_next','agenda')),
  revision INTEGER NOT NULL CHECK(revision>0), context_record_id TEXT,
  layout_json TEXT CHECK(layout_json IS NULL OR (json_valid(layout_json) AND length(layout_json)<=16384)),
  CHECK((kind='food_soon' AND context_record_id IS NULL AND layout_json IS NULL)
    OR (kind='project_next' AND context_record_id IS NOT NULL AND layout_json IS NULL)
    OR (kind='agenda' AND context_record_id IS NULL AND layout_json IS NOT NULL)),
  UNIQUE(view_id,scope_id),
  FOREIGN KEY(context_record_id,scope_id) REFERENCES projects(project_id,scope_id)
) STRICT;
INSERT INTO saved_views_next(rowid,view_id,scope_id,kind,revision,context_record_id)
  SELECT rowid,view_id,scope_id,kind,revision,context_record_id FROM saved_views;
DROP TABLE saved_views;
ALTER TABLE saved_views_next RENAME TO saved_views;
CREATE UNIQUE INDEX saved_views_global ON saved_views(scope_id,kind) WHERE context_record_id IS NULL;
CREATE UNIQUE INDEX saved_views_context ON saved_views(scope_id,kind,context_record_id) WHERE context_record_id IS NOT NULL;
CREATE TRIGGER saved_view_identity BEFORE UPDATE OF scope_id,kind,context_record_id ON saved_views
WHEN OLD.scope_id IS NOT NEW.scope_id OR OLD.kind IS NOT NEW.kind OR OLD.context_record_id IS NOT NEW.context_record_id
BEGIN SELECT RAISE(ABORT,'saved view identity is immutable'); END;
CREATE TRIGGER agenda_view_private BEFORE INSERT ON saved_views
WHEN NEW.kind='agenda' AND NOT EXISTS(SELECT 1 FROM visibility_scopes WHERE scope_id=NEW.scope_id AND kind='private')
BEGIN SELECT RAISE(ABORT,'agenda layout requires a private scope'); END;
