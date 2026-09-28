-- Keep historical releases and their manifests intact; membership is additive.
CREATE TABLE suggestion_release_members (
  release_id TEXT NOT NULL REFERENCES suggestion_releases(release_id),
  suggestion_id TEXT NOT NULL REFERENCES suggestion_workflows(suggestion_id),
  run_id TEXT NOT NULL REFERENCES suggestion_runs(run_id),
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(release_id,suggestion_id),
  UNIQUE(release_id,ordinal)
) STRICT;
CREATE INDEX suggestion_release_member_run ON suggestion_release_members(run_id);
INSERT INTO suggestion_release_members
  SELECT release_id,suggestion_id,run_id,0 FROM suggestion_releases;
