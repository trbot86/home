CREATE TABLE recipe_imports (
  recipe_import_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL UNIQUE,
  recipe_id TEXT NOT NULL, scope_id TEXT NOT NULL, source_url TEXT NOT NULL,
  requested_at INTEGER NOT NULL, result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), retrieved_at INTEGER,
  automatic_operation_id TEXT NOT NULL UNIQUE,
  application_json TEXT CHECK(application_json IS NULL OR json_valid(application_json)),
  applied_change_set_id TEXT REFERENCES change_sets(change_set_id),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  CHECK((result_json IS NULL)=(retrieved_at IS NULL)),
  CHECK(application_json IS NULL OR result_json IS NOT NULL),
  CHECK(applied_change_set_id IS NULL OR result_json IS NOT NULL),
  FOREIGN KEY(job_id,recipe_id,scope_id) REFERENCES worker_jobs(job_id,target_record_id,scope_id),
  FOREIGN KEY(recipe_id,scope_id) REFERENCES recipes(recipe_id,scope_id)
) STRICT;
CREATE UNIQUE INDEX recipe_import_active ON recipe_imports(recipe_id) WHERE active=1;
CREATE INDEX recipe_import_parent ON recipe_imports(recipe_id,requested_at DESC,recipe_import_id);
CREATE TRIGGER recipe_import_source_immutable BEFORE UPDATE OF job_id,recipe_id,scope_id,source_url,requested_at,automatic_operation_id ON recipe_imports
WHEN OLD.job_id IS NOT NEW.job_id OR OLD.recipe_id IS NOT NEW.recipe_id OR OLD.scope_id IS NOT NEW.scope_id OR OLD.source_url IS NOT NEW.source_url OR OLD.requested_at IS NOT NEW.requested_at OR OLD.automatic_operation_id IS NOT NEW.automatic_operation_id
BEGIN SELECT RAISE(ABORT,'recipe import source is immutable'); END;
CREATE TRIGGER recipe_import_result_immutable BEFORE UPDATE OF result_json,retrieved_at ON recipe_imports
WHEN OLD.result_json IS NOT NULL AND (OLD.result_json IS NOT NEW.result_json OR OLD.retrieved_at IS NOT NEW.retrieved_at)
BEGIN SELECT RAISE(ABORT,'recipe import result is immutable'); END;
CREATE TRIGGER recipe_import_application_immutable BEFORE UPDATE OF application_json ON recipe_imports
WHEN OLD.application_json IS NOT NULL AND OLD.application_json IS NOT NEW.application_json
BEGIN SELECT RAISE(ABORT,'recipe import application is immutable'); END;

-- URI provenance outlives file collection; only the media subsystem owns bytes.
CREATE TABLE recipe_import_media (
  job_id TEXT NOT NULL REFERENCES worker_jobs(job_id), candidate_id TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE REFERENCES media_objects(media_id),
  attachment_id TEXT NOT NULL UNIQUE, source_uri TEXT NOT NULL,
  PRIMARY KEY(job_id,candidate_id)
) STRICT;
CREATE TRIGGER recipe_import_media_immutable BEFORE UPDATE ON recipe_import_media
BEGIN SELECT RAISE(ABORT,'recipe import media provenance is immutable'); END;
