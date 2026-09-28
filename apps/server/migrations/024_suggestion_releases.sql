-- Release jobs are operational records. They never rewrite household history.
CREATE TABLE suggestion_releases (
  release_id TEXT PRIMARY KEY NOT NULL,
  suggestion_id TEXT NOT NULL REFERENCES suggestion_workflows(suggestion_id),
  run_id TEXT NOT NULL REFERENCES suggestion_runs(run_id),
  server_epoch TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES people(person_id),
  agent_id TEXT REFERENCES suggestion_agents(agent_id),
  state TEXT NOT NULL CHECK(state IN ('queued','preparing','prepared','deploy_queued','deploying','released','failed','cancelled','uncertain')),
  revision INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL,
  manifest_json TEXT,
  manifest_digest TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX suggestion_release_one_active ON suggestion_releases((1))
  WHERE state IN ('queued','preparing','prepared','deploy_queued','deploying','uncertain');
CREATE INDEX suggestion_releases_suggestion ON suggestion_releases(suggestion_id,created_at DESC);
