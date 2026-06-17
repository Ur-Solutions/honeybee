import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { beeConfig } from "./config.js";
import { homeEnvForAgent, identityEnvForAgent } from "./drivers.js";
import { assertExecutableAvailable } from "./execCheck.js";
import { allocateBeeIdentity } from "./ids.js";
import { LOCAL_NODE_NAME, type NodeRecord } from "./node.js";
import { safeName, saveSession, type SessionRecord } from "./store.js";
import { localSubstrate, substrateForRecord } from "./substrates/index.js";

export type AgentKind = "claude" | "codex" | "opencode" | "grok" | "pi" | "droid" | string;

export type AgentSpec = {
  kind: AgentKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  homePath?: string;
  requestedKind: string;
};

const DROID_YOLO_SETTINGS_PATH = resolve(homedir(), ".factory/hive-droid-yolo-settings.json");
const DROID_YOLO_SETTINGS = {
  autonomyMode: "auto-high",
  interactionMode: "auto",
};

const DEFAULT_COMMANDS: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode run --interactive",
  grok: "grok --tools= --disable-web-search --no-subagents",
  kimi: "kimi",
  // Pi's interactive CLI has no approval/yolo flag in --help; full tools are enabled by default.
  pi: "pi",
  droid: "droid",
  cursor: "cursor-agent",
};

const YOLO_COMMANDS: Record<string, string> = {
  claude: "claude --dangerously-skip-permissions",
  codex: "codex --dangerously-bypass-approvals-and-sandbox",
  opencode: "opencode run --interactive --dangerously-skip-permissions",
  grok: "grok --permission-mode bypassPermissions --always-approve --tools= --disable-web-search --no-subagents",
  kimi: "kimi --yolo",
  pi: "pi",
  // Droid interactive TUI has no --auto/--skip-permissions startup flag, but --settings can seed Auto (High).
  droid: `droid --settings ${DROID_YOLO_SETTINGS_PATH}`,
  cursor: "cursor-agent --force",
};

// Bees that run in full-permission ("yolo") mode by default. The default is
// applied by the CLI layer (dangerousMode in cli.ts) so resolveAgent stays
// policy-free: it only produces the yolo command when explicitly told to.
const DEFAULT_YOLO_AGENTS = new Set<string>(["claude"]);

// Map a requested bee kind (including auth-profile aliases like cc3/codex2) to
// its canonical agent kind. Unknown/arbitrary kinds pass through unchanged.
export function canonicalAgentKind(kind: string): string {
  return profileAlias(kind)?.kind ?? kind;
}

// Whether this bee kind should run permissionless unless explicitly opted out.
export function agentDefaultsToYolo(kind: string): boolean {
  return DEFAULT_YOLO_AGENTS.has(canonicalAgentKind(kind).toLowerCase());
}

export type ResolveAgentOptions = {
  home?: string | true | string[];
  // Authoritative when defined: `true`/`false` overrides env/config signals.
  // When omitted, yolo is decided from env/config.
  yolo?: boolean;
  /**
   * Identity-activation spawn: merge the driver's explicit IdentityRecipe env
   * into the spec env for the resolved home. Only account/swap/activate paths
   * set this — plain spawns never apply identity-only env.
   */
  identity?: boolean;
};

