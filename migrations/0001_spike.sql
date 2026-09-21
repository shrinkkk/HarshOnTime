-- Phase 0 spike tables. These get dropped when the real schema arrives in Phase 1.
CREATE TABLE spike_subs (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  platform    TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE spike_pushes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  target_sub  TEXT,              -- NULL = everyone
  due_at      INTEGER NOT NULL,  -- ms since epoch
  sent_at     INTEGER,           -- NULL until the cron tick (or immediate send) picks it up
  created_at  INTEGER NOT NULL
);
CREATE INDEX spike_pushes_due ON spike_pushes (sent_at, due_at);

CREATE TABLE spike_deliveries (
  push_id      TEXT NOT NULL,
  sub_id       TEXT NOT NULL,
  label        TEXT NOT NULL,
  platform     TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  status       INTEGER NOT NULL,  -- HTTP status from the push service
  detail       TEXT,
  received_at  INTEGER,           -- set when the phone's service worker reports back
  PRIMARY KEY (push_id, sub_id)
);
