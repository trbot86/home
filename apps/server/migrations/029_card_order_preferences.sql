-- Personal presentation only: no changes to captures, history or queued requests.
CREATE TABLE card_order_preferences (
  scope_id TEXT NOT NULL REFERENCES visibility_scopes(scope_id),
  category TEXT NOT NULL CHECK(category IN ('inbox','app_suggestion')),
  revision INTEGER NOT NULL CHECK(revision>0),
  order_json TEXT NOT NULL CHECK(json_valid(order_json) AND length(order_json)<=100000),
  PRIMARY KEY(scope_id,category)
) STRICT;
