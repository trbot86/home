INSERT INTO record_kinds VALUES ('home_asset'),('maintenance_record');
CREATE TABLE home_assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'home_asset' CHECK(record_kind='home_asset'),
  scope_id TEXT NOT NULL, name TEXT NOT NULL, model TEXT NOT NULL, serial TEXT NOT NULL,
  location TEXT NOT NULL, acquired_date TEXT, notes TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  UNIQUE(asset_id,scope_id),
  FOREIGN KEY(asset_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(asset_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE maintenance_plans (
  task_id TEXT PRIMARY KEY NOT NULL, scope_id TEXT NOT NULL, asset_id TEXT NOT NULL, reference TEXT NOT NULL,
  FOREIGN KEY(task_id,scope_id) REFERENCES tasks(task_id,scope_id),
  FOREIGN KEY(asset_id,scope_id) REFERENCES home_assets(asset_id,scope_id)
) STRICT;
CREATE INDEX maintenance_plans_asset ON maintenance_plans(asset_id);
CREATE UNIQUE INDEX task_completion_scope ON task_completions(completion_id,scope_id);
CREATE TABLE maintenance_records (
  maintenance_record_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'maintenance_record' CHECK(record_kind='maintenance_record'),
  scope_id TEXT NOT NULL, asset_id TEXT NOT NULL, completion_id TEXT UNIQUE,
  occurred_at INTEGER NOT NULL, notes TEXT NOT NULL, cost_amount TEXT, currency TEXT,
  CHECK((cost_amount IS NULL) = (currency IS NULL)),
  FOREIGN KEY(maintenance_record_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(maintenance_record_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(asset_id,scope_id) REFERENCES home_assets(asset_id,scope_id),
  FOREIGN KEY(completion_id,scope_id) REFERENCES task_completions(completion_id,scope_id)
) STRICT;
CREATE INDEX maintenance_records_asset_time ON maintenance_records(asset_id,occurred_at DESC,maintenance_record_id);
