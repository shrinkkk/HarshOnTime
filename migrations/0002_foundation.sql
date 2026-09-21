-- Phase 1: real schema. The Phase 0 spike tables are throwaway and are dropped here.
DROP TABLE IF EXISTS spike_deliveries;
DROP TABLE IF EXISTS spike_pushes;
DROP TABLE IF EXISTS spike_subs;

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- removed_at marks a member who left or was removed. The row is kept (not deleted) so that
-- wakeups/activities/events created by them still have someone to display; secret_hash is
-- cleared on removal so the old device secret stops authenticating.
CREATE TABLE members (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id),
  nickname      TEXT NOT NULL,
  secret_hash   TEXT,
  joined_at     INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  push_ok_at    INTEGER,
  removed_at    INTEGER
);
CREATE INDEX members_group ON members (group_id);
CREATE UNIQUE INDEX members_secret_hash ON members (secret_hash) WHERE secret_hash IS NOT NULL;
-- Case-insensitive uniqueness of nickname within a group, only among current (non-removed) members.
CREATE UNIQUE INDEX members_group_nickname ON members (group_id, nickname COLLATE NOCASE) WHERE removed_at IS NULL;

-- token_hash is the only thing stored for the invite token: the plaintext token (used as both the
-- /join#<token> link and the code a person can type by hand) is never persisted server-side.
-- used_by has no foreign key: the invite is claimed (used_by set) before the member row it names
-- exists, as the atomic reservation for that join. It is bookkeeping, not a relationship to enforce.
CREATE TABLE invites (
  token_hash  TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  created_by  TEXT NOT NULL REFERENCES members(id),
  expires_at  INTEGER NOT NULL,
  used_by     TEXT,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX invites_group ON invites (group_id);

CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES members(id),
  endpoint      TEXT NOT NULL UNIQUE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  platform      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  last_ok_at    INTEGER,
  last_error    TEXT
);
CREATE INDEX subscriptions_member ON subscriptions (member_id);

CREATE TABLE wakeups (
  id                TEXT PRIMARY KEY,
  group_id          TEXT NOT NULL REFERENCES groups(id),
  requester_id      TEXT NOT NULL REFERENCES members(id),
  wake_at           INTEGER NOT NULL,
  note              TEXT,
  status            TEXT NOT NULL DEFAULT 'upcoming', -- upcoming | claimed | awake | expired
  claimed_by        TEXT REFERENCES members(id),
  claimed_at        INTEGER,
  awake_at          INTEGER,
  reminder_sent_at  INTEGER,
  created_at        INTEGER NOT NULL
);
CREATE INDEX wakeups_group ON wakeups (group_id, wake_at);
CREATE INDEX wakeups_due ON wakeups (status, reminder_sent_at, wake_at);

CREATE TABLE activities (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  member_id   TEXT NOT NULL REFERENCES members(id),
  kind        TEXT NOT NULL, -- breakfast | lunch | snacks | sutta | campus
  created_at  INTEGER NOT NULL
);
CREATE INDEX activities_group ON activities (group_id, created_at);

CREATE TABLE prefs (
  member_id             TEXT PRIMARY KEY REFERENCES members(id),
  wakeups_enabled       INTEGER NOT NULL DEFAULT 1,
  wakeups_muted_until   INTEGER,
  activities_muted_until INTEGER,
  breakfast             INTEGER NOT NULL DEFAULT 1,
  lunch                 INTEGER NOT NULL DEFAULT 1,
  snacks                INTEGER NOT NULL DEFAULT 1,
  sutta                 INTEGER NOT NULL DEFAULT 1,
  campus                INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE mutes (
  member_id         TEXT NOT NULL REFERENCES members(id),
  muted_member_id   TEXT NOT NULL REFERENCES members(id),
  scope             TEXT NOT NULL, -- wakeups | activities
  PRIMARY KEY (member_id, muted_member_id, scope)
);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL REFERENCES groups(id),
  kind        TEXT NOT NULL,
  actor_id    TEXT REFERENCES members(id),
  subject_id  TEXT REFERENCES members(id),
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX events_group ON events (group_id, created_at);
