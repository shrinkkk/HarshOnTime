-- In/out replies on plans, a Dinner button, and enough bookkeeping to link feed entries to plans.
CREATE TABLE rsvps (
  activity_id  TEXT NOT NULL REFERENCES activities(id),
  member_id    TEXT NOT NULL REFERENCES members(id),
  status       TEXT NOT NULL, -- in | out
  at           INTEGER NOT NULL,
  PRIMARY KEY (activity_id, member_id)
);
ALTER TABLE activities ADD COLUMN audience TEXT; -- JSON array of member ids, NULL = everyone (who may reply)
ALTER TABLE events ADD COLUMN ref_id TEXT;       -- the activity (or wakeup) a feed entry is about
ALTER TABLE prefs ADD COLUMN dinner INTEGER NOT NULL DEFAULT 1;
