-- Referenced-table rebuild: the migration runner brackets this transaction with
-- foreign-key enforcement disabled and verifies every relationship before commit.
CREATE TABLE worker_actors (
  worker_id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL UNIQUE CHECK(purpose='recipe_import'),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;
CREATE TEMP TABLE worker_sequence (seq INTEGER NOT NULL);
INSERT INTO worker_sequence SELECT seq FROM sqlite_sequence WHERE name='change_sets';
CREATE TABLE new_clients (
  client_id TEXT PRIMARY KEY NOT NULL, person_id TEXT REFERENCES people(person_id),
  kind TEXT NOT NULL CHECK(kind IN ('browser','android','integration','worker')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  integration_id TEXT REFERENCES integration_actors(integration_id),
  worker_id TEXT UNIQUE REFERENCES worker_actors(worker_id),
  CHECK((kind IN ('browser','android') AND person_id IS NOT NULL AND integration_id IS NULL AND worker_id IS NULL)
     OR (kind='integration' AND person_id IS NULL AND integration_id IS NOT NULL AND worker_id IS NULL)
     OR (kind='worker' AND person_id IS NULL AND integration_id IS NULL AND worker_id IS NOT NULL)),
  UNIQUE(client_id,person_id), UNIQUE(client_id,integration_id), UNIQUE(client_id,worker_id)
) STRICT;
INSERT INTO new_clients(rowid,client_id,person_id,kind,enabled,integration_id)
  SELECT rowid,client_id,person_id,kind,enabled,integration_id FROM clients;
DROP TABLE clients;
ALTER TABLE new_clients RENAME TO clients;
CREATE TRIGGER clients_owner_immutable BEFORE UPDATE OF person_id,integration_id,worker_id,kind ON clients
WHEN OLD.person_id IS NOT NEW.person_id OR OLD.integration_id IS NOT NEW.integration_id OR OLD.worker_id IS NOT NEW.worker_id OR OLD.kind IS NOT NEW.kind
BEGIN SELECT RAISE(ABORT,'client ownership is immutable'); END;
CREATE TRIGGER credentials_reject_workers BEFORE INSERT ON client_credentials
WHEN EXISTS (SELECT 1 FROM clients WHERE client_id=NEW.client_id AND kind='worker')
BEGIN SELECT RAISE(ABORT,'workers cannot have HTTP credentials'); END;
CREATE TRIGGER credentials_cannot_move_to_workers BEFORE UPDATE OF client_id ON client_credentials
WHEN EXISTS (SELECT 1 FROM clients WHERE client_id=NEW.client_id AND kind='worker')
BEGIN SELECT RAISE(ABORT,'workers cannot have HTTP credentials'); END;

CREATE TABLE new_change_sets (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT, change_set_id TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(client_id), actor_person_id TEXT REFERENCES people(person_id),
  operation_kind TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  undo_of_id TEXT REFERENCES change_sets(change_set_id), redo_of_id TEXT REFERENCES change_sets(change_set_id),
  actor_integration_id TEXT REFERENCES integration_actors(integration_id),
  actor_worker_id TEXT REFERENCES worker_actors(worker_id),
  cause_change_set_id TEXT REFERENCES change_sets(change_set_id),
  CHECK((actor_person_id IS NOT NULL)+(actor_integration_id IS NOT NULL)+(actor_worker_id IS NOT NULL)=1),
  CHECK(undo_of_id IS NULL OR redo_of_id IS NULL),
  CHECK(actor_worker_id IS NULL OR (cause_change_set_id IS NOT NULL AND undo_of_id IS NULL AND redo_of_id IS NULL)),
  FOREIGN KEY(client_id,actor_person_id) REFERENCES clients(client_id,person_id),
  FOREIGN KEY(client_id,actor_integration_id) REFERENCES clients(client_id,integration_id),
  FOREIGN KEY(client_id,actor_worker_id) REFERENCES clients(client_id,worker_id)
) STRICT;
INSERT INTO new_change_sets(commit_sequence,change_set_id,client_id,actor_person_id,operation_kind,recorded_at,undo_of_id,redo_of_id,actor_integration_id)
  SELECT commit_sequence,change_set_id,client_id,actor_person_id,operation_kind,recorded_at,undo_of_id,redo_of_id,actor_integration_id FROM change_sets;
DROP TABLE change_sets;
ALTER TABLE new_change_sets RENAME TO change_sets;
CREATE UNIQUE INDEX changes_undo_once ON change_sets(undo_of_id) WHERE undo_of_id IS NOT NULL;
CREATE UNIQUE INDEX changes_redo_once ON change_sets(redo_of_id) WHERE redo_of_id IS NOT NULL;
CREATE INDEX changes_cause ON change_sets(cause_change_set_id) WHERE cause_change_set_id IS NOT NULL;
INSERT INTO sqlite_sequence(name,seq)
  SELECT 'change_sets',COALESCE(MAX(seq),0) FROM worker_sequence
  HAVING NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name='change_sets');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT MAX(seq) FROM worker_sequence),0)) WHERE name='change_sets';
DROP TABLE worker_sequence;
CREATE TABLE new_operation_receipts (
  client_id TEXT NOT NULL REFERENCES clients(client_id), operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, actor_person_id TEXT REFERENCES people(person_id),
  outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)), recorded_at INTEGER NOT NULL,
  actor_integration_id TEXT REFERENCES integration_actors(integration_id),
  actor_worker_id TEXT REFERENCES worker_actors(worker_id),
  PRIMARY KEY(client_id,operation_id),
  CHECK((actor_person_id IS NOT NULL)+(actor_integration_id IS NOT NULL)+(actor_worker_id IS NOT NULL)=1),
  FOREIGN KEY(client_id,actor_person_id) REFERENCES clients(client_id,person_id),
  FOREIGN KEY(client_id,actor_integration_id) REFERENCES clients(client_id,integration_id),
  FOREIGN KEY(client_id,actor_worker_id) REFERENCES clients(client_id,worker_id)
) STRICT;
INSERT INTO new_operation_receipts(rowid,client_id,operation_id,request_digest,actor_person_id,outcome_json,recorded_at,actor_integration_id)
  SELECT rowid,client_id,operation_id,request_digest,actor_person_id,outcome_json,recorded_at,actor_integration_id FROM operation_receipts;
DROP TABLE operation_receipts;
ALTER TABLE new_operation_receipts RENAME TO operation_receipts;

ALTER TABLE background_jobs ADD COLUMN lease_token TEXT;
ALTER TABLE background_jobs ADD COLUMN lease_until INTEGER;
CREATE INDEX background_jobs_ready ON background_jobs(kind,state,run_after);
CREATE TABLE worker_jobs (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES background_jobs(job_id),
  client_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  target_record_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK(expected_revision>0), expected_server_epoch TEXT NOT NULL,
  cause_change_set_id TEXT NOT NULL REFERENCES change_sets(change_set_id),
  UNIQUE(job_id,target_record_id,scope_id),
  FOREIGN KEY(client_id,worker_id) REFERENCES clients(client_id,worker_id),
  FOREIGN KEY(target_record_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE INDEX worker_jobs_target ON worker_jobs(target_record_id,job_id);
CREATE TRIGGER worker_job_grant_immutable BEFORE UPDATE ON worker_jobs
BEGIN SELECT RAISE(ABORT,'worker job authority is immutable'); END;
