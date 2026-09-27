ALTER TABLE people ADD COLUMN is_administrator INTEGER NOT NULL DEFAULT 0 CHECK(is_administrator IN (0,1));
CREATE TABLE backup_runs (
  run_id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, snapshot_at INTEGER,
  completed_at INTEGER, state TEXT NOT NULL CHECK(state IN ('running','complete','failed','abandoned','pruned')),
  archive_name TEXT, byte_length INTEGER, digest TEXT, verified_at INTEGER, error_code TEXT
) STRICT;
CREATE INDEX backup_runs_time ON backup_runs(started_at DESC);
CREATE INDEX records_scope_created ON records(scope_id,deleted_at,created_at DESC,record_id DESC);
