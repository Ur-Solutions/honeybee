/**
 * Per-node daemon config (spec 04 behavior 7; Q1 resolution: json).
 *
 * One file per node: `<dataDir>/config.json`. Every value has a default and
 * the file may be absent. Unknown keys are ignored (forward compatibility);
 * malformed json or wrongly-typed values fail loudly — a half-read config is
 * worse than no config.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** How to spawn one agent CLI (keyed by the bee's `agent` field). */
export interface AgentSpecConfig {
  command: string;
  /** Base args — the harness plumbing (`-p --input-format stream-json …`). */
  args?: string[];
  /**
   * Node-wide per-agent DEFAULT args (e.g. `["--model", "opus"]`), layered
   * over `args` and under each bee's own `bees.args` at spawn (daemon
   * resolveSpawnSpec: args < defaultArgs < bee.args < resume args; a later
   * valued flag overrides an earlier one, boolean flags are idempotent).
   */
  defaultArgs?: string[];
  /** Adapter name: claude | codex | grok | stub. Defaults to the agent key itself. */
  adapter?: string;
  env?: Record<string, string>;
  /**
   * v7 (spec 08): the harness's own login invocation for `account.login`'s
   * seat (default = the recipe's: bare `claude`, `codex login`, …). Tests
   * point it at a fake login that writes the recipe file.
   */
  login?: { command: string; args?: string[] };
}

export const NAMING_TOOLS = ["codex", "claude"] as const;
export type NamingTool = (typeof NAMING_TOOLS)[number];

export const NAMING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type NamingEffort = (typeof NAMING_EFFORTS)[number];

/** Daemon auto-titler (untitled bees → semantic `title` from the mailbox). */
export interface NamingConfig {
  /** Default true. */
  auto?: boolean;
  /** Builtin generator CLI. Default "codex". */
  tool?: NamingTool;
  /** Model passed to the generator. Default "gpt-5.6-luna". */
  model?: string;
  /** Reasoning effort for the Codex generator. Default "medium". Ignored by Claude. */
  effort?: NamingEffort;
  /** Custom generator command (prompt on stdin, title on stdout). Overrides tool/model. */
  command?: string;
}

export interface ResolvedNamingConfig {
  auto: boolean;
  tool: NamingTool;
  model: string;
  effort: NamingEffort;
  command?: string;
  /** Dedicated cwd so title-gen sessions never pollute a bee's transcript folder. */
  generatorCwd: string;
}

export const NAMING_DEFAULTS = {
  auto: true,
  tool: "codex" as NamingTool,
  model: "gpt-5.6-luna",
  effort: "medium" as NamingEffort,
};

/** v7 (spec 08): accounts + vault settings. */
export interface AccountsConfig {
  /** Credential vault root (`<vault>/<harness>/<accountId>/`). Default ~/.hive/vault (the old layout, shared on purpose). */
  vaultDir?: string;
  /** Run-homes root (`<homes>/<accountId>`). Default ~/.hive/homes. */
  homesDir?: string;
  /** A limits row older than this is refreshed before an `auto` pick. Default 1h. */
  limitsStaleMs?: number;
  /** Periodic in-daemon limits refresh while running. Default 15 min; 0 disables. */
  limitsRefreshMs?: number;
  /** Per-fetch bound for a provider limits read. Default 15s. */
  limitsFetchTimeoutMs?: number;
  /** tmux socket name (`tmux -L <name>`) for login seats; absent = the default server. Tests use a private one. */
  tmuxSocket?: string;
  /** How long a login seat is watched for the credential change. Default 10 min. */
  loginTimeoutMs?: number;
  /** Rotation cool-off: an account with rate-limit exhaustion evidence younger than this is not rotated ONTO. Default 5h. */
  exhaustionCoolOffMs?: number;
}

/** Node kinds (core contract §1): decides the cell-sandbox default (A4). */
export type NodeKind = "workstation" | "satellite" | "cloud";

export const NODE_KINDS: readonly NodeKind[] = ["workstation", "satellite", "cloud"];

