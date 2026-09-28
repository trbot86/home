-- Advisory results only. Claim before dispatch; never automatically retry an uncertain send.
CREATE TABLE inbox_filing_suggestions (
  inbox_id TEXT PRIMARY KEY NOT NULL REFERENCES inbox_entries(inbox_id),
  source_revision INTEGER NOT NULL,
  scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  state TEXT NOT NULL CHECK (state IN ('attempted','complete','failed','stale')),
  attempt INTEGER NOT NULL DEFAULT 1,
  choices_json TEXT NOT NULL DEFAULT '[]',
  attempted_at INTEGER NOT NULL
) STRICT;

CREATE TABLE inbox_filing_advice_preferences (
  person_id TEXT PRIMARY KEY NOT NULL REFERENCES people(person_id),
  credential_id TEXT NOT NULL REFERENCES client_credentials(credential_id),
  revision INTEGER NOT NULL,
  preferences_json TEXT NOT NULL
) STRICT;
