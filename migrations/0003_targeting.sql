-- Optional targeting: a wake-up or plan can be sent to a chosen subset of the group instead of everyone.
-- audience is a JSON array of member ids, or NULL for the whole group. Custom plans carry free text.
ALTER TABLE wakeups ADD COLUMN audience TEXT;
ALTER TABLE activities ADD COLUMN text TEXT;
