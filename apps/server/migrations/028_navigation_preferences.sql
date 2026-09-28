-- Personal presentation preferences only; existing records and requests are untouched.
CREATE TABLE navigation_preferences (
  scope_id TEXT PRIMARY KEY NOT NULL REFERENCES visibility_scopes(scope_id),
  revision INTEGER NOT NULL CHECK(revision>0),
  order_json TEXT NOT NULL CHECK(json_valid(order_json) AND length(order_json)<=2048)
) STRICT;
