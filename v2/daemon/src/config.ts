/**
 * Per-node daemon config (spec 04 behavior 7; Q1 resolution: json).
 *
 * One file per node: `<dataDir>/config.json`. Every value has a default and
 * the file may be absent. Unknown keys are ignored (forward compatibility);
 * malformed json or wrongly-typed values fail loudly — a half-read config is
 * worse than no config.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** How to spawn one agent CLI (keyed by the bee's `agent` field). */
export interface AgentSpecConfig {
  command: string;
  args?: string[];
  /** Adapter name: claude | codex | stub. Defaults to the agent key itself. */
  adapter?: string;
  env?: Record<string, string>;
}

/** The raw (all-optional) shape of config.json. */
export interface NodeConfigFile {
  /** Scale-to-zero idle window (behavior 3). Default 60 min; 0/negative disables. */
  idleWindowMs?: number;
  /** Hang policy: stop a runtime stuck in `booting` past this. */
  bootHangTimeoutMs?: number;
  /** Hang policy: stop a runtime stuck in `running` past this. */
  turnHangTimeoutMs?: number;
  /** I1 deadline allowance for a replacement runtime to boot. */
  bootAllowanceMs?: number;
  /** I1 deadline allowance for a preceding turn to finish. */
  turnAllowanceMs?: number;
  /**
   * I1 delivery deadline per pending mailbox position (behavior 5). Clamped
   * UP to the policy-aware floor: max(hang timeouts) + boot + turn allowances
   * — the WP2 finding that a bound below policy reach measures nothing.
   */
  i1DeadlineMs?: number;
  /** Daemon tick interval. */
  tickMs?: number;
  /** Executor budget per tick. */
  commandsPerTick?: number;
  /** B5 retry table. */
  retry?: { maxAttempts?: number; backoffBaseMs?: number };
  /** TERM→KILL escalation grace for stops. */
  stopKillGraceMs?: number;
  /** Start-time tolerance for cross-restart re-adoption. */
  adoptToleranceMs?: number;
  /** Watch stream: max delta events per frame before the server declares a gap. */
  watchMaxBatch?: number;
  socketPath?: string;
  logPath?: string;
  storePath?: string;
  telemetryPath?: string;
  sessionLogDir?: string;
  agents?: Record<string, AgentSpecConfig>;
}

export interface ResolvedNodeConfig {
  dataDir: string;
  configPath: string;
  idleWindowMs: number;
  bootHangTimeoutMs: number;
  turnHangTimeoutMs: number;
  bootAllowanceMs: number;
  turnAllowanceMs: number;
  /** The effective (floor-clamped) I1 deadline. */
  i1DeadlineMs: number;
  /** The policy-aware floor the deadline was clamped to. */
  i1FloorMs: number;
  tickMs: number;
  commandsPerTick: number;
  maxAttempts: number;
  backoffBaseMs: number;
  stopKillGraceMs: number;
  adoptToleranceMs: number;
  watchMaxBatch: number;
  socketPath: string;
  logPath: string;
  storePath: string;
  telemetryPath: string;
  sessionLogDir: string;
  agents: Record<string, AgentSpecConfig>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Built-in agent table; a config `agents` entry with the same key overrides it wholesale. */
export const BUILTIN_AGENTS: Record<string, AgentSpecConfig> = {
  claude: {
    command: "claude",
    args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
    adapter: "claude",
  },
  codex: {
    command: "codex",
    args: ["app-server"],
    adapter: "codex",
  },
};

export const DEFAULTS = {
  idleWindowMs: 60 * 60 * 1000, // Q4 ruling: default 60 min
  bootHangTimeoutMs: 3 * 60 * 1000,
  turnHangTimeoutMs: 45 * 60 * 1000,
  bootAllowanceMs: 60 * 1000,
  turnAllowanceMs: 5 * 60 * 1000,
  tickMs: 200,
  commandsPerTick: 8,
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  stopKillGraceMs: 5000,
  adoptToleranceMs: 5000,
  watchMaxBatch: 256,
} as const;

/** Default per-node data directory; overridable via HIVE_V2_DATA_DIR (tests always set it). */
export function defaultDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.HIVE_V2_DATA_DIR ?? join(homedir(), ".hive", "v2");
}

function num(raw: Record<string, unknown>, key: string, fallback: number): number {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ConfigError(`config: ${key} must be a finite number, got ${JSON.stringify(v)}`);
  }
  return v;
}

function str(raw: Record<string, unknown>, key: string, fallback: string): string {
  const v = raw[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.length === 0) {
    throw new ConfigError(`config: ${key} must be a non-empty string`);
  }
  return v;
}

