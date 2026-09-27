CREATE TABLE installation_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation_id TEXT NOT NULL UNIQUE,
  recovery_epoch TEXT NOT NULL, restored_from_at INTEGER, recovery_mode TEXT NOT NULL DEFAULT 'normal'
) STRICT;
CREATE TABLE people (
  person_id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_verifier TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;
CREATE TABLE clients (
  client_id TEXT PRIMARY KEY NOT NULL, person_id TEXT NOT NULL REFERENCES people(person_id),
  kind TEXT NOT NULL CHECK(kind IN ('browser','android')), enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
) STRICT;
CREATE TABLE client_credentials (
  credential_id TEXT PRIMARY KEY NOT NULL, client_id TEXT NOT NULL REFERENCES clients(client_id),
  verifier TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
) STRICT;
CREATE INDEX client_credentials_client ON client_credentials(client_id);
CREATE TABLE visibility_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('shared','private')),
  owner_person_id TEXT REFERENCES people(person_id),
  CHECK((kind='shared' AND owner_person_id IS NULL) OR (kind='private' AND owner_person_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX one_shared_scope ON visibility_scopes(kind) WHERE kind='shared';
CREATE UNIQUE INDEX one_private_scope ON visibility_scopes(owner_person_id) WHERE kind='private';
CREATE TABLE record_kinds (kind TEXT PRIMARY KEY NOT NULL) STRICT;
INSERT INTO record_kinds VALUES ('inbox');
CREATE TABLE records (
  record_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL REFERENCES record_kinds(kind),
  scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id), revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE(record_id,kind)
) STRICT;
CREATE INDEX records_scope_updated ON records(scope_id,deleted_at,updated_at DESC,record_id DESC);
CREATE TABLE inbox_entries (
  inbox_id TEXT PRIMARY KEY NOT NULL, record_kind TEXT NOT NULL DEFAULT 'inbox' CHECK(record_kind='inbox'),
  text TEXT NOT NULL, captured_at INTEGER NOT NULL, source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  FOREIGN KEY(inbox_id,record_kind) REFERENCES records(record_id,kind)
) STRICT;
CREATE TABLE media_objects (
  media_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  creator_client_id TEXT NOT NULL REFERENCES clients(client_id), digest TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length>0),
  mime_type TEXT NOT NULL, storage_key TEXT NOT NULL UNIQUE, generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','ready','deleting','collected')),
  created_at INTEGER NOT NULL, unreferenced_at INTEGER, protected_until INTEGER NOT NULL
) STRICT;
CREATE INDEX media_collection ON media_objects(state,unreferenced_at,protected_until);
CREATE TABLE attachments (
  attachment_id TEXT PRIMARY KEY NOT NULL, record_id TEXT NOT NULL REFERENCES records(record_id),
  media_id TEXT NOT NULL REFERENCES media_objects(media_id), caption TEXT, position INTEGER NOT NULL CHECK(position>=0), removed_at INTEGER,
  UNIQUE(record_id,position)
) STRICT;
CREATE INDEX attachments_media ON attachments(media_id,removed_at);
CREATE TABLE change_sets (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT, change_set_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(client_id), actor_person_id TEXT NOT NULL REFERENCES people(person_id),
  operation_kind TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  undo_of_id TEXT REFERENCES change_sets(change_set_id), redo_of_id TEXT REFERENCES change_sets(change_set_id),
  CHECK(undo_of_id IS NULL OR redo_of_id IS NULL)
) STRICT;
CREATE UNIQUE INDEX changes_undo_once ON change_sets(undo_of_id) WHERE undo_of_id IS NOT NULL;
CREATE UNIQUE INDEX changes_redo_once ON change_sets(redo_of_id) WHERE redo_of_id IS NOT NULL;
CREATE TABLE record_changes (
  change_set_id TEXT NOT NULL REFERENCES change_sets(change_set_id), record_id TEXT NOT NULL REFERENCES records(record_id),
  before_revision INTEGER NOT NULL, after_revision INTEGER NOT NULL,
  before_scope_id TEXT REFERENCES visibility_scopes(scope_id), after_scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  payload_version INTEGER NOT NULL CHECK(payload_version=1), delta_json TEXT NOT NULL CHECK(json_valid(delta_json)),
  PRIMARY KEY(change_set_id,record_id)
) STRICT;
CREATE INDEX record_changes_record ON record_changes(record_id,after_revision);
CREATE TABLE operation_receipts (
  client_id TEXT NOT NULL REFERENCES clients(client_id), operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, actor_person_id TEXT NOT NULL REFERENCES people(person_id),
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)), recorded_at INTEGER NOT NULL,
  PRIMARY KEY(client_id,operation_id)
) STRICT;
CREATE TABLE background_jobs (
  job_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), state TEXT NOT NULL,
  run_after INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT
) STRICT;
