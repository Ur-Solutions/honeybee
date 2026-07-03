import type { RunnerAdapter } from "./hsr/types.js";
import { claudeAdapter } from "./hsr/adapters/claude.js";
import { codexAdapter } from "./hsr/adapters/codex.js";

/**
 * IdentityRecipe describes how a provider's login materializes on disk so the
 * vault can capture credentials out of a home and activate them into another.
 *
 * Recipe env is explicit and opt-in: it is applied ONLY on identity activation
 * paths (spawn --account, swap-account, activate) and logged — never as a blind
 * global HOME rewrite on plain spawns.
 */
export type IdentityRecipe = {
  /**
   * Home-relative credential files; the same relative paths are used inside
   * the vault. The FIRST entry is the primary credential — an account without
   * it is not considered logged in (the rest are supporting snapshots).
   */
  credentialFiles: string[];
  /**
   * Extra home-relative copies written on activation, keyed by canonical
   * credential file. Covers CLIs with more than one auth discovery path.
   */
  activationMirrors?: Record<string, string>;
  /**
   * Non-credential, home-relative config files to preserve with an account.
   * These are copied when present, but they do not make an account "logged in"
   * and their absence must not block activation.
   */
  configFiles?: string[];
  /** Explicit extra env for activated spawns. "{home}" expands to the home path. */
  extraEnv?: Record<string, string>;
  /**
   * Whether a (re)login seat starts from the account's existing credentials.
   * Defaults to true: claude keeps its onboarding state and offers /login.
   * Set false for tools whose sign-in flow only triggers when the primary
   * credential is absent — codex with a seeded auth.json boots a normal
   * authenticated session, and its boot-time token refresh rewrites the file,
   * tripping the seat's mtime freshness check.
   */
  seedLoginSeat?: boolean;
};

export type ExhaustionHit = {
  /** Provider's reset hint when present (e.g. "resets at 7pm"), verbatim. */
  resetHint?: string;
};

export type AgentDriver = {
  kind: string;
  homeEnv?: string;
  hasTranscriptProvider?: boolean;
  isReady?: (pane: string) => boolean;
  isActive?: (pane: string) => boolean;
  identity?: IdentityRecipe;
  /** Detects the provider's rate-limit/exhaustion message on a pane. Fact, not judgment. */
  isExhausted?: (pane: string) => ExhaustionHit | null;
  /**
   * CLI-specific model selector args for a spawn. Single-provider CLIs take a
   * bare model (`--model <model>`); opencode multiplexes providers, so it needs
   * the qualified `<provider>/<model>` form. Returns [] when no model is given —
   * so a spawn without a model is byte-identical to today. CLIs whose model
   * flag is unverified (kimi/cursor/pi/droid) leave this undefined (no model
   * args yet; refined in S4).
   */
  modelArgs?: (model?: string, provider?: string) => string[];
  /**
   * Default boot-ready timeout (ms) for spawn/brief waits (the `--boot-ms`
   * fallback). Harness startup varies wildly (codex boots MCP servers, droid
   * is near-instant); undeclared kinds fall back to DEFAULT_BOOT_MS.
   */
  bootMs?: number;
  /**
   * Whether this harness runs permissionless ("yolo") by default. Policy:
   * EVERY harness defaults to yolo — hive bees are unattended, so an approval
   * prompt just strands them at a dialog — so entries leave this unset and a
   * future harness that must never run permissionless opts out with `false`.
   */
  defaultsToYolo?: boolean;
  /**
   * The `<tool>-auto` spawn alias forces yolo even over a thin-profile
   * `yolo: false` (an auto-picked account is a fleet spawn, always unattended).
   */
  autoAliasForcesYolo?: boolean;
  /**
   * Per-provider resume invocation. The id-less form falls back to "continue
   * the most recent session". Undefined → the harness has no resume flag and
   * a resume boots fresh (empty args).
   */
  resumeArgs?: (providerSessionId?: string) => string[];
  /**
   * Stable CLI flag that pins a FRESH spawn to a caller-chosen provider
   * session id (claude's `--session-id`). Undefined → no pinning; the
   * provider keeps cwd disambiguation for transcript matching.
   */
  sessionIdFlag?: string;
  /** HSR runner adapter (and thus runner tier) when the harness is HSR-capable. */
  hsrAdapter?: RunnerAdapter;
  /**
   * A bare `<tool>` spawn (no account/home/profile flags) defaults to the
   * sole credentialed account for the tool, when exactly one exists.
   */
  soleCredentialedAccountDefault?: boolean;
};