/** Cell substrate settings (WP5, spec 05) — deliberately minimal. */
export interface CellsConfig {
  /** Cells root directory. Default `<dataDir>/cells`. */
  root?: string;
  /** Node-wide sandbox override; absent = node-kind default (A4). */
  sandbox?: boolean;
  /** Per-repo warm-cell artifact dirs (A5, opt-in), keyed by origin repo path. */
  warm?: Record<string, string[]>;
}

/** The raw (all-optional) shape of config.json. */
export interface NodeConfigFile {
  /** Node kind (workstation | satellite | cloud). Default workstation. */
  nodeKind?: NodeKind;
  /** Cell substrate settings (WP5). */
  cells?: CellsConfig;
  /** Scale-to-zero idle window (behavior 3). Default 60 min; 0/negative disables. */
  idleWindowMs?: number;
  /** Hang policy: stop a runtime stuck in `booting` past this. */
  bootHangTimeoutMs?: number;
  /**
   * @deprecated Ignored. Running turns are unbounded; silence and elapsed
   * time are not failure evidence. Retained only so old config files remain
   * readable during the compatibility window.
   */
  turnHangTimeoutMs?: number;
  /** I1 deadline allowance for a replacement runtime to boot. */
  bootAllowanceMs?: number;
  /** I1 deadline allowance for a preceding turn to finish. */
  turnAllowanceMs?: number;
  /**
   * I1 delivery deadline per pending mailbox position (behavior 5). Clamped
   * UP to the policy-aware floor: boot timeout + boot + ordinary-turn
   * allowances. A breach records telemetry; it never stops a running turn.
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
  /** v7 (spec 08). */
  accounts?: AccountsConfig;
  /** Auto-titler. Default on, Codex GPT-5.6 Luna medium. */
  naming?: NamingConfig;
}

export interface ResolvedNodeConfig {
  dataDir: string;
  configPath: string;
  nodeKind: NodeKind;
  cellsRoot: string;
  /** Node-wide cell-sandbox override; null = node-kind default (A4). */
  cellSandbox: boolean | null;
  /** Per-repo warm-cell artifact dirs (A5). */
  cellWarm: Record<string, string[]>;
  idleWindowMs: number;
  bootHangTimeoutMs: number;
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
  /** v7 (spec 08): resolved accounts settings (every field defaulted). */
  accounts: Required<Omit<AccountsConfig, "tmuxSocket">> & { tmuxSocket: string | null };
  naming: ResolvedNamingConfig;
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
  grok: {
    command: "grok",
    args: ["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"],
    adapter: "grok",
  },
};

