ALTER TABLE inbox_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'inbox'
  CHECK (category IN ('inbox', 'app_suggestion'));
