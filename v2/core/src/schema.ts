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
 *   v5 — per-bee spawn args: adds `bees.args` (nullable json array of
 *        harness CLI args layered over the agent spec at spawn; the frozen
 *        importer fills it from the old record's launch argv so a resumed
 *        old-world bee keeps its model/effort/permission flags). Additive;
 *        migration = ALTER TABLE ADD COLUMN ×1.
 *   v6 — pre-flip verb set (parenting, fork, questions, seals): adds
 *        `bees.parent_id` (nullable soft ref to the spawning bee),
 *        `bees.forked_from` (provenance: the bee this one was forked from)
 *        and `bees.fork_seed` (the source's provider session id the FIRST
 *        runtime forks from; consumed when the fork reports its own id),
 *        plus the `questions` and `seals` tables. Additive; migration =
 *        ALTER TABLE ADD COLUMN ×3 + CREATE TABLE IF NOT EXISTS ×2.
 *   v7 — accounts and auth (spec 08 CORE): adds the `accounts` table (a
 *        provider login identity: harness + home + label + status + penalty),
 *        `account_limits` (the latest limits snapshot per account, feeding
 *        the calibrated selector), `selection_cursors` (per-harness near-tie
 *        rotation cursor — a row, not a json file) and `bees.account`
 *        (declared intent, concrete after spawn — never 'auto'). Additive;
 *        migration = ALTER TABLE ADD COLUMN ×1 + CREATE TABLE IF NOT EXISTS ×3.
 */
export const SCHEMA_VERSION = 7;

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
  spawn_failures   INTEGER NOT NULL DEFAULT 0,
  -- v5: per-bee harness CLI args (json array of strings, or NULL = none),
  -- composed over the agent spec's args at spawn (daemon resolveSpawnSpec:
  -- spec args < spec defaultArgs < bee args < resume args; later wins per flag).
  args             TEXT,
  -- v6: the bee that spawned this one (soft reference — no FK, so a parent
  -- may be deleted; delete ORPHANS children by nulling this, never cascades).
  parent_id        TEXT,
  -- v6: provenance — the bee this one was forked from (soft reference).
  forked_from      TEXT,
  -- v6: one-shot fork seed — the SOURCE's provider session id the first
  -- runtime forks from (claude --resume <seed> --fork-session, codex
  -- thread/fork); cleared once the fork's own session id is recorded.
  fork_seed        TEXT,
  -- v7: the account (accounts.id) this bee runs on — declared intent made
  -- concrete at spawn ('auto' is resolved BEFORE the row is written; never
  -- stored). Soft reference: account.remove refuses while any bee carries
  -- it. The mechanism stays bees.env[HOME_ENV[harness]] = accounts.home_path.
  account          TEXT
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

-- v6: a bee's question to the operator (spec: pre-flip verbs). Open until
-- answered; the answer is ALSO delivered to the bee as an ordinary mailbox
-- message (delivery_message_id) so the bee learns it through the one channel.
CREATE TABLE IF NOT EXISTS questions (
  id                  TEXT PRIMARY KEY,
  bee_id              TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation          INTEGER,
  text                TEXT NOT NULL,
  options             TEXT,
  status              TEXT NOT NULL CHECK (status IN ('open','answered')),
  answer              TEXT,
  asked_at            INTEGER NOT NULL,
  answered_at         INTEGER,
  answered_by         TEXT,
  delivery_message_id INTEGER,
  CHECK ((status = 'answered') = (answered_at IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS questions_open ON questions(bee_id, asked_at) WHERE status = 'open';

-- v6: seals — a bee's structured "here is what I did" record (metadata only:
-- title/body/refs), tied to the generation that sealed.
CREATE TABLE IF NOT EXISTS seals (
  id         TEXT PRIMARY KEY,
  bee_id     TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  generation INTEGER,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  refs       TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS seals_bee ON seals(bee_id, created_at);

-- v7 (spec 08): accounts — a provider login identity (the WHO). One account
-- = one run-home (home_path, the WHERE); every bee on the account shares it.
-- status: ok | auth_needed (adapter/login evidence) | paused (operator: out
-- of the auto pool; explicit spawn refused). penalty: operator hint added to
-- the selector's effective weekly load. exhausted_at: last rate-limit
-- exhaustion evidence (rotation cool-off).
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  harness       TEXT NOT NULL,
  home_path     TEXT NOT NULL,
  label         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','auth_needed','paused')),
  penalty       INTEGER NOT NULL DEFAULT 0,
  last_login_at INTEGER,
  exhausted_at  INTEGER,
  added_at      INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS accounts_harness ON accounts(harness, added_at, id);

-- v7: the latest limits snapshot per account (one row, replaced on fetch).
-- Percentages are provider "used%" per window; *_resets_at epoch ms;
-- *_minutes the window length when known (pace needs it). readable = the
-- fetch answered (0 = the fetch failed; error says why; the selector ranks
-- unreadable accounts last).
CREATE TABLE IF NOT EXISTS account_limits (
  account              TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  fetched_at           INTEGER NOT NULL,
  readable             INTEGER NOT NULL CHECK (readable IN (0,1)),
  error                TEXT,
  plan                 TEXT,
  five_hour_pct        REAL,
  five_hour_resets_at  INTEGER,
  five_hour_minutes    INTEGER,
  weekly_pct           REAL,
  weekly_resets_at     INTEGER,
  weekly_minutes       INTEGER,
  fable_weekly_pct     REAL,
  fable_resets_at      INTEGER,
  fable_minutes        INTEGER
) STRICT;

-- v7: per-harness near-tie rotation cursor (the old round-robin.json
-- 'auto-tie:<harness>' key, now a row).
CREATE TABLE IF NOT EXISTS selection_cursors (
  harness         TEXT PRIMARY KEY,
  last_account_id TEXT NOT NULL,
  updated_at      INTEGER NOT NULL
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
 * spawn_failures; v5: args; v6: parent_id, forked_from, fork_seed; v7: account.
 */
export const BEES_ADDITIVE_COLUMNS: ReadonlyArray<readonly [name: string, ddl: string]> = [
  ["provider_session_id", "provider_session_id TEXT"],
  ["env", "env TEXT NOT NULL DEFAULT '{}'"],
  ["imported_from", "imported_from TEXT"],
  ["spawn_failures", "spawn_failures INTEGER NOT NULL DEFAULT 0"],
  ["args", "args TEXT"],
  ["parent_id", "parent_id TEXT"],
  ["forked_from", "forked_from TEXT"],
  ["fork_seed", "fork_seed TEXT"],
  ["account", "account TEXT"],
];

export const IDEMPOTENCY_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS commands_idempotency_key
  ON commands(idempotency_key) WHERE idempotency_key IS NOT NULL;
`;
