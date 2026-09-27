-- Removed placements retain identity/history without occupying a live display position.
CREATE TABLE attachments_next (
  attachment_id TEXT PRIMARY KEY NOT NULL,
  record_id TEXT NOT NULL REFERENCES records(record_id),
  media_id TEXT NOT NULL REFERENCES media_objects(media_id), caption TEXT,
  position INTEGER NOT NULL CHECK(position>=0), removed_at INTEGER,
  UNIQUE(record_id,attachment_id)
) STRICT;
INSERT INTO attachments_next SELECT * FROM attachments;
DROP TABLE attachments;
ALTER TABLE attachments_next RENAME TO attachments;
CREATE UNIQUE INDEX attachments_live_position ON attachments(record_id,position) WHERE removed_at IS NULL;
CREATE INDEX attachments_media ON attachments(media_id,removed_at);
CREATE TRIGGER attachment_scope_insert BEFORE INSERT ON attachments
WHEN (SELECT scope_id FROM records WHERE record_id=NEW.record_id) <> (SELECT scope_id FROM media_objects WHERE media_id=NEW.media_id)
BEGIN SELECT RAISE(ABORT,'attachment_scope_mismatch'); END;
CREATE TRIGGER attachment_identity_update BEFORE UPDATE OF record_id,media_id ON attachments
WHEN NEW.record_id<>OLD.record_id OR NEW.media_id<>OLD.media_id
BEGIN SELECT RAISE(ABORT,'attachment_identity_immutable'); END;
