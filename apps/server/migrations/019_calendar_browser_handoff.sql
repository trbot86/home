-- Callback codes are short-lived server secrets. Activation still requires the original authenticated client.
CREATE TABLE calendar_browser_handoffs (
  handoff_id TEXT PRIMARY KEY NOT NULL,
  state_digest TEXT UNIQUE NOT NULL REFERENCES calendar_authorizations(state_digest) ON DELETE CASCADE,
  browser_digest TEXT NOT NULL,
  sealed_response TEXT CHECK(sealed_response IS NULL OR length(sealed_response)<=32768)
) STRICT;
