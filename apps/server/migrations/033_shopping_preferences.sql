CREATE TABLE shopping_preferences (
  person_id TEXT PRIMARY KEY REFERENCES people(person_id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  preferences_json TEXT NOT NULL
);