export const DEFAULTS = {
  idleWindowMs: 60 * 60 * 1000, // Q4 ruling: default 60 min
  bootHangTimeoutMs: 3 * 60 * 1000,
  bootAllowanceMs: 60 * 1000,
  turnAllowanceMs: 5 * 60 * 1000,
  tickMs: 200,
  commandsPerTick: 8,
  maxAttempts: 5,
  backoffBaseMs: 30_000,
  stopKillGraceMs: 5000,
  adoptToleranceMs: 5000,
  watchMaxBatch: 256,
  limitsStaleMs: 60 * 60 * 1000,
  limitsRefreshMs: 15 * 60 * 1000,
  limitsFetchTimeoutMs: 15_000,
  loginTimeoutMs: 10 * 60 * 1000,
  exhaustionCoolOffMs: 5 * 60 * 60 * 1000,
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

function nodeKindOf(raw: Record<string, unknown>): NodeKind {
  const v = raw.nodeKind;
  if (v === undefined) return "workstation";
  if (typeof v !== "string" || !(NODE_KINDS as readonly string[]).includes(v)) {
    throw new ConfigError(`config: nodeKind must be one of ${NODE_KINDS.join("|")}, got ${JSON.stringify(v)}`);
  }
  return v as NodeKind;
}

function cellsOf(raw: Record<string, unknown>): { root?: string; sandbox: boolean | null; warm: Record<string, string[]> } {
  const v = raw.cells;
  if (v === undefined) return { sandbox: null, warm: {} };
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new ConfigError("config: cells must be an object of {root?, sandbox?, warm?}");
  }
  const c = v as Record<string, unknown>;
  const out: { root?: string; sandbox: boolean | null; warm: Record<string, string[]> } = {
    sandbox: null,
    warm: {},
  };
  if (c.root !== undefined) {
    if (typeof c.root !== "string" || c.root.length === 0) {
      throw new ConfigError("config: cells.root must be a non-empty string");
    }
    out.root = c.root;
  }
  if (c.sandbox !== undefined) {
    if (typeof c.sandbox !== "boolean") throw new ConfigError("config: cells.sandbox must be a boolean");
    out.sandbox = c.sandbox;
  }
  if (c.warm !== undefined) {
    if (c.warm === null || typeof c.warm !== "object" || Array.isArray(c.warm)) {
      throw new ConfigError("config: cells.warm must be an object of {repoPath: [artifactDirs]}");
    }
    for (const [repo, dirs] of Object.entries(c.warm as Record<string, unknown>)) {
      if (!Array.isArray(dirs) || dirs.some((d) => typeof d !== "string" || d.length === 0)) {
        throw new ConfigError(`config: cells.warm['${repo}'] must be an array of non-empty strings`);
      }
      out.warm[repo] = dirs as string[];
    }
  }
  return out;
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
    if (s.defaultArgs !== undefined) {
      if (!Array.isArray(s.defaultArgs) || s.defaultArgs.some((a) => typeof a !== "string")) {
        throw new ConfigError(`config: agents.${name}.defaultArgs must be a string array`);
      }
      entry.defaultArgs = s.defaultArgs as string[];
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
    if (s.login !== undefined) {
      const l = s.login as Record<string, unknown> | null;
      if (l === null || typeof l !== "object" || Array.isArray(l) || typeof l.command !== "string" || l.command.length === 0) {
        throw new ConfigError(`config: agents.${name}.login must be an object {command, args?}`);
      }
      if (l.args !== undefined && (!Array.isArray(l.args) || l.args.some((a) => typeof a !== "string"))) {
        throw new ConfigError(`config: agents.${name}.login.args must be a string array`);
      }
      entry.login = { command: l.command, ...(l.args !== undefined ? { args: l.args as string[] } : {}) };
    }
    out[name] = entry;
  }
  return out;
}

export function namingOf(raw: Record<string, unknown>, dataDir: string): ResolvedNamingConfig {
  const v = raw.naming;
  if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
    throw new ConfigError("config: naming must be an object");
  }
  const n = (v ?? {}) as Record<string, unknown>;
  if (n.auto !== undefined && typeof n.auto !== "boolean") {
    throw new ConfigError("config: naming.auto must be a boolean");
  }
  if (n.tool !== undefined && (n.tool !== "codex" && n.tool !== "claude")) {
    throw new ConfigError('config: naming.tool must be "codex" or "claude"');
  }
  if (n.model !== undefined && (typeof n.model !== "string" || n.model.length === 0)) {
    throw new ConfigError("config: naming.model must be a non-empty string");
  }
  if (n.effort !== undefined && (typeof n.effort !== "string" || !(NAMING_EFFORTS as readonly string[]).includes(n.effort))) {
    throw new ConfigError(`config: naming.effort must be one of ${NAMING_EFFORTS.join("|")}`);
  }
  if (n.command !== undefined && (typeof n.command !== "string" || n.command.length === 0)) {
    throw new ConfigError("config: naming.command must be a non-empty string when given");
  }
  return {
    auto: n.auto !== false,
    tool: (n.tool as NamingTool | undefined) ?? NAMING_DEFAULTS.tool,
    model: (n.model as string | undefined) ?? NAMING_DEFAULTS.model,
    effort: (n.effort as NamingEffort | undefined) ?? NAMING_DEFAULTS.effort,
    ...(typeof n.command === "string" ? { command: n.command } : {}),
    generatorCwd: join(dataDir, "naming"),
  };
}

