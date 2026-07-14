import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { activateAccountIntoHome, assertCursorHomeAuthFresh, assertGrokHomeAuthFresh, autoAccountTool, defaultHomeForAccount, resolveSpawnAgent, roundRobinAccountTool, type AccountRecord } from "./accounts.js";
import { beeConfig } from "./config.js";
import { driverDefaultsToYolo, forcedSessionIdArgsForAgent, homeEnvForAgent, identityEnvForAgent, modelArgsForAgent, secretEnvKeysForAgent, sessionPinnedInArgs } from "./drivers.js";
import { assertExecutableAvailable } from "./execCheck.js";
import { writeSpawnOptions } from "./hiveState.js";
import { allocateBeeIdentity } from "./ids.js";
import { LOCAL_NODE_NAME, type NodeRecord } from "./node.js";
import { safeName, saveSession, type SessionRecord } from "./store.js";
import { resolveSpawningBeeId } from "./spawnParent.js";
import { localSubstrate, substrateForRecord } from "./substrates/index.js";
import type { TmuxWindowOptions } from "./substrates/index.js";

export type AgentKind = "claude" | "codex" | "opencode" | "grok" | "pi" | "droid" | string;

export type AgentSpec = {
  kind: AgentKind;
  command: string;
  args: string[];
  env: Record<string, string>;
  tmuxOptions?: TmuxWindowOptions;
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
  // opencode >=1.17 requires a message for `run` (even with -i), so a bare
  // `run --interactive` spawn dies instantly. `--mini` is the root-command
  // equivalent of the split-footer interactive mode and starts empty.
  opencode: "opencode --mini",
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
  opencode: "opencode --mini --auto",
  grok: "grok --permission-mode bypassPermissions --always-approve --tools= --disable-web-search --no-subagents",
  kimi: "kimi --yolo",
  pi: "pi",
  // Droid interactive TUI has no --auto/--skip-permissions startup flag, but --settings can seed Auto (High).
  droid: `droid --settings ${DROID_YOLO_SETTINGS_PATH}`,
  cursor: "cursor-agent --force",
};

// Map a requested bee kind (including auth-profile aliases like cc3/codex2) to
// its canonical agent kind. Unknown/arbitrary kinds pass through unchanged.
export function canonicalAgentKind(kind: string): string {
  return profileAlias(kind)?.kind ?? kind;
}

// Whether this bee kind should run permissionless ("yolo"/bypass) by default.
// The default lives on the driver registry (AGENT_DRIVERS.defaultsToYolo);
// current policy is yes for every harness — hive bees are unattended, so a
// permission/approval prompt just strands them at a dialog. Opt out per spawn
// with `--no-yolo`, or persistently with `hive config set-bee <bee> --no-yolo`;
// both are honored by dangerousMode in cli.ts. resolveAgent stays policy-free:
// it only emits the yolo command when the CLI layer (which applies this
// default and the opt-outs) tells it to.
export function agentDefaultsToYolo(kind: string): boolean {
  return driverDefaultsToYolo(canonicalAgentKind(kind));
}

export function tmuxOptionsForAgent(kind: string): TmuxWindowOptions | undefined {
  // OpenCode's interactive TUI can leak terminal palette-query replies through
  // tmux passthrough as literal `rgb:...` text on attach. Keep passthrough
  // disabled for its bee windows even if the user's global tmux config enables it.
  return canonicalAgentKind(kind).toLowerCase() === "opencode" ? { "allow-passthrough": "off" } : undefined;
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
  /**
   * Account default model to embed as a CLI model selector (`--model …`).
   * Threaded from the spawn account. Undefined for plain spawns → no model
   * args → byte-identical command.
   */
  model?: string;
  /**
   * Provider for the model selector. opencode needs it to build
   * `--model <provider>/<model>`; single-provider CLIs ignore it.
   */
  provider?: string;
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
  // With yolo now the default for every kind, a harness that has a base command
  // but no curated YOLO_COMMANDS entry must fall back to its DEFAULT_COMMANDS
  // (its normal args) rather than collapsing to the bare binary.
  const configured = commandOverride ?? (yolo ? (YOLO_COMMANDS[profile.kind] ?? DEFAULT_COMMANDS[profile.kind]) : DEFAULT_COMMANDS[profile.kind]) ?? profile.kind;
  if (profile.kind === "droid" && yolo && commandOverride === undefined) ensureDroidYoloSettings();
  const parts = splitShellWords(configured).map(expandTildeWord);
  if (parts.length === 0) throw new Error(`Empty command for agent ${profile.kind}`);
  const env: Record<string, string> = profile.homePath && profile.homeEnv ? { [profile.homeEnv]: profile.homePath } : {};
  if (options.identity && profile.homePath) {
    Object.assign(env, identityEnvForAgent(profile.kind, profile.homePath));
  }
  // The account's model selector is appended ONLY when the base command came
  // from the driver default — never when a config/env `command` override is in
  // play, since such a command may already embed `--model …` and appending
  // again would double the flag (adversarial review fix #5). When model is
  // undefined the hook returns [] → byte-identical to today.
  const modelArgs = commandOverride === undefined ? modelArgsForAgent(profile.kind, options.model, options.provider) : [];
  const tmuxOptions = tmuxOptionsForAgent(profile.kind);
  return {
    kind: profile.kind,
    command: parts[0]!,
    args: [...parts.slice(1), ...modelArgs, ...extraArgs],
    env,
    ...(tmuxOptions ? { tmuxOptions } : {}),
    homePath: profile.homePath,
    requestedKind: kind,
  };
}

