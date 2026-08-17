/**
 * DDL for the one-SQLite-database-per-node core store (spec 01 schema draft).
 * Session logs / runtime event streams stay as append-only files OUTSIDE the DB;
 * only their path is recorded on the bee.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS bees (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  agent            TEXT NOT NULL,
  substrate        TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  title            TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  session_log_path TEXT,
  lifecycle        TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
  created_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  last_output_at   INTEGER,
  output_read_at   INTEGER
) STRICT;
-- Note: 'deleted' never appears as a stored lifecycle — Q1 says delete removes the
-- record row immediately, so a missing row IS the deleted state.

CREATE TABLE IF NOT EXISTS runtimes (
  bee_id         TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation     INTEGER NOT NULL CHECK (generation >= 1),
  state          TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
  exit_cause     TEXT CHECK (exit_cause IN ('clean','crashed','stopped_by_user','stopped_by_system','machine_restart')),
  pid            INTEGER,
  pid_started_at INTEGER,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (bee_id, generation),
  CHECK ((state = 'stopped') = (exit_cause IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id     TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  flag       TEXT NOT NULL CHECK (flag IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable')),
  detail     TEXT NOT NULL,
  set_at     INTEGER NOT NULL,
  cleared_at INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS flags_active ON flags(bee_id, flag) WHERE cleared_at IS NULL;

CREATE TABLE IF NOT EXISTS mailbox (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  bee_id               TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  sender               TEXT NOT NULL,
  body                 TEXT NOT NULL,
  priority             INTEGER NOT NULL DEFAULT 0, -- Q2: reserved for future tiers; unused in ordering today
  enqueued_at          INTEGER NOT NULL,
  delivered_at         INTEGER,
  delivered_generation INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS mailbox_undelivered ON mailbox(bee_id, id) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS commands (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  verb              TEXT NOT NULL CHECK (verb IN ('spawn','send_wake','stop','revive','archive','unarchive','delete')),
  bee_id            TEXT NOT NULL,
  args              TEXT NOT NULL DEFAULT '{}',
  target_generation INTEGER,
  status            TEXT NOT NULL CHECK (status IN ('queued','running','done','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  enqueued_at       INTEGER NOT NULL,
  finished_at       INTEGER,
  failure_cause     TEXT CHECK (failure_cause IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable'))
) STRICT;
CREATE INDEX IF NOT EXISTS commands_ready ON commands(status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS audit (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  bee_id  TEXT,
  payload TEXT NOT NULL
) STRICT;
`;
