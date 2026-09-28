-- Reading a discussion is per-person metadata, not a change to household content.
CREATE TABLE suggestion_read_positions (
  suggestion_id TEXT NOT NULL REFERENCES suggestion_workflows(suggestion_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  workflow_revision INTEGER NOT NULL DEFAULT 0 CHECK(workflow_revision>=0),
  message_sequence INTEGER NOT NULL DEFAULT 0 CHECK(message_sequence>=0),
  work_token TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(suggestion_id,person_id)
) STRICT;