/**
 * Render the spec as a one-line shell command. By default env values the
 * driver marks secret (cursor's CURSOR_AUTH_TOKEN/CURSOR_API_KEY) are
 * REDACTED — the default rendering feeds stored SessionRecords and `hive ls`
 * display, where a raw token would leak into state files and screenshares.
 * Pass `forExec: true` only where the string is actually executed or handed
 * to the user to run (`hive open --window/--print`).
 */
export function shellCommand(spec: AgentSpec, options: { forExec?: boolean } = {}): string {
  const secrets = options.forExec ? new Set<string>() : new Set(secretEnvKeysForAgent(spec.kind));
  const env = Object.entries(spec.env).map(([key, value]) => `${key}=${secrets.has(key) ? "<redacted>" : shellQuoteIfNeeded(value)}`);
  return [...env, ...[spec.command, ...spec.args].map(shellQuoteIfNeeded)].join(" ");
}

/**
 * Re-merge the driver's identity env AFTER credentials were activated into the
 * home. resolveAgent computes identity env before activateAccountIntoHome
 * runs; a recipe with a dynamic credentialEnv (cursor) reads the home's
 * credential file, which only holds the account's fresh secret once activation
 * has stamped it. Idempotent, and a no-op for static-env recipes or spawns
 * without a home.
 */
export function refreshIdentityEnv(spec: AgentSpec): void {
  if (!spec.homePath) return;
  Object.assign(spec.env, identityEnvForAgent(spec.kind, spec.homePath));
}

/**
 * Make an env-inherited harness home explicit on the spec. An HSR runner host
 * is a detached child of this CLI process, so a bee spawned without an
 * explicit home still runs under whatever home env var this process carries
 * (e.g. CLAUDE_CONFIG_DIR when `hive spawn` is run from inside another bee's
 * session) — invisibly: the record showed homePath unset, so `hive ls`, the
 * transcript matcher, and daemon host respawns all assumed the default home.
 * That mismatch made every transcript lookup scan the wrong project folder,
 * which is how sibling bees mass-adopted one fresh transcript's identity.
 * Stamping the inherited value into spec.env/homePath changes nothing about
 * what the child process sees; it only records reality and pins it across
 * respawns. No-op for explicit homes, homeless drivers, or a clean env.
 */
export function adoptInheritedHome(spec: AgentSpec): void {
  if (spec.homePath) return;
  const homeEnv = homeEnvForAgent(spec.kind);
  const inherited = homeEnv ? process.env[homeEnv] : undefined;
  if (!homeEnv || !inherited) return;
  spec.homePath = inherited;
  spec.env[homeEnv] = inherited;
}

export async function assertAgentAuthFreshForSpawn(spec: AgentSpec, accountId?: string): Promise<void> {
  if (spec.kind === "grok") {
    const homePath = spec.homePath ?? process.env.GROK_HOME ?? resolve(homedir(), ".grok");
    await assertGrokHomeAuthFresh(homePath, accountId ? { accountId } : {});
    return;
  }
  if (spec.kind === "cursor" && spec.homePath) {
    // Only a PRESENT home auth.json is judged: a plain --home spawn without
    // one legitimately rides the machine-global cursor login.
    await assertCursorHomeAuthFresh(spec.homePath, accountId ? { accountId } : {});
  }
}

/**
 * Args that pin a FRESH spawn to a caller-chosen provider session id, so the
 * bee is anchored to its own transcript from birth. The transcript matcher is
 * cwd-blind for claude (every claude transcript already lives in the cwd-keyed
 * project folder), so sibling bees in one repo would otherwise cross-match on
 * mtime alone — mis-titling and mis-resuming each other. A forced session id
 * scores the bee's own file +1000, which no sibling can beat. Returns null for
 * providers with no stable session-id flag (they keep cwd disambiguation);
 * the flag itself lives on the driver registry (AGENT_DRIVERS.sessionIdFlag).
 */
export function forcedSessionIdArgs(kind: string, sessionId: string): string[] | null {
  return forcedSessionIdArgsForAgent(kind, sessionId);
}

