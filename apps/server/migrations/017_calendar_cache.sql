-- External calendar projections are replaceable caches, outside household record history.
CREATE TABLE calendar_connections (
  connection_id TEXT PRIMARY KEY NOT NULL,
  owner_person_id TEXT NOT NULL REFERENCES people(person_id),
  provider TEXT NOT NULL CHECK(provider='google'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 300),
  credential_ref TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('active','needs_auth','disconnected')),
  generation INTEGER NOT NULL CHECK(generation>0),
  discovery_generation INTEGER NOT NULL DEFAULT 0 CHECK(discovery_generation>=0),
  last_attempt_at INTEGER,
  error_code TEXT CHECK(error_code IN ('authentication_required','access_denied','calendar_unavailable','rate_limited','provider_unavailable','invalid_provider_response','calendar_limit')),
  updated_at INTEGER NOT NULL,
  CHECK((state='disconnected' AND credential_ref IS NULL) OR (state<>'disconnected' AND credential_ref IS NOT NULL))
) STRICT;
CREATE INDEX calendar_connections_owner ON calendar_connections(owner_person_id,state);

CREATE TABLE calendars (
  calendar_id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES calendar_connections(connection_id),
  provider_calendar_id TEXT NOT NULL CHECK(length(provider_calendar_id) BETWEEN 1 AND 2048),
  title TEXT NOT NULL CHECK(length(title)<=1000),
  time_zone TEXT NOT NULL CHECK(length(time_zone) BETWEEN 1 AND 100),
  access_role TEXT NOT NULL CHECK(access_role IN ('reader','writer','owner','freeBusyReader')),
  is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
  scope_id TEXT REFERENCES visibility_scopes(scope_id),
  context TEXT NOT NULL CHECK(context IN ('home','work')),
  revision INTEGER NOT NULL CHECK(revision>0),
  refresh_generation INTEGER NOT NULL DEFAULT 0 CHECK(refresh_generation>=0),
  snapshot_from INTEGER,
  snapshot_until INTEGER,
  refreshed_at INTEGER,
  last_attempt_at INTEGER,
  error_code TEXT CHECK(error_code IN ('authentication_required','access_denied','calendar_unavailable','rate_limited','provider_unavailable','invalid_provider_response','calendar_limit')),
  UNIQUE(connection_id,provider_calendar_id),
  CHECK((snapshot_from IS NULL AND snapshot_until IS NULL AND refreshed_at IS NULL)
    OR (snapshot_from IS NOT NULL AND snapshot_until>snapshot_from AND refreshed_at IS NOT NULL))
) STRICT;
CREATE INDEX calendars_scope ON calendars(scope_id);
CREATE TRIGGER calendar_private_owner_insert BEFORE INSERT ON calendars WHEN NEW.scope_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM visibility_scopes s JOIN calendar_connections c ON c.connection_id=NEW.connection_id
    WHERE s.scope_id=NEW.scope_id AND (s.kind='shared' OR s.owner_person_id=c.owner_person_id)
  ) THEN RAISE(ABORT,'calendar scope owner mismatch') END;
END;
CREATE TRIGGER calendar_private_owner_update BEFORE UPDATE OF scope_id,connection_id ON calendars WHEN NEW.scope_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM visibility_scopes s JOIN calendar_connections c ON c.connection_id=NEW.connection_id
    WHERE s.scope_id=NEW.scope_id AND (s.kind='shared' OR s.owner_person_id=c.owner_person_id)
  ) THEN RAISE(ABORT,'calendar scope owner mismatch') END;
END;
CREATE TRIGGER calendar_connection_identity BEFORE UPDATE OF owner_person_id,provider ON calendar_connections
WHEN NEW.owner_person_id<>OLD.owner_person_id OR NEW.provider<>OLD.provider
BEGIN SELECT RAISE(ABORT,'calendar connection identity is immutable'); END;
CREATE TRIGGER calendar_source_identity BEFORE UPDATE OF connection_id,provider_calendar_id ON calendars
WHEN NEW.connection_id<>OLD.connection_id OR NEW.provider_calendar_id<>OLD.provider_calendar_id
BEGIN SELECT RAISE(ABORT,'calendar source identity is immutable'); END;

CREATE TABLE calendar_event_cache (
  calendar_id TEXT NOT NULL REFERENCES calendars(calendar_id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=262144),
  PRIMARY KEY(calendar_id,provider_event_id,instance_key)
) STRICT;
