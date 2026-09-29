-- Google iCal capability URLs are server-only credentials, never part of client projections.
ALTER TABLE calendar_connections ADD COLUMN transport TEXT NOT NULL DEFAULT 'oauth'
  CHECK(transport IN ('oauth','ical'));
CREATE TABLE calendar_ical_credentials (
  credential_ref TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL UNIQUE REFERENCES calendar_connections(connection_id),
  feed_url TEXT NOT NULL CHECK(length(feed_url) BETWEEN 1 AND 4096)
) STRICT;
CREATE TRIGGER calendar_ical_unlink AFTER UPDATE OF credential_ref ON calendar_connections
WHEN OLD.credential_ref IS NOT NULL AND NEW.credential_ref IS NOT OLD.credential_ref
BEGIN DELETE FROM calendar_ical_credentials WHERE credential_ref=OLD.credential_ref; END;