export function hasSessionIdArg(args?: readonly string[]): boolean {
  return Boolean(args?.some((arg) => arg === "--session-id" || arg.startsWith("--session-id=")));
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

export function shellQuoteIfNeeded(value: string): string {
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
  /**
   * Pre-resolved account to bind (creds activated into a dedicated home, the
   * account's default model + provider applied). When omitted, `agent` is
   * resolved via resolveSpawnAgent so an account-id / `<tool>-<account>`
   * shorthand still binds — but `<tool>-auto` must be collapsed by the caller
   * first (the auto pick needs live provider limits, resolved at the CLI/flow
   * boundary, not here).
   */
  account?: AccountRecord;
  name?: string;
  colony?: string;
  swarmId?: string;
  caste?: string;
  brief?: string;
  /** Spawning bee's id for the fleet edge; auto-captured when unset. */
  spawnedById?: string;
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
  // Resolve the bee token to its driver kind + optional bound account, mirroring
  // the CLI spawn path (spawnBee) so flow/loop-spawned bees are account-bound
  // too. A pre-resolved opts.account wins; otherwise an account-id /
  // `<tool>-<account>` shorthand binds via resolveSpawnAgent. `<tool>-auto`
  // and `<tool>-rr` need a live pick (or cursor advance) and must be collapsed
  // upstream — guard against either reaching here so a stale alias never
  // silently spawns the wrong account.
  if (!opts.account && (autoAccountTool(opts.agent) || roundRobinAccountTool(opts.agent))) {
    throw new Error(`flow spawn got an unresolved auto/rr alias (${opts.agent}); collapse it to a concrete account before spawning`);
  }
  const resolved = opts.account ? { agent: opts.account.tool, account: opts.account } : await resolveSpawnAgent(opts.agent);
  const account = resolved.account;
  // An account-bound spawn gets a home (explicit or the account's dedicated
  // slot), the account's credentials activated into it, the driver's identity
  // env, and the account's default model — never a blind HOME rewrite.
  const home = account ? (opts.home ?? defaultHomeForAccount(account)) : opts.home;
  const spec = resolveAgent(resolved.agent, opts.extraArgs, {
    home,
    yolo: opts.yolo,
    identity: Boolean(account),
    ...(account?.model ? { model: account.model } : {}),
    ...(account?.provider ? { provider: account.provider } : {}),
  });
  if (account) {
    if (opts.node && opts.node.kind !== "local-tmux") throw new Error("account-bound flow spawns are local-only (the vault never leaves this machine)");
    if (!spec.homePath) throw new Error(`Agent ${spec.kind} has no home env; cannot bind account ${account.id}`);
    await activateAccountIntoHome(account, spec.homePath);
    refreshIdentityEnv(spec);
  }
  // Pin the bee to its own provider session id from birth (see forcedSessionIdArgs):
  // flow runs spawn many siblings in one cwd, the exact case the cwd-blind claude
  // transcript matcher would otherwise cross-match by mtime.
  let pinnedSessionId: string | undefined;
  if (!sessionPinnedInArgs(spec.kind, opts.extraArgs ?? [])) {
    const sid = randomUUID();
    const sessionArgs = forcedSessionIdArgs(spec.kind, sid);
    if (sessionArgs) {
      spec.args = [...spec.args, ...sessionArgs];
      pinnedSessionId = sid;
    }
  }
  const isRemote = Boolean(opts.node && opts.node.kind === "ssh-tmux");
  // Mirror cli.ts spawn: a typo'd agent command would otherwise become a tmux
  // session that dies instantly while leaving a "running" record behind.
  if (!isRemote) {
    await assertExecutableAvailable(spec.command);
    await assertAgentAuthFreshForSpawn(spec, account?.id);
  }
  const identity = await allocateBeeIdentity({ agent: spec.kind, requestedAgent: spec.requestedKind });
  const name = safeName(opts.name ?? identity.id);
  const tmuxTarget = safeTmuxTargetForFlow(name);
  const nodeName = opts.node?.name ?? LOCAL_NODE_NAME;
  const substrate = opts.node ? substrateForRecord(opts.node) : localSubstrate();
  if (await substrate.hasSession(tmuxTarget)) {
    throw new Error(`tmux session already exists${isRemote && opts.node ? ` on ${opts.node.name}` : ""}: ${tmuxTarget}`);
  }
  const launch = await substrate.newSession(tmuxTarget, opts.cwd, { command: spec.command, args: spec.args, env: spec.env, tmuxOptions: spec.tmuxOptions });
  const command = shellCommand(spec);

  const now = new Date().toISOString();
  const spawnedById = opts.spawnedById ?? (await resolveSpawningBeeId());
  const record: SessionRecord = {
    name,
    agent: spec.kind,
    cwd: opts.cwd,
    command,
    tmuxTarget,
    ...(launch.paneId ? { agentPaneId: launch.paneId } : {}),
    ...(launch.launcherPgid ? { launcherPgid: launch.launcherPgid } : {}),
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
    ...(account ? { accountId: account.id } : {}),
    ...(pinnedSessionId ? { providerSessionId: pinnedSessionId } : {}),
    ...(opts.colony ? { colony: opts.colony } : {}),
    ...(opts.swarmId ? { swarmId: opts.swarmId } : {}),
    ...(opts.caste ? { caste: opts.caste } : {}),
    ...(opts.brief ? { brief: opts.brief } : {}),
    ...(spawnedById ? { spawnedById } : {}),
    ...(nodeName !== LOCAL_NODE_NAME ? { node: nodeName } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.flowName ? { flowName: opts.flowName } : {}),
  };
  await saveSession(record);
  await writeSpawnOptions(record);
  return record;
}
