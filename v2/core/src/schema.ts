/**
 * DDL for the one-SQLite-database-per-node core store (spec 01 schema draft).
 * Session logs / runtime event streams stay as append-only files OUTSIDE the DB;
 * only their path is recorded on the bee.
 */

/**
 * Stamped into meta('schema_version') on open. Bump when the schema changes
 * shape. Open refuses a NEWER store (downgrade — typed SchemaVersionError,
 * same failure mode as apiaryd's interface store, spec 06 §6); an OLDER (or
 * pre-stamp v1) store is migrated by explicit code in the store constructor —
 * never silently.
 *
 * History:
 *   v1 — WP1..WP6a shape (unstamped; stores without the meta key are v1).
 *   v2 — spec 06 §4.2 one-key idempotency: adds the nullable UNIQUE
 *        `commands.idempotency_key` column and the `rpc_idempotency` results
 *        table (additive; migration = ALTER TABLE ADD COLUMN).
 *   v3 — WP7 continuity (spec 07 §F): adds `bees.provider_session_id` (the
 *        harness-native session/thread id revive resumes with),
 *        `bees.env` (per-bee env overrides, e.g. the harness config home an
 *        imported bee's session lives in) and `bees.imported_from`
 *        (provenance: null | "frozen"). Additive; migration = ALTER TABLE
 *        ADD COLUMN ×3.
 *   v4 — spawn-failure budget (contract §4.2 `spawn_failed`, spec 01 B5):
 *        adds `bees.spawn_failures`, the count of consecutive runtimes that
 *        exited during `booting`. One budget per bee across wake-driven
 *        revives; exhaustion sets `spawn_failed` and suppresses further
 *        wakes. Additive; migration = ALTER TABLE ADD COLUMN.
 */
export const SCHEMA_VERSION = 4;

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
  -- v3: harness-native session/thread id of the bee's conversation (claude
  -- session_id, codex thread id). Recorded from the runtime's booted signal;
  -- revive hands it back to the harness (claude --resume / codex thread/resume)
  -- so a new generation continues the same conversation (spec 07 §F).
  provider_session_id TEXT,
  -- v3: per-bee env overrides applied over the agent spec at spawn (json
  -- object of strings). The importer uses it for the harness config home
  -- (CLAUDE_CONFIG_DIR / CODEX_HOME / …) an old-world session lives in.
  env              TEXT NOT NULL DEFAULT '{}',
  -- v3: provenance — null for bees born in v2, "frozen" for records imported
  -- from the frozen old-world store (id preserved; details in the audit row).
  imported_from    TEXT,
  -- v4: consecutive boot failures — runtimes that exited (crashed/clean)
  -- while still booting. Reset to 0 by a successful boot (booting →
  -- running) or an operator revive. The wake path applies the B5 backoff
  -- table to it and stops reviving at the budget (spawn_failed flag).
  spawn_failures   INTEGER NOT NULL DEFAULT 0
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
  failure_cause     TEXT CHECK (failure_cause IN ('auth_needed','resource_blocked','spawn_failed','node_unreachable')),
  idempotency_key   TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS commands_ready ON commands(status, next_attempt_at, id);
-- The UNIQUE (partial) index on commands.idempotency_key lives in
-- IDEMPOTENCY_INDEX_SQL below: it can only be created once the column exists,
-- which on a migrated v1 store happens in the constructor's migration step.

-- v3/v4 additive columns on bees, applied by the constructor's migration step
-- to stores created before them (CREATE TABLE IF NOT EXISTS leaves an existing
-- table's shape alone). Order matters for nothing; each is added iff missing.

-- Spec 06 §4.2 one-key idempotency: RPC mutation results recorded by key so a
-- replayed mutation (same caller-supplied idempotencyKey) answers with the
-- ORIGINAL outcome instead of executing twice. Not part of StateDump/audit
-- replay (infrastructure, like meta). Bounded: the store keeps the newest
-- maxRpcIdempotencyRows rows (default 10 000) and evicts the oldest beyond
-- that — v2 never prunes command rows today, so this table (not command-row
-- retention) is the dedup memory that outlives any future pruning.
CREATE TABLE IF NOT EXISTS rpc_idempotency (
  key        TEXT PRIMARY KEY,
  verb       TEXT NOT NULL,
  command_id INTEGER,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS audit (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  kind    TEXT NOT NULL,
  bee_id  TEXT,
  payload TEXT NOT NULL
) STRICT;

-- Templates + tracks (spec 06 §1.4.1): hive-owned registries; scope + source are
-- data on the row; names are unique per scope; steps are an ordered JSON array.
CREATE TABLE IF NOT EXISTS templates (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  scope            TEXT NOT NULL CHECK (scope IN ('personal','team','repo')),
  source           TEXT NOT NULL,
  description      TEXT,
  agent            TEXT NOT NULL,
  substrate        TEXT,
  model            TEXT,
  effort           TEXT,
  args             TEXT NOT NULL DEFAULT '[]',
  prompt           TEXT NOT NULL,
  preamble         TEXT,
  preamble_enabled INTEGER NOT NULL DEFAULT 1 CHECK (preamble_enabled IN (0,1)),
  cwd_policy       TEXT NOT NULL CHECK (cwd_policy IN ('caller','fixed')),
  cwd              TEXT,
  env              TEXT NOT NULL DEFAULT '{}',
  account          TEXT,
  yolo             INTEGER NOT NULL DEFAULT 0 CHECK (yolo IN (0,1)),
  tags             TEXT NOT NULL DEFAULT '[]',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((cwd_policy = 'fixed') = (cwd IS NOT NULL)),
  UNIQUE (scope, name)
) STRICT;

CREATE TABLE IF NOT EXISTS tracks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('personal','team','repo')),
  source      TEXT NOT NULL,
  description TEXT,
  steps       TEXT NOT NULL DEFAULT '[]',
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope, name)
) STRICT;
`;

/**
 * One key = one command, enforced by the database (spec 06 §4.2). Partial so
 * the column stays nullable: internal enqueues (send_wake, loop policy stops)
 * carry no key.
 */
/**
 * Additive columns on `bees` since v2 — name → ADD COLUMN clause (migration =
 * add iff missing). v3: provider_session_id, env, imported_from; v4:
 * spawn_failures.
 */
export const BEES_ADDITIVE_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["provider_session_id", "provider_session_id TEXT"],
  ["env", "env TEXT NOT NULL DEFAULT '{}'"],
  ["imported_from", "imported_from TEXT"],
  ["spawn_failures", "spawn_failures INTEGER NOT NULL DEFAULT 0"],
];

export const IDEMPOTENCY_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS commands_idempotency_key
  ON commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
`;
