-- The migration runner performs this referenced-table rebuild with foreign keys
-- disabled outside its transaction, then checks integrity before committing.
CREATE TABLE integration_actors (
  integration_id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;

CREATE TEMP TABLE integration_sequence (seq INTEGER NOT NULL);
INSERT INTO integration_sequence SELECT seq FROM sqlite_sequence WHERE name='change_sets';

CREATE TABLE new_clients (
  client_id TEXT PRIMARY KEY NOT NULL, person_id TEXT REFERENCES people(person_id),
  kind TEXT NOT NULL CHECK(kind IN ('browser','android','integration')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  integration_id TEXT REFERENCES integration_actors(integration_id),
  CHECK((kind IN ('browser','android') AND person_id IS NOT NULL AND integration_id IS NULL)
     OR (kind='integration' AND person_id IS NULL AND integration_id IS NOT NULL)),
  UNIQUE(client_id,person_id), UNIQUE(client_id,integration_id)
) STRICT;
INSERT INTO new_clients(rowid,client_id,person_id,kind,enabled)
  SELECT rowid,client_id,person_id,kind,enabled FROM clients;
DROP TABLE clients;
ALTER TABLE new_clients RENAME TO clients;
CREATE TRIGGER clients_owner_immutable BEFORE UPDATE OF person_id,integration_id,kind ON clients
WHEN OLD.person_id IS NOT NEW.person_id OR OLD.integration_id IS NOT NEW.integration_id OR OLD.kind IS NOT NEW.kind
BEGIN SELECT RAISE(ABORT,'client ownership is immutable'); END;

CREATE TABLE new_change_sets (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT, change_set_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(client_id), actor_person_id TEXT REFERENCES people(person_id),
  operation_kind TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  undo_of_id TEXT REFERENCES change_sets(change_set_id), redo_of_id TEXT REFERENCES change_sets(change_set_id),
  actor_integration_id TEXT REFERENCES integration_actors(integration_id),
  CHECK((actor_person_id IS NOT NULL) != (actor_integration_id IS NOT NULL)),
  CHECK(undo_of_id IS NULL OR redo_of_id IS NULL),
  FOREIGN KEY(client_id,actor_person_id) REFERENCES clients(client_id,person_id),
  FOREIGN KEY(client_id,actor_integration_id) REFERENCES clients(client_id,integration_id)
) STRICT;
INSERT INTO new_change_sets(commit_sequence,change_set_id,client_id,actor_person_id,operation_kind,recorded_at,undo_of_id,redo_of_id)
  SELECT commit_sequence,change_set_id,client_id,actor_person_id,operation_kind,recorded_at,undo_of_id,redo_of_id FROM change_sets;
DROP TABLE change_sets;
ALTER TABLE new_change_sets RENAME TO change_sets;
CREATE UNIQUE INDEX changes_undo_once ON change_sets(undo_of_id) WHERE undo_of_id IS NOT NULL;
CREATE UNIQUE INDEX changes_redo_once ON change_sets(redo_of_id) WHERE redo_of_id IS NOT NULL;
INSERT INTO sqlite_sequence(name,seq)
  SELECT 'change_sets',COALESCE(MAX(seq),0) FROM integration_sequence
  HAVING NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='change_sets');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM integration_sequence),0)) WHERE name='change_sets';
DROP TABLE integration_sequence;

CREATE TABLE new_operation_receipts (
  client_id TEXT NOT NULL REFERENCES clients(client_id), operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, actor_person_id TEXT REFERENCES people(person_id),
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)), recorded_at INTEGER NOT NULL,
  actor_integration_id TEXT REFERENCES integration_actors(integration_id),
  PRIMARY KEY(client_id,operation_id),
  CHECK((actor_person_id IS NOT NULL) != (actor_integration_id IS NOT NULL)),
  FOREIGN KEY(client_id,actor_person_id) REFERENCES clients(client_id,person_id),
  FOREIGN KEY(client_id,actor_integration_id) REFERENCES clients(client_id,integration_id)
) STRICT;
INSERT INTO new_operation_receipts(rowid,client_id,operation_id,request_digest,actor_person_id,outcome_json,recorded_at)
  SELECT rowid,client_id,operation_id,request_digest,actor_person_id,outcome_json,recorded_at FROM operation_receipts;
DROP TABLE operation_receipts;
ALTER TABLE new_operation_receipts RENAME TO operation_receipts;
