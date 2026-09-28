CREATE TABLE suggestion_steering (
  run_id TEXT NOT NULL REFERENCES suggestion_runs(run_id),
  message_id TEXT NOT NULL REFERENCES suggestion_messages(message_id),
  revision INTEGER NOT NULL,
  message_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','uncertain','missed')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,message_id)
) STRICT;
CREATE INDEX suggestion_steering_message ON suggestion_steering(message_id);