function agentsOf(raw: Record<string, unknown>): Record<string, AgentSpecConfig> {
  const v = raw.agents;
  if (v === undefined) return {};
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError("config: agents must be an object of {command, args?, adapter?, env?}");
  }
  const out: Record<string, AgentSpecConfig> = {};
  for (const [name, spec] of Object.entries(v as Record<string, unknown>)) {
    if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
      throw new ConfigError(`config: agents.${name} must be an object`);
    }
    const s = spec as Record<string, unknown>;
    if (typeof s.command !== "string" || s.command.length === 0) {
      throw new ConfigError(`config: agents.${name}.command must be a non-empty string`);
    }
    const entry: AgentSpecConfig = { command: s.command };
    if (s.args !== undefined) {
      if (!Array.isArray(s.args) || s.args.some((a) => typeof a !== "string")) {
        throw new ConfigError(`config: agents.${name}.args must be a string array`);
      }
      entry.args = s.args as string[];
    }
    if (s.adapter !== undefined) {
      if (typeof s.adapter !== "string") throw new ConfigError(`config: agents.${name}.adapter must be a string`);
      entry.adapter = s.adapter;
    }
    if (s.env !== undefined) {
      if (s.env === null || typeof s.env !== "object" || Array.isArray(s.env)) {
        throw new ConfigError(`config: agents.${name}.env must be an object of strings`);
      }
      for (const val of Object.values(s.env as Record<string, unknown>)) {
        if (typeof val !== "string") throw new ConfigError(`config: agents.${name}.env values must be strings`);
      }
      entry.env = s.env as Record<string, string>;
    }
    out[name] = entry;
  }
  return out;
}

/**
 * Load and resolve the node config. `configPath` defaults to
 * `<dataDir>/config.json`; an absent file resolves to pure defaults.
 */
export function loadNodeConfig(dataDir: string, configPath?: string): ResolvedNodeConfig {
  const path = configPath ?? join(dataDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new ConfigError(`config: ${path} is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config: ${path} must contain a json object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const retryRaw =
    raw.retry === undefined
      ? {}
      : (() => {
          if (raw.retry === null || typeof raw.retry !== "object" || Array.isArray(raw.retry)) {
            throw new ConfigError("config: retry must be an object");
          }
          return raw.retry as Record<string, unknown>;
        })();

  const bootHangTimeoutMs = num(raw, "bootHangTimeoutMs", DEFAULTS.bootHangTimeoutMs);
  const turnHangTimeoutMs = num(raw, "turnHangTimeoutMs", DEFAULTS.turnHangTimeoutMs);
  const bootAllowanceMs = num(raw, "bootAllowanceMs", DEFAULTS.bootAllowanceMs);
  const turnAllowanceMs = num(raw, "turnAllowanceMs", DEFAULTS.turnAllowanceMs);
  // Behavior 5: the deadline is policy-aware — at least hang-timeout + boot +
  // turn allowances, so "late" is only ever counted past the system's own
  // legitimate recovery reach.
  const i1FloorMs = Math.max(bootHangTimeoutMs, turnHangTimeoutMs) + bootAllowanceMs + turnAllowanceMs;
  const i1DeadlineMs = Math.max(num(raw, "i1DeadlineMs", i1FloorMs), i1FloorMs);

  return {
    dataDir,
    configPath: path,
    idleWindowMs: num(raw, "idleWindowMs", DEFAULTS.idleWindowMs),
    bootHangTimeoutMs,
    turnHangTimeoutMs,
    bootAllowanceMs,
    turnAllowanceMs,
    i1DeadlineMs,
    i1FloorMs,
    tickMs: num(raw, "tickMs", DEFAULTS.tickMs),
    commandsPerTick: num(raw, "commandsPerTick", DEFAULTS.commandsPerTick),
    maxAttempts: num(retryRaw, "maxAttempts", DEFAULTS.maxAttempts),
    backoffBaseMs: num(retryRaw, "backoffBaseMs", DEFAULTS.backoffBaseMs),
    stopKillGraceMs: num(raw, "stopKillGraceMs", DEFAULTS.stopKillGraceMs),
    adoptToleranceMs: num(raw, "adoptToleranceMs", DEFAULTS.adoptToleranceMs),
    watchMaxBatch: num(raw, "watchMaxBatch", DEFAULTS.watchMaxBatch),
    socketPath: str(raw, "socketPath", join(dataDir, "hived.sock")),
    logPath: str(raw, "logPath", join(dataDir, "hived.log")),
    storePath: str(raw, "storePath", join(dataDir, "core.sqlite3")),
    telemetryPath: str(raw, "telemetryPath", join(dataDir, "telemetry.sqlite3")),
    sessionLogDir: str(raw, "sessionLogDir", join(dataDir, "session-logs")),
    agents: { ...BUILTIN_AGENTS, ...agentsOf(raw) },
  };
}
