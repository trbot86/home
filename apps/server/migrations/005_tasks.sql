INSERT INTO record_kinds VALUES ('task'),('task_occurrence'),('task_completion');
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'task' CHECK(record_kind='task'),
  scope_id TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  context TEXT NOT NULL CHECK(context IN ('home','work')),
  default_assignee_id TEXT REFERENCES people(person_id), default_priority INTEGER NOT NULL CHECK(default_priority BETWEEN 0 AND 3),
  UNIQUE(task_id,scope_id),
  FOREIGN KEY(task_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(task_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE task_recurrences (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(task_id),
  version INTEGER NOT NULL CHECK(version=1), mode TEXT NOT NULL CHECK(mode='after_completion'),
  interval_count INTEGER NOT NULL CHECK(interval_count BETWEEN 1 AND 365),
  interval_unit TEXT NOT NULL CHECK(interval_unit IN ('days','weeks','months')), time_zone TEXT NOT NULL
) STRICT;
CREATE TABLE task_occurrences (
  occurrence_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'task_occurrence' CHECK(record_kind='task_occurrence'),
  scope_id TEXT NOT NULL, task_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=1),
  state TEXT NOT NULL CHECK(state IN ('open','completed','cancelled')),
  assignee_id TEXT REFERENCES people(person_id), priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 3),
  deadline_date TEXT, target_date TEXT, review_date TEXT,
  is_live INTEGER NOT NULL DEFAULT 1 CHECK(is_live IN (0,1)),
  UNIQUE(task_id,ordinal), UNIQUE(occurrence_id,scope_id),
  FOREIGN KEY(occurrence_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(occurrence_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(task_id,scope_id) REFERENCES tasks(task_id,scope_id)
) STRICT;
CREATE UNIQUE INDEX one_open_task_occurrence ON task_occurrences(task_id) WHERE state='open' AND is_live=1;
CREATE TRIGGER task_occurrence_live AFTER UPDATE OF deleted_at ON records WHEN NEW.kind='task_occurrence'
BEGIN UPDATE task_occurrences SET is_live=(NEW.deleted_at IS NULL) WHERE occurrence_id=NEW.record_id; END;
CREATE INDEX task_occurrences_dates ON task_occurrences(state,assignee_id,target_date);
CREATE TABLE task_completions (
  completion_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'task_completion' CHECK(record_kind='task_completion'),
  scope_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
  completed_at INTEGER NOT NULL, performed_by_person_id TEXT NOT NULL REFERENCES people(person_id),
  performer_name TEXT NOT NULL, note TEXT NOT NULL,
  rule_revision INTEGER NOT NULL CHECK(rule_revision>=1), recurrence_json TEXT CHECK(recurrence_json IS NULL OR json_valid(recurrence_json)),
  next_occurrence_id TEXT, is_live INTEGER NOT NULL DEFAULT 1 CHECK(is_live IN (0,1)),
  FOREIGN KEY(completion_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(completion_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(occurrence_id,scope_id) REFERENCES task_occurrences(occurrence_id,scope_id),
  FOREIGN KEY(next_occurrence_id,scope_id) REFERENCES task_occurrences(occurrence_id,scope_id)
) STRICT;
CREATE UNIQUE INDEX one_task_completion ON task_completions(occurrence_id) WHERE is_live=1;
CREATE INDEX task_completions_time ON task_completions(completed_at DESC,completion_id);
CREATE TRIGGER task_completion_live AFTER UPDATE OF deleted_at ON records WHEN NEW.kind='task_completion'
BEGIN UPDATE task_completions SET is_live=(NEW.deleted_at IS NULL) WHERE completion_id=NEW.record_id; END;