export function resolveAgent(kind: AgentKind, extraArgs: string[] = [], options: ResolveAgentOptions = {}): AgentSpec {
  const requestedCfg = beeConfig(String(kind));
  const profile = resolveProfile(kind, options.home ?? requestedCfg.home);
  const canonicalCfg = profile.kind !== kind ? beeConfig(profile.kind) : requestedCfg;
  // Per-profile env keys (HIVE_MINIMAX_CMD) win over the canonical kind's keys
  // (HIVE_OPENCODE_CMD) so aliased profiles override independently. For a plain
  // (non-aliased) kind both suffixes are identical, so the order is a no-op.
  const requestedSuffix = String(kind).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const canonicalSuffix = profile.kind.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const cmdEnv = (suffix: string) => process.env[`HIVE_${suffix}_CMD`] ?? process.env[`AP_${suffix}_CMD`];
  const yoloEnv = (suffix: string) => truthyEnv(process.env[`HIVE_${suffix}_YOLO`]);
  // The requested (profile) command wins over the canonical kind's command:
  // the whole point of a profile is its own command (e.g. model selection).
  const commandOverride = cmdEnv(requestedSuffix) ?? cmdEnv(canonicalSuffix) ?? requestedCfg.command ?? canonicalCfg.command;
  const yoloFallback =
    yoloEnv(requestedSuffix) ||
    yoloEnv(canonicalSuffix) ||
    truthyEnv(process.env.HIVE_YOLO) ||
    requestedCfg.yolo === true ||
    canonicalCfg.yolo === true;
  // A caller-supplied yolo decision (e.g. from the CLI's dangerousMode, which
  // applies per-agent defaults and opt-outs) is authoritative; only fall back
  // to env/config when the caller has no opinion.
  const yolo = options.yolo ?? yoloFallback;
  const configured = commandOverride ?? (yolo ? YOLO_COMMANDS[profile.kind] : DEFAULT_COMMANDS[profile.kind]) ?? profile.kind;
  if (profile.kind === "droid" && yolo && commandOverride === undefined) ensureDroidYoloSettings();
  const parts = splitShellWords(configured).map(expandTildeWord);
  if (parts.length === 0) throw new Error(`Empty command for agent ${profile.kind}`);
  const env: Record<string, string> = profile.homePath && profile.homeEnv ? { [profile.homeEnv]: profile.homePath } : {};
  if (options.identity && profile.homePath) {
    Object.assign(env, identityEnvForAgent(profile.kind, profile.homePath));
  }
  return {
    kind: profile.kind,
    command: parts[0]!,
    args: [...parts.slice(1), ...extraArgs],
    env,
    homePath: profile.homePath,
    requestedKind: kind,
  };
}

export function shellCommand(spec: AgentSpec): string {
  const env = Object.entries(spec.env).map(([key, value]) => `${key}=${shellQuoteIfNeeded(value)}`);
  return [...env, ...[spec.command, ...spec.args].map(shellQuoteIfNeeded)].join(" ");
}

function resolveProfile(kind: string, explicitHome: string | true | string[] | undefined) {
  const alias = profileAlias(kind);
  const canonicalKind = alias?.kind ?? kind;
  const homeEnv = homeEnvForAgent(canonicalKind);
  const selectedHome = typeof explicitHome === "string" ? explicitHome : alias?.home;
  const homePath = selectedHome && homeEnv ? resolveHome(canonicalKind, selectedHome) : undefined;
  return { kind: canonicalKind, homeEnv, homePath };
}

function profileAlias(kind: string): { kind: string; home?: string } | undefined {
  const normalized = kind.toLowerCase().replace(/[ _-]/g, "");
  const codex = normalized.match(/^codex([123])$/);
  if (codex) return { kind: "codex", home: codex[1]! };
  const claude = normalized.match(/^(?:cc|claude)([123])$/);
  if (claude) return { kind: "claude", home: claude[1]! };
  const grok = normalized.match(/^grok([123])$/);
  if (grok) return { kind: "grok", home: grok[1]! };
  // Config-declared alias: `bees.<name>.kind` names the canonical (driver) kind.
  // The home comes from the profile's own `home` config, not the alias.
  const configured = beeConfig(kind).kind;
  if (configured && configured !== kind) return { kind: configured };
  return undefined;
}

export function resolveHome(kind: string, value: string): string {
  const trimmed = value.trim();
  // Numeric slots map to the per-tool home convention (~/.claude-2, ~/.codex-1, ...).
  if (/^[1-9]$/.test(trimmed)) return resolve(homedir(), `.${kind}-${trimmed}`);
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed === "~") return homedir();
  return resolve(trimmed);
}

