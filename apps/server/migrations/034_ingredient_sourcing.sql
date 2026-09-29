CREATE TABLE ingredient_sourcing (
  person_id TEXT NOT NULL REFERENCES people(person_id),
  recipe_id TEXT NOT NULL REFERENCES records(record_id),
  attempt INTEGER NOT NULL,
  recipe_revision INTEGER NOT NULL,
  preferences_revision INTEGER NOT NULL,
  ingredient_ids TEXT NOT NULL,
  exception_ids TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK(state IN ('working','complete','failed','stale')),
  PRIMARY KEY(person_id,recipe_id)
);