/** Boot-ready timeout for kinds without a declared `bootMs`. */
export const DEFAULT_BOOT_MS = 10_000;

// Rate-limit / exhaustion phrasing for the multi-provider coding CLIs
// (opencode/grok/kimi). A resolution verb must sit adjacent to the limit phrase
// — either before ("hit your usage limit") or after ("rate limit exceeded") —
// so benign mentions like "increase your usage limit" or "the speed limit is
// 60" never trip a false exhaustion. Refined against real panes in S4.
const RATE_LIMIT_EXHAUSTED =
  /(?:reached|hit|exceeded)\s+(?:your\s+)?(?:usage|rate)\s+limit|(?:usage|rate)\s+limit\s+(?:reached|hit|exceeded)|quota\s+(?:reached|exceeded)/i;

const AGENT_DRIVERS: Record<string, AgentDriver> = {
  claude: {
    kind: "claude",
    homeEnv: "CLAUDE_CONFIG_DIR",
    hasTranscriptProvider: true,
    isReady: (pane) => /(?:^|\n)❯\s/.test(pane) || /Try "fix lint errors"|Try "create a util/i.test(pane),
    identity: {
      // With CLAUDE_CONFIG_DIR set, all three live inside the config dir.
      credentialFiles: [".credentials.json", ".claude.json", "settings.json"],
    },
    isExhausted: (pane) => matchExhaustion(pane, /(?:usage|5-hour|weekly) limit reached|You've reached your usage limit/i),
    modelArgs: (model) => (model ? ["--model", model] : []),
    bootMs: 15_000,
    resumeArgs: (sid) => (sid ? ["--resume", sid] : ["--continue"]),
    sessionIdFlag: "--session-id",
    hsrAdapter: claudeAdapter,
  },
  codex: {
    kind: "codex",
    homeEnv: "CODEX_HOME",
    hasTranscriptProvider: true,
    isReady: (pane) => /(?:^|\n)[›>]\s/.test(pane) || /What can I help with|Ask Codex/i.test(pane),
    isActive: (pane) => /\b(?:Working|Starting MCP servers)\b[^\n]*(?:esc to interrupt|ctrl[-+ ]?c)/i.test(pane),
    identity: {
      credentialFiles: ["auth.json"],
      // Keep the legacy mirror for older Codex auth discovery, but do not set
      // HOME: developer tools inside Codex must see the user's real home.
      activationMirrors: { "auth.json": ".codex/auth.json" },
      configFiles: ["config.toml"],
      seedLoginSeat: false,
    },
    isExhausted: (pane) => matchExhaustion(pane, /You've hit your usage limit|usage limit reached|rate limit reached/i),
    modelArgs: (model) => (model ? ["--model", model] : []),
    bootMs: 30_000,
    autoAliasForcesYolo: true,
    resumeArgs: (sid) => (sid ? ["resume", sid] : ["resume", "--last"]),
    hsrAdapter: codexAdapter,
  },
  opencode: {
    kind: "opencode",
    homeEnv: "OPENCODE_CONFIG_DIR",
    hasTranscriptProvider: true,
    isReady: (pane) => /Ask anything/i.test(pane),
    identity: {
      // opencode keeps auth under $XDG_DATA_HOME/opencode/auth.json; the
      // activated home carries a private xdg-data/ subtree for it.
      credentialFiles: ["xdg-data/opencode/auth.json"],
      extraEnv: { XDG_DATA_HOME: "{home}/xdg-data" },
    },
    // opencode multiplexes providers in one binary, so the model selector must
    // name the provider: `--model <provider>/<model>`. Both halves are required
    // — a provider-less account yields no selector (falls back to opencode's
    // config default) rather than the malformed `--model undefined/<model>`.
    modelArgs: (model, provider) => (model && provider ? ["--model", `${provider}/${model}`] : []),
    // opencode surfaces several providers' limit messages; the shared
    // verb-anchored matcher keeps it narrow to avoid false positives.
    isExhausted: (pane) => matchExhaustion(pane, RATE_LIMIT_EXHAUSTED),
    bootMs: 15_000,
    resumeArgs: (sid) => (sid ? ["--session", sid] : ["--continue"]),
  },
  grok: {
    kind: "grok",
    homeEnv: "GROK_HOME",
    hasTranscriptProvider: true,
    isReady: (pane) => /Grok Build|(?:^|\n)\s*❯\s/.test(pane),
    // grok relocates its entire config dir (auth.json, sessions, agent_id) when
    // GROK_HOME is set, so numbered slots and per-account homes work like codex.
    // The OAuth credential lives at $GROK_HOME/auth.json.
    identity: {
      credentialFiles: ["auth.json"],
      configFiles: ["config.toml"],
    },
    isExhausted: (pane) => matchExhaustion(pane, RATE_LIMIT_EXHAUSTED),
    modelArgs: (model) => (model ? ["--model", model] : []),
    bootMs: 10_000,
    soleCredentialedAccountDefault: true,
  },
  kimi: {
    kind: "kimi",
    homeEnv: "KIMI_CODE_HOME",
    // kimi-code keeps its sessions in a private store with no honeybee
    // transcript provider yet, so auto-titling stays off until one exists.
    isReady: (pane) => /context:\s*\d+(?:\.\d+)?%/i.test(pane) || /Next-Gen Agents|\bCode (?:thinking|planning)\b/i.test(pane),
    identity: {
      // KIMI_CODE_HOME relocates the whole dir; the OAuth token lives under it.
      credentialFiles: ["credentials/kimi-code.json"],
    },
    isExhausted: (pane) => matchExhaustion(pane, RATE_LIMIT_EXHAUSTED),
  },
  cursor: {
    kind: "cursor",
    homeEnv: "CURSOR_CONFIG_DIR",
    isReady: (pane) => /(?:^|\n)\s*[❯>]\s/.test(pane) || /Cursor Agent/i.test(pane),
    identity: {
      credentialFiles: ["cli-config.json"],
    },
  },
  pi: {
    kind: "pi",
    isReady: (pane) => /Pi can explain its own features|(?:^|\n)>\s/.test(pane),
    bootMs: 10_000,
  },
  droid: {
    kind: "droid",
    isReady: (pane) => /TIP: Use \/settings|Welcome to Factory CLI/i.test(pane),
    bootMs: 5_000,
  },
};

export function agentDriver(kind: string): AgentDriver | undefined {
  return AGENT_DRIVERS[kind];
}

/**
 * Canonical agent kinds in a human-friendly display order (most-used first).
 * Drives the type column of the interactive `hive new` spawn picker; any driver
 * added to AGENT_DRIVERS but missing from the order list still appears, after
 * the curated ones, so the picker never silently drops a tool.
 */
export function agentKinds(): string[] {
  const order = ["claude", "codex", "kimi", "grok", "opencode", "cursor", "droid", "pi"];
  const known = Object.keys(AGENT_DRIVERS);
  const ranked = order.filter((kind) => kind in AGENT_DRIVERS);
  const rest = known.filter((kind) => !ranked.includes(kind));
  return [...ranked, ...rest];
}

export function hasAgentDriver(kind: string): boolean {
  return agentDriver(kind) !== undefined;
}

export function homeEnvForAgent(kind: string): string | undefined {
  return agentDriver(kind)?.homeEnv;
}

export function hasTranscriptProvider(kind: string): boolean {
  return agentDriver(kind)?.hasTranscriptProvider === true;
}

export function isDriverReady(kind: string, pane: string): boolean {
  return (agentDriver(kind)?.isReady ?? genericReadyCheck)(pane);
}

export function isDriverActive(kind: string, pane: string): boolean {
  return (agentDriver(kind)?.isActive ?? genericActiveCheck)(pane);
}

export function identityRecipeForAgent(kind: string): IdentityRecipe | undefined {
  return agentDriver(kind)?.identity;
}

/**
 * Explicit identity env for an activated home: the recipe's extraEnv with
 * "{home}" expanded. Returns {} for drivers without extras. Callers merge this
 * into the spawn env ONLY on identity-activation paths and log the result.
 */
export function identityEnvForAgent(kind: string, homePath: string): Record<string, string> {
  const extra = agentDriver(kind)?.identity?.extraEnv;
  if (!extra) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(extra)) {
    out[key] = value.replaceAll("{home}", homePath);
  }
  return out;
}

export function exhaustionForAgent(kind: string, pane: string): ExhaustionHit | null {
  return agentDriver(kind)?.isExhausted?.(pane) ?? null;
}

/**
 * The CLI's model selector args for a spawn, or [] when the driver has no
 * model hook or no model was requested. Drivers without a `modelArgs` hook
 * (kimi/cursor/pi/droid) always yield [] — byte-identical to a spawn with no
 * model.
 */
export function modelArgsForAgent(kind: string, model?: string, provider?: string): string[] {
  return agentDriver(kind)?.modelArgs?.(model, provider) ?? [];
}

/** Boot-ready timeout (ms) for spawn/brief waits; undeclared kinds get DEFAULT_BOOT_MS. */
export function bootMsForAgent(kind: string): number {
  return agentDriver(kind)?.bootMs ?? DEFAULT_BOOT_MS;
}

/**
 * Whether this canonical kind runs permissionless ("yolo") by default. The
 * policy default is yes for every harness — including unknown kinds — so this
 * only returns false for a driver that explicitly opts out.
 */
export function driverDefaultsToYolo(kind: string): boolean {
  return agentDriver(kind)?.defaultsToYolo ?? true;
}

/** Whether the `<tool>-auto` spawn alias forces yolo for this tool. */
export function autoAliasForcesYolo(kind: string): boolean {
  return agentDriver(kind)?.autoAliasForcesYolo === true;
}

/**
 * Per-provider resume invocation, or [] when the driver has no resume hook
 * (the resumed spawn just boots fresh). The id-less form continues the most
 * recent session.
 */
export function resumeArgsForAgent(kind: string, providerSessionId?: string): string[] {
  return agentDriver(kind)?.resumeArgs?.(providerSessionId) ?? [];
}

/**
 * Args that pin a FRESH spawn to a caller-chosen provider session id, or null
 * for drivers with no stable session-id flag (they keep cwd disambiguation).
 */
export function forcedSessionIdArgsForAgent(kind: string, sessionId: string): string[] | null {
  const pin = agentDriver(kind)?.sessionIdFlag;
  return pin ? [pin, sessionId] : null;
}

/**
 * Whether an arg list already carries the driver's session-pin flag (the
 * caller chose its own provider session id, so auto-pinning must not add a
 * second one). Always false for drivers without a sessionIdFlag.
 */
export function sessionPinnedInArgs(kind: string, args: readonly string[]): boolean {
  const pin = agentDriver(kind)?.sessionIdFlag;
  return pin !== undefined && args.includes(pin);
}

/** The HSR runner adapter for a canonical kind, or undefined when not HSR-capable. */
export function hsrAdapterForAgent(kind: string): RunnerAdapter | undefined {
  return agentDriver(kind)?.hsrAdapter;
}

/** Whether a bare `<tool>` spawn defaults to the tool's sole credentialed account. */
export function defaultsToSoleCredentialedAccount(kind: string): boolean {
  return agentDriver(kind)?.soleCredentialedAccountDefault === true;
}

// Shared matcher: provider limit message + a best-effort verbatim reset hint
// ("resets at 7pm", "try again in 2 hours"). The hint is a fact surfaced as-is.
function matchExhaustion(pane: string, pattern: RegExp): ExhaustionHit | null {
  if (!pattern.test(pane)) return null;
  const hint = pane.match(/\b(?:resets?|try again)\s+(?:at|in|on|after)?\s*([^\n•∙|]{1,60})/i);
  const resetHint = hint?.[0]?.trim();
  return resetHint ? { resetHint } : {};
}

function genericReadyCheck(pane: string): boolean {
  return /(?:^|\n)[❯›>]\s/.test(pane);
}

function genericActiveCheck(pane: string): boolean {
  return /\b(?:Working|Thinking|Running|Processing)\b[^\n]*(?:esc to interrupt|ctrl[-+ ]?c)/i.test(pane);
}
