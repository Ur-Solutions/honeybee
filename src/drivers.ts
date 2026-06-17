/**
 * IdentityRecipe describes how a provider's login materializes on disk so the
 * vault can capture credentials out of a home and activate them into another.
 *
 * Per the codex HOME stress report (stress-reports/codex-home-auth-bug-2026-05-17.md)
 * the recipe's extraEnv is explicit and opt-in: it is applied ONLY on identity
 * activation paths (spawn --account, swap-account, activate) and logged — never
 * as a blind global HOME rewrite on plain spawns.
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
   * credential file. Covers CLIs with more than one auth discovery path
   * (codex reads both $CODEX_HOME/auth.json and $HOME/.codex/auth.json).
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
};

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
  },
  codex: {
    kind: "codex",
    homeEnv: "CODEX_HOME",
    hasTranscriptProvider: true,
    isReady: (pane) => /(?:^|\n)[›>]\s/.test(pane) || /What can I help with|Ask Codex/i.test(pane),
    isActive: (pane) => /\b(?:Working|Starting MCP servers)\b[^\n]*(?:esc to interrupt|ctrl[-+ ]?c)/i.test(pane),
    identity: {
      credentialFiles: ["auth.json"],
      // Codex auth discovery also walks $HOME/.codex (stress report 2026-05-17),
      // so activation mirrors auth.json there and declares the explicit HOME.
      activationMirrors: { "auth.json": ".codex/auth.json" },
      configFiles: ["config.toml"],
      extraEnv: { HOME: "{home}" },
      seedLoginSeat: false,
    },
    isExhausted: (pane) => matchExhaustion(pane, /You've hit your usage limit|usage limit reached|rate limit reached/i),
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
    },
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
  },
  droid: {
    kind: "droid",
    isReady: (pane) => /TIP: Use \/settings|Welcome to Factory CLI/i.test(pane),
  },
};

export function agentDriver(kind: string): AgentDriver | undefined {
  return AGENT_DRIVERS[kind];
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
