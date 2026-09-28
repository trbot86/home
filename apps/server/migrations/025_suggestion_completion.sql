-- Completion is a household decision, independent of work and release status.
-- Existing suggestions remain active and retain their discussion and history.
ALTER TABLE suggestion_workflows ADD COLUMN completed_at INTEGER CHECK(completed_at >= 0);