export function publicNamingConfig(naming: ResolvedNamingConfig): {
  auto: boolean;
  tool: NamingTool;
  model: string;
  effort: NamingEffort;
  command?: string;
} {
  return {
    auto: naming.auto,
    tool: naming.tool,
    model: naming.model,
    effort: naming.effort,
    ...(naming.command ? { command: naming.command } : {}),
  };
}

/**
 * Merge a naming patch into config.json and return the resolved naming.
 * Unknown top-level keys in the existing file are preserved.
 */
export function patchNamingConfig(configPath: string, dataDir: string, patch: NamingConfig): ResolvedNamingConfig {
  let raw: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new ConfigError(`config: ${configPath} is not valid json: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`config: ${configPath} must contain a json object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const current = (raw.naming && typeof raw.naming === "object" && !Array.isArray(raw.naming)
    ? (raw.naming as Record<string, unknown>)
    : {}) as NamingConfig;
  const next: NamingConfig = { ...current };
  if (patch.auto !== undefined) next.auto = patch.auto;
  if (patch.tool !== undefined) next.tool = patch.tool;
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.effort !== undefined) next.effort = patch.effort;
  if (patch.command !== undefined) {
    if (patch.command.length === 0) delete next.command;
    else next.command = patch.command;
  }
  raw.naming = next;
  const resolved = namingOf(raw, dataDir);
  const tmp = `${configPath}.${process.pid}.tmp`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  renameSync(tmp, configPath);
  return resolved;
}

function accountsOf(raw: Record<string, unknown>): ResolvedNodeConfig["accounts"] {
  const v = raw.accounts;
  if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) {
    throw new ConfigError("config: accounts must be an object");
  }
  const a = (v ?? {}) as Record<string, unknown>;
  const socket = a.tmuxSocket;
  if (socket !== undefined && (typeof socket !== "string" || socket.length === 0)) {
    throw new ConfigError("config: accounts.tmuxSocket must be a non-empty string when given");
  }
  return {
    vaultDir: str(a, "vaultDir", join(homedir(), ".hive", "vault")),
    homesDir: str(a, "homesDir", join(homedir(), ".hive", "homes")),
    limitsStaleMs: num(a, "limitsStaleMs", DEFAULTS.limitsStaleMs),
    limitsRefreshMs: num(a, "limitsRefreshMs", DEFAULTS.limitsRefreshMs),
    limitsFetchTimeoutMs: num(a, "limitsFetchTimeoutMs", DEFAULTS.limitsFetchTimeoutMs),
    loginTimeoutMs: num(a, "loginTimeoutMs", DEFAULTS.loginTimeoutMs),
    exhaustionCoolOffMs: num(a, "exhaustionCoolOffMs", DEFAULTS.exhaustionCoolOffMs),
    tmuxSocket: (socket as string | undefined) ?? null,
  };
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
  const bootAllowanceMs = num(raw, "bootAllowanceMs", DEFAULTS.bootAllowanceMs);
  const turnAllowanceMs = num(raw, "turnAllowanceMs", DEFAULTS.turnAllowanceMs);
  // Behavior 5: the deadline covers bounded system recovery plus ordinary
  // boot/turn allowances. It is observability, never a destructive watchdog:
  // a legitimate long-running turn may exceed it without being stopped.
  const i1FloorMs = bootHangTimeoutMs + bootAllowanceMs + turnAllowanceMs;
  const i1DeadlineMs = Math.max(num(raw, "i1DeadlineMs", i1FloorMs), i1FloorMs);

  const cells = cellsOf(raw);
  return {
    dataDir,
    configPath: path,
    nodeKind: nodeKindOf(raw),
    cellsRoot: cells.root ?? join(dataDir, "cells"),
    cellSandbox: cells.sandbox,
    cellWarm: cells.warm,
    idleWindowMs: num(raw, "idleWindowMs", DEFAULTS.idleWindowMs),
    bootHangTimeoutMs,
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
    accounts: accountsOf(raw),
    naming: namingOf(raw, dataDir),
  };
}
