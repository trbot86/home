ALTER TABLE inbox_entries ADD COLUMN filed_at INTEGER CHECK(filed_at IS NULL OR filed_at>=0);
CREATE TABLE inbox_destinations (
  inbox_id TEXT NOT NULL REFERENCES inbox_entries(inbox_id), scope_id TEXT NOT NULL,
  target_record_id TEXT NOT NULL, target_scope_id TEXT NOT NULL,
  filed_at INTEGER NOT NULL CHECK(filed_at>=0),
  PRIMARY KEY(inbox_id,target_record_id), CHECK(inbox_id<>target_record_id),
  FOREIGN KEY(inbox_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(target_record_id,target_scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE INDEX inbox_destinations_target ON inbox_destinations(target_record_id,inbox_id);
CREATE TRIGGER inbox_destination_visibility_insert BEFORE INSERT ON inbox_destinations
WHEN NEW.scope_id<>NEW.target_scope_id AND NOT EXISTS(SELECT 1 FROM visibility_scopes WHERE scope_id=NEW.target_scope_id AND kind='shared')
BEGIN SELECT RAISE(ABORT,'inbox destination audience is narrower than its source'); END;
CREATE TRIGGER inbox_destination_visibility_update BEFORE UPDATE OF scope_id,target_scope_id ON inbox_destinations
WHEN NEW.scope_id<>NEW.target_scope_id AND NOT EXISTS(SELECT 1 FROM visibility_scopes WHERE scope_id=NEW.target_scope_id AND kind='shared')
BEGIN SELECT RAISE(ABORT,'inbox destination audience is narrower than its source'); END;
