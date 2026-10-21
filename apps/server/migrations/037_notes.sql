INSERT INTO record_kinds VALUES ('note');
CREATE TABLE notes (
  note_id TEXT PRIMARY KEY NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'note' CHECK(record_kind='note'),
  scope_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL,
  UNIQUE(note_id,scope_id),
  FOREIGN KEY(note_id,record_kind) REFERENCES records(record_id,kind),
  FOREIGN KEY(note_id,scope_id) REFERENCES records(record_id,scope_id)
) STRICT;
CREATE INDEX notes_category ON notes(scope_id,category);
