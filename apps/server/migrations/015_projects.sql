INSERT INTO record_kinds VALUES ('project'),('project_page');
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'project' CHECK(record_kind='project'),
  scope_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  archived INTEGER NOT NULL CHECK(archived IN (0,1)),
  UNIQUE(project_id,scope_id),
  FOREIGN KEY(project_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(project_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE TABLE project_pages (
  page_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'project_page' CHECK(record_kind='project_page'),
  scope_id TEXT NOT NULL, project_id TEXT NOT NULL, parent_page_id TEXT,
  title TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0),
  CHECK(page_id IS NOT parent_page_id),
  UNIQUE(project_id,page_id),
  FOREIGN KEY(page_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(page_id,scope_id) REFERENCES records(record_id,scope_id),
  FOREIGN KEY(project_id,scope_id) REFERENCES projects(project_id,scope_id),
  -- A whole subtree can move between projects in one transaction.
  FOREIGN KEY(project_id,parent_page_id) REFERENCES project_pages(project_id,page_id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX project_pages_project ON project_pages(project_id,parent_page_id,position,page_id);
CREATE INDEX project_pages_parent ON project_pages(parent_page_id,page_id);
CREATE TABLE page_blocks (
  block_id TEXT PRIMARY KEY NOT NULL, page_id TEXT NOT NULL REFERENCES project_pages(page_id),
  position INTEGER NOT NULL CHECK(position>=0), kind TEXT NOT NULL CHECK(kind IN ('text','web_link','record_link','attachment')),
  text TEXT, url TEXT, title TEXT, notes TEXT, target_record_id TEXT REFERENCES records(record_id),
  caption TEXT, attachment_id TEXT, retired_at INTEGER,
  FOREIGN KEY(page_id,attachment_id) REFERENCES attachments(record_id,attachment_id),
  CHECK((kind='text' AND text IS NOT NULL AND url IS NULL AND title IS NULL AND notes IS NULL AND target_record_id IS NULL AND caption IS NULL AND attachment_id IS NULL)
    OR (kind='web_link' AND text IS NULL AND url IS NOT NULL AND title IS NOT NULL AND notes IS NOT NULL AND target_record_id IS NULL AND caption IS NULL AND attachment_id IS NULL)
    OR (kind='record_link' AND text IS NULL AND url IS NULL AND title IS NULL AND notes IS NULL AND target_record_id IS NOT NULL AND caption IS NOT NULL AND attachment_id IS NULL)
    OR (kind='attachment' AND text IS NULL AND url IS NULL AND title IS NULL AND notes IS NULL AND target_record_id IS NULL AND caption IS NULL AND attachment_id IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX page_blocks_live_position ON page_blocks(page_id,position) WHERE retired_at IS NULL;
CREATE INDEX page_blocks_target ON page_blocks(target_record_id,page_id);
CREATE TRIGGER page_block_identity BEFORE UPDATE OF page_id,kind ON page_blocks
WHEN OLD.page_id IS NOT NEW.page_id OR OLD.kind IS NOT NEW.kind
BEGIN SELECT RAISE(ABORT,'page block ownership and kind are immutable'); END;