function ensureDroidYoloSettings(): void {
  mkdirSync(dirname(DROID_YOLO_SETTINGS_PATH), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(DROID_YOLO_SETTINGS_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(DROID_YOLO_SETTINGS_PATH, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch {
      const backupPath = `${DROID_YOLO_SETTINGS_PATH}.invalid-${Date.now()}`;
      renameSync(DROID_YOLO_SETTINGS_PATH, backupPath);
    }
  }

  const next = { ...existing, ...DROID_YOLO_SETTINGS };
  if (JSON.stringify(existing) === JSON.stringify(next)) return;
  writeFileSync(DROID_YOLO_SETTINGS_PATH, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Small shell-ish splitter for env command overrides. Not a full shell parser;
// enough for quoted binary paths/flags without executing arbitrary expansion.
export function splitShellWords(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && quote === null) {
      quote = ch;
      continue;
    }
    if (ch === quote) {
      quote = null;
      continue;
    }
    if (/\s/.test(ch) && quote === null) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error(`Unclosed quote in command: ${input}`);
  if (escaping) current += "\\";
  if (current) out.push(current);
  return out;
}

function expandTildeWord(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

// ──────────────────────────────────────────────────────────────────────────
// spawnBeeForFlow — pure SessionRecord-returning spawn used by the flow
// runtime. No printing, no I/O outside substrate+store.
// ──────────────────────────────────────────────────────────────────────────

export type SpawnBeeOptions = {
  agent: string;
  extraArgs: string[];
  cwd: string;
  yolo: boolean;
  home?: string | true | string[];
  name?: string;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  node?: NodeRecord;
  runId?: string;
  flowName?: string;
};

function safeTmuxTargetForFlow(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Spawn a bee in a tmux session and persist its SessionRecord. No printing,
 * no CLI side-effects. Used by HiveFacade to keep flow runs side-effect free.
 *
 * Mirrors the spawn logic in src/cli.ts but tagged with runId+flowName so
 * the run aggregator can later inventory which bees were spawned by which
 * flow run.
 */
export async function spawnBeeForFlow(opts: SpawnBeeOptions): Promise<SessionRecord> {
  const spec = resolveAgent(opts.agent, opts.extraArgs, { home: opts.home, yolo: opts.yolo });
  const isRemote = Boolean(opts.node && opts.node.kind === "ssh-tmux");
  // Mirror cli.ts spawn: a typo'd agent command would otherwise become a tmux
  // session that dies instantly while leaving a "running" record behind.
  if (!isRemote) await assertExecutableAvailable(spec.command);
  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(opts.name ?? identity.id);
  const tmuxTarget = safeTmuxTargetForFlow(name);
  const nodeName = opts.node?.name ?? LOCAL_NODE_NAME;
  const substrate = opts.node ? substrateForRecord(opts.node) : localSubstrate();
  if (await substrate.hasSession(tmuxTarget)) {
    throw new Error(`tmux session already exists${isRemote && opts.node ? ` on ${opts.node.name}` : ""}: ${tmuxTarget}`);
  }
  const { paneId } = await substrate.newSession(tmuxTarget, opts.cwd, { command: spec.command, args: spec.args, env: spec.env });
  const command = shellCommand(spec);

  const now = new Date().toISOString();
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd: opts.cwd,
    command,
    tmuxTarget,
    ...(paneId ? { agentPaneId: paneId } : {}),
    // Solo combs: every bee gets combId == tmuxTarget at spawn (§12 Q3).
    combId: tmuxTarget,
    createdAt: now,
    updatedAt: now,
    status: "running",
    id: identity.id,
    prefix: identity.prefix,
    uuid: identity.uuid,
    requestedAgent: spec.requestedKind,
    ...(spec.homePath ? { homePath: spec.homePath } : {}),
    ...(opts.colony ? { colony: opts.colony } : {}),
    ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
    ...(opts.caste ? { caste: opts.caste } : {}),
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.flowName ? { flowName: opts.flowName } : {}),
  };
  await saveSession(record);
  return record;
}
