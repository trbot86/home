-- Token ciphertext belongs to the transactional database; its keys are host configuration.
ALTER TABLE calendar_connections ADD COLUMN google_subject TEXT;
CREATE UNIQUE INDEX calendar_account_owner ON calendar_connections(owner_person_id,provider,google_subject)
  WHERE state<>'disconnected' AND google_subject IS NOT NULL;
CREATE TRIGGER calendar_account_identity BEFORE UPDATE OF google_subject ON calendar_connections
WHEN OLD.google_subject IS NOT NULL AND (NEW.google_subject IS NULL OR NEW.google_subject<>OLD.google_subject)
BEGIN SELECT RAISE(ABORT,'calendar account identity is immutable'); END;

CREATE TABLE calendar_credentials (
  credential_ref TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL UNIQUE REFERENCES calendar_connections(connection_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  sealed_json TEXT NOT NULL CHECK(length(sealed_json) BETWEEN 1 AND 131072),
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER calendar_credentials_current BEFORE INSERT ON calendar_credentials
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM calendar_connections WHERE connection_id=NEW.connection_id
      AND credential_ref=NEW.credential_ref AND state='active'
  ) THEN RAISE(ABORT,'calendar credential is not current') END;
END;
CREATE TRIGGER calendar_credentials_unlink AFTER UPDATE OF credential_ref ON calendar_connections
WHEN OLD.credential_ref IS NOT NEW.credential_ref
BEGIN DELETE FROM calendar_credentials WHERE credential_ref=OLD.credential_ref; END;

CREATE TABLE calendar_authorizations (
  state_digest TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(person_id),
  client_id TEXT NOT NULL REFERENCES clients(client_id),
  credential_id TEXT NOT NULL REFERENCES client_credentials(credential_id),
  recovery_epoch TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 300),
  connection_id TEXT REFERENCES calendar_connections(connection_id),
  connection_generation INTEGER,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','complete','failed')),
  sealed_json TEXT,
  result_connection_id TEXT REFERENCES calendar_connections(connection_id),
  CHECK((connection_id IS NULL AND connection_generation IS NULL) OR
    (connection_id IS NOT NULL AND connection_generation>0)),
  CHECK((state='pending' AND sealed_json IS NOT NULL) OR (state<>'pending' AND sealed_json IS NULL)),
  CHECK((state='complete' AND result_connection_id IS NOT NULL) OR
    (state<>'complete' AND result_connection_id IS NULL))
) STRICT;
CREATE INDEX calendar_authorizations_expiry ON calendar_authorizations(expires_at);
