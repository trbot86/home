-- Retain Food view IDs/revisions and pins while adding project-owned views.
-- The migrator brackets this reviewed rebuild with FK enforcement and validation.
CREATE TABLE saved_views_next (
  view_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  kind TEXT NOT NULL CHECK(kind IN ('food_soon','project_next')),
  revision INTEGER NOT NULL CHECK(revision>0), context_record_id TEXT,
  CHECK((kind='food_soon' AND context_record_id IS NULL) OR (kind='project_next' AND context_record_id IS NOT NULL)),
  UNIQUE(view_id,scope_id),
  FOREIGN KEY(context_record_id,scope_id) REFERENCES projects(project_id,scope_id)
) STRICT;
INSERT INTO saved_views_next(view_id,scope_id,kind,revision) SELECT view_id,scope_id,kind,revision FROM saved_views;
DROP TABLE saved_views;
ALTER TABLE saved_views_next RENAME TO saved_views;
CREATE UNIQUE INDEX saved_views_global ON saved_views(scope_id,kind) WHERE context_record_id IS NULL;
CREATE UNIQUE INDEX saved_views_context ON saved_views(scope_id,kind,context_record_id) WHERE context_record_id IS NOT NULL;
CREATE TRIGGER saved_view_identity BEFORE UPDATE OF scope_id,kind,context_record_id ON saved_views
WHEN OLD.scope_id IS NOT NEW.scope_id OR OLD.kind IS NOT NEW.kind OR OLD.context_record_id IS NOT NEW.context_record_id
BEGIN SELECT RAISE(ABORT,'saved view identity is immutable'); END;

CREATE TABLE record_pins_next (
  view_id TEXT NOT NULL, scope_id TEXT NOT NULL, record_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0), target_scope_id TEXT NOT NULL,
  PRIMARY KEY(view_id,record_id),
  FOREIGN KEY(view_id,scope_id) REFERENCES saved_views(view_id,scope_id),
  FOREIGN KEY(record_id,target_scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
INSERT INTO record_pins_next(view_id,scope_id,record_id,position,target_scope_id)
  SELECT view_id,scope_id,record_id,position,scope_id FROM record_pins;
DROP TABLE record_pins;
ALTER TABLE record_pins_next RENAME TO record_pins;
CREATE INDEX record_pins_target ON record_pins(record_id,view_id);
-- A private board may pin a shared record; a shared board may never pin a private one.
CREATE TRIGGER record_pin_visibility_insert BEFORE INSERT ON record_pins
WHEN NEW.scope_id<>NEW.target_scope_id AND NOT EXISTS(SELECT 1 FROM visibility_scopes WHERE scope_id=NEW.target_scope_id AND kind='shared')
BEGIN SELECT RAISE(ABORT,'pin target audience is narrower than its view'); END;
CREATE TRIGGER record_pin_visibility_update BEFORE UPDATE OF scope_id,target_scope_id ON record_pins
WHEN NEW.scope_id<>NEW.target_scope_id AND NOT EXISTS(SELECT 1 FROM visibility_scopes WHERE scope_id=NEW.target_scope_id AND kind='shared')
BEGIN SELECT RAISE(ABORT,'pin target audience is narrower than its view'); END;
