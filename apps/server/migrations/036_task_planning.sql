ALTER TABLE task_occurrences ADD COLUMN calendar_visible INTEGER NOT NULL DEFAULT 1 CHECK(calendar_visible IN (0,1));
ALTER TABLE task_occurrences ADD COLUMN approximate_date TEXT CHECK(approximate_date IN ('asap','week','month'));
