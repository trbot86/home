-- Independent of content history: undoing an edit must not remove protection.
CREATE TABLE record_security (
  record_id TEXT PRIMARY KEY NOT NULL REFERENCES records(record_id),
  secure INTEGER NOT NULL CHECK(secure IN (0,1)),
  revision INTEGER NOT NULL CHECK(revision>0)
) STRICT;

-- UNION (not UNION ALL) terminates even for cycles in retained filing links.
CREATE VIEW secure_records AS
WITH RECURSIVE edges(child,parent) AS (
  SELECT page_id,project_id FROM project_pages
  UNION SELECT page_id,parent_page_id FROM project_pages WHERE parent_page_id IS NOT NULL
  UNION SELECT inbox_id,target_record_id FROM inbox_destinations
  UNION SELECT shopping_entry_id,shopping_list_id FROM shopping_entries
), protected(record_id) AS (
  SELECT record_id FROM record_security WHERE secure=1
  UNION SELECT edges.child FROM edges JOIN protected ON edges.parent=protected.record_id
)
SELECT record_id FROM protected;


-- The development agent is also a model consumer. Block a whole discussion if
-- any part is protected, including immutable snapshots and replayed claims.
CREATE VIEW secure_suggestions AS
SELECT inbox_id AS suggestion_id FROM inbox_entries WHERE inbox_id IN (SELECT record_id FROM secure_records)
UNION SELECT suggestion_id FROM suggestion_messages WHERE message_id IN (SELECT record_id FROM secure_records)
UNION SELECT suggestion_id FROM suggestion_workflows WHERE workflow_id IN (SELECT record_id FROM secure_records);
