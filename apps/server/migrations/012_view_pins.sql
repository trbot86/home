-- Presentation preferences do not revise household content or join its undo history.
CREATE TABLE saved_views (
  view_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  kind TEXT NOT NULL CHECK(kind='food_soon'), revision INTEGER NOT NULL CHECK(revision>0),
  UNIQUE(scope_id,kind), UNIQUE(view_id,scope_id)
) STRICT;
CREATE TABLE record_pins (
  view_id TEXT NOT NULL, scope_id TEXT NOT NULL, record_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(view_id,record_id),
  FOREIGN KEY(view_id,scope_id) REFERENCES saved_views(view_id,scope_id),
  FOREIGN KEY(record_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE INDEX record_pins_target ON record_pins(record_id,view_id);
