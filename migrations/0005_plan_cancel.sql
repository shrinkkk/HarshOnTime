-- A plan's creator can cancel it. Cancelled plans keep their feed line but lose In/Out.
ALTER TABLE activities ADD COLUMN cancelled_at INTEGER;
