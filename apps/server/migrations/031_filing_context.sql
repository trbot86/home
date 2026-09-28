-- Persist coverage alongside the durable attempt, without storing exported titles.
ALTER TABLE inbox_filing_suggestions ADD COLUMN context_json TEXT CHECK(context_json IS NULL OR json_valid(context_json));
