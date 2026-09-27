-- This referenced-table rebuild preserves existing worker identities. The runner
-- disables FK enforcement around the transaction and checks all FKs before commit.
CREATE TABLE new_worker_actors (
  worker_id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('recipe_import','suggestion_work')),
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 80),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
) STRICT;
INSERT INTO new_worker_actors SELECT * FROM worker_actors;
DROP TABLE worker_actors;
ALTER TABLE new_worker_actors RENAME TO worker_actors;
CREATE UNIQUE INDEX one_recipe_worker ON worker_actors(purpose) WHERE purpose='recipe_import';

INSERT INTO record_kinds VALUES ('suggestion_workflow'),('suggestion_message');
CREATE TABLE suggestion_workflows (
  workflow_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'suggestion_workflow' CHECK(record_kind='suggestion_workflow'),
  suggestion_id TEXT NOT NULL UNIQUE REFERENCES inbox_entries(inbox_id), scope_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','queued','working','needs_input','ready','released')),
  UNIQUE(workflow_id,scope_id), UNIQUE(suggestion_id,scope_id),
  FOREIGN KEY(workflow_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(workflow_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(suggestion_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE suggestion_agents (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES worker_actors(worker_id),
  client_id TEXT NOT NULL UNIQUE, token_digest TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  accepting_work INTEGER NOT NULL DEFAULT 0 CHECK(accepting_work IN (0,1)),
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  FOREIGN KEY(client_id,agent_id) REFERENCES clients(client_id,worker_id)
) STRICT;
CREATE TABLE suggestion_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  suggestion_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES suggestion_agents(agent_id),
  server_epoch TEXT NOT NULL, lease_token TEXT NOT NULL, lease_until INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','starting','running','needs_input','ready','failed','uncertain','cancelled')),
  session_id TEXT, turn_id TEXT, issue TEXT,
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  cause_change_set_id TEXT NOT NULL REFERENCES change_sets(change_set_id),
  UNIQUE(run_id,suggestion_id,scope_id),
  FOREIGN KEY(suggestion_id,scope_id) REFERENCES suggestion_workflows(suggestion_id,scope_id)
) STRICT;
CREATE UNIQUE INDEX one_active_suggestion_run ON suggestion_runs(suggestion_id)
  WHERE state IN ('claimed','starting','running','uncertain');
CREATE TABLE suggestion_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
  record_kind TEXT NOT NULL DEFAULT 'suggestion_message' CHECK(record_kind='suggestion_message'),
  suggestion_id TEXT NOT NULL, scope_id TEXT NOT NULL, text TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('note','request','progress','question','resolution','release')),
  author_person_id TEXT REFERENCES people(person_id), author_agent_id TEXT REFERENCES suggestion_agents(agent_id),
  author_name TEXT NOT NULL, run_id TEXT, reply_to_question_id TEXT,
  choices_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(choices_json)),
  CHECK((author_person_id IS NOT NULL)+(author_agent_id IS NOT NULL)=1),
  CHECK((author_agent_id IS NULL AND run_id IS NULL) OR (author_agent_id IS NOT NULL AND run_id IS NOT NULL)),
  UNIQUE(message_id,suggestion_id,scope_id),
  FOREIGN KEY(message_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(message_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(suggestion_id,scope_id) REFERENCES suggestion_workflows(suggestion_id,scope_id),
  FOREIGN KEY(run_id,suggestion_id,scope_id) REFERENCES suggestion_runs(run_id,suggestion_id,scope_id),
  FOREIGN KEY(reply_to_question_id,suggestion_id,scope_id) REFERENCES suggestion_messages(message_id,suggestion_id,scope_id)
) STRICT;
CREATE INDEX suggestion_message_order ON suggestion_messages(suggestion_id,sequence);
CREATE TABLE suggestion_work_requests (
  request_id TEXT PRIMARY KEY NOT NULL, suggestion_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES people(person_id), requested_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','needs_input','ready','failed','uncertain','cancelled')),
  run_id TEXT, cause_change_set_id TEXT NOT NULL REFERENCES change_sets(change_set_id),
  FOREIGN KEY(request_id,suggestion_id,scope_id) REFERENCES suggestion_messages(message_id,suggestion_id,scope_id),
  FOREIGN KEY(run_id,suggestion_id,scope_id) REFERENCES suggestion_runs(run_id,suggestion_id,scope_id)
) STRICT;
CREATE INDEX suggestion_request_queue ON suggestion_work_requests(state,requested_at,request_id);
CREATE TABLE suggestion_run_inputs (
  run_id TEXT NOT NULL, message_id TEXT NOT NULL, message_revision INTEGER NOT NULL,
  suggestion_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  PRIMARY KEY(run_id,message_id),
  FOREIGN KEY(run_id,suggestion_id,scope_id) REFERENCES suggestion_runs(run_id,suggestion_id,scope_id),
  FOREIGN KEY(message_id,suggestion_id,scope_id) REFERENCES suggestion_messages(message_id,suggestion_id,scope_id)
) STRICT;
CREATE TABLE suggestion_question_resolutions (
  question_id TEXT NOT NULL, message_id TEXT NOT NULL, suggestion_id TEXT NOT NULL, scope_id TEXT NOT NULL,
  PRIMARY KEY(question_id,message_id),
  FOREIGN KEY(question_id,suggestion_id,scope_id) REFERENCES suggestion_messages(message_id,suggestion_id,scope_id),
  FOREIGN KEY(message_id,suggestion_id,scope_id) REFERENCES suggestion_messages(message_id,suggestion_id,scope_id)
) STRICT;
-- External dispatch has its own response shape. Receipts share this database and
-- transaction with run state, and are never exposed as human command receipts.
CREATE TABLE suggestion_agent_receipts (
  agent_id TEXT NOT NULL REFERENCES suggestion_agents(agent_id), operation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  recorded_at INTEGER NOT NULL, PRIMARY KEY(agent_id,operation_id)
) STRICT;
