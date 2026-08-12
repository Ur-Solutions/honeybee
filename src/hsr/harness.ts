/**
 * HSR harness registry (HIVE-20).
 *
 * The SINGLE registration point for what HSR knows about a harness. Onboarding
 * a harness used to take shotgun edits across four modules — the adapterFor
 * switch, the ALLOWANCES table, remoteCreds' EPHEMERAL_POLICY, plus the
 * drivers.ts recipes — with no compile-time link between them, so a missed
 * table silently misbehaved. Now each harness registers ONE descriptor here:
 *
 *   - runner     — whether an HSR RunnerAdapter is implemented. The
 *                  RunnerHarness type is derived from this flag and
 *                  adapters/index.ts types its map with it, so flipping a
 *                  descriptor to `runner: true` without registering the
 *                  adapter (or vice versa) FAILS TO COMPILE.
 *   - allowance  — the per-(harness, authKind) policy rows (permitted tiers,
 *                  required flags, env scrub, downgrade fingerprints) served
 *                  by allowance.ts and consumed by the adapters.
 *   - ephemeral  — the remote-HSR ephemeral-credential delivery policy served
 *                  by remoteCreds.ts.
 *
 * The driver recipes (home env, identity/credential files) stay canonical in
 * src/drivers.ts — they predate HSR and are shared with the tmux substrate —
 * but validateHarnessRegistry() cross-checks them: a descriptor whose policies
 * NEED a home env or a primary credential file fails validation (enforced by
 * tests/hsr-harness-registry.test.ts) instead of silently misbehaving at spawn.
 *
 * The allowance data is versioned DATA, not code — the policy that keeps HSR
 * on the right side of each provider's rules (docs/HSR_EXPLORATION.md §2,
 * apiary substrates-research.md §2). Rows carry a policy note and a
 * last-verified date so they can be refreshed independently of releases.
 *
 * Pure data + lookups. This module must NOT import adapter code (the adapters
 * import these lookups — a descriptor→adapter import would be a cycle);
 * adapters/index.ts owns the harness→RunnerAdapter map.
 */

import type { RunnerTier } from "./types.js";

export const AUTH_KINDS = ["subscription", "api-key"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

/** The allowance policy for one `(harness, authKind)` pair. */
export type HarnessAllowancePolicy = {
  readonly permittedTiers: readonly RunnerTier[]; // best-first
  readonly requiredFlags: readonly string[]; // flags the adapter MUST include for this tier/auth
  readonly scrubEnv: readonly string[]; // env vars to delete from the spawn env (e.g. ANTHROPIC_API_KEY for claude subscription)
  readonly fingerprints: readonly string[]; // stderr/stdout substrings that force a tier downgrade (e.g. "--bare")
  readonly note: string; // policy note
  readonly since: string; // ISO date the row was last verified
};

/** Remote-HSR ephemeral credential delivery policy (see remoteCreds.ts). */
export type EphemeralCredentialPolicy = {
  /**
   * "mint-token"        — exec the genuine harness to mint a fresh short-lived
   *                        token, delivered via `tokenEnv` (claude setup-token).
   * "ship-primary-file" — ship the account's primary credential file verbatim
   *                        into the remote home (legacy codex flow).
   * "ship-access-token" — ship the codex auth.json with the REFRESH token
   *                        blanked (`refresh_token: ""`, field KEPT — codex
   *                        serde requires it present) and a fresh, long-lived
   *                        (~10-day) access token. The vault stays the sole
   *                        holder of the real refresh token, so fleet-wide
   *                        refresh-reuse detection can never invalidate the
   *                        grant. Central refresh keeps the vault token fresh.
   * "ship-refresh-blanked-file"
   *                     — ship the account's primary credential file with EVERY
   *                        OAuth refresh-token field blanked (`refresh_token`/
   *                        `refresh` → "", field kept), preserving the access
   *                        token / api key. Used by grok (auth.json, keyed by
   *                        issuer::client) and kimi (credentials/kimi-code.json,
   *                        flat). The vault stays the sole holder of every real
   *                        refresh token, so no two fleet bees present the same
   *                        one-time-use refresh token. An api-key-only file has
   *                        no refresh field and ships its key verbatim.
   * "ship-provider-file"
   *                     — opencode's auth.json multiplexes EVERY provider login
   *                        in one object keyed by providerID. Ship ONLY the
   *                        account's single `provider` entry (codex-style
   *                        single-provider), dropping every other provider's
   *                        credential, with the kept entry's OAuth refresh field
   *                        blanked. Never ships the whole multi-provider file.
   */
  readonly strategy:
    | "mint-token"
    | "ship-primary-file"
    | "ship-access-token"
    | "ship-refresh-blanked-file"
    | "ship-provider-file";
  /** For "mint-token": the env var the token is delivered as. */
  readonly tokenEnv?: string;
  /** Secret-free human note. */
  readonly note: string;
};

/** Everything HSR registers for one harness. */
export type HarnessDescriptor = {
  /**
   * true when src/hsr/adapters implements a RunnerAdapter for this harness.
   * Compile-time linked to the adapters/index.ts map via RunnerHarness.
   */
  readonly runner: boolean;
  /** Test-only harness (stub): exempt from the runner-needs-allowance rule. */
  readonly testOnly?: boolean;
  /** Per-authKind allowance policy. Absent = unmodeled (allowanceFor → undefined). */
  readonly allowance?: Readonly<Record<AuthKind, HarnessAllowancePolicy>>;
  /** Remote-HSR ephemeral credential delivery policy, when wired. */
  readonly ephemeral?: EphemeralCredentialPolicy;
  /** Explicit remote-HSR restriction when no defensible credential policy exists yet. */
  readonly remoteHsr?: "local-only";
};

// The claude stream-json flag set. Descriptive — these are the tokens the
// adapter appends for tier "stream"; shared by both auth kinds.
const CLAUDE_STREAM_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"] as const;

// The cursor turn-tier flag set. `--trust` pre-accepts the workspace-trust
// prompt (print-mode only flag) — a turn child is unattended, so the prompt
// would strand the turn; shared by both auth kinds.
const CURSOR_TURN_FLAGS = ["-p", "--output-format", "stream-json", "--trust"] as const;

const OPENCODE_SERVER_FLAGS = ["serve", "--hostname", "127.0.0.1", "--port", "0"] as const;

export const HARNESSES = {
  // A real child process, but not a real harness — test scaffolding only
  // (adapters/stub.ts). No allowance rows, no ephemeral credentials.
  stub: {
    runner: true,
    testOnly: true,
  },
  claude: {
    runner: true,
    allowance: {
      subscription: {
        permittedTiers: ["stream", "pty"],
        requiredFlags: CLAUDE_STREAM_FLAGS,
        // Footgun: in -p mode a present ANTHROPIC_API_KEY is silently billed
        // (documented $1,800-bill incidents). Scrub it on subscription spawns.
        scrubEnv: ["ANTHROPIC_API_KEY"],
        // If a future release makes --bare the -p default, headless subscription
        // OAuth is refused → force stream→pty. See the 2026 policy timeline.
        fingerprints: ["--bare"],
        note: "Subscription -p/stream-json tolerated-to-supported (2026-07-02); Agent SDK credit split paused 2026-06-15; --bare-as-default would force PTY fallback.",
        since: "2026-07-02",
      },
      "api-key": {
        permittedTiers: ["stream", "pty"],
        requiredFlags: CLAUDE_STREAM_FLAGS,
        scrubEnv: [], // api billing is intentional
        fingerprints: ["--bare"],
        note: "API-key billing is intentional — no env scrub; same stream-json flags as subscription.",
        since: "2026-07-02",
      },
    },
    // Mint a fresh 1-year OAuth token with the REAL binary. If the binary is
    // absent / not logged in, fall back to shipping .credentials.json (weaker).
    ephemeral: {
      strategy: "mint-token",
      tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      note: "claude setup-token → CLAUDE_CODE_OAUTH_TOKEN",
    },
  },
  codex: {
    runner: true,
    allowance: {
      subscription: {
        permittedTiers: ["server", "turn", "pty"],
        requiredFlags: [], // app-server needs no extra flags
        scrubEnv: [],
        fingerprints: [],
        note: "codex exec/app-server on ChatGPT-plan sign-in officially supported.",
        since: "2026-07-02",
      },
      "api-key": {
        permittedTiers: ["server", "turn", "pty"],
        requiredFlags: [],
        scrubEnv: [],
        fingerprints: [],
        note: "codex exec/app-server; API-key sign-in equally supported.",
        since: "2026-07-02",
      },
    },
    // Ship a REFRESH-TOKEN-BLANKED auth.json into the remote CODEX_HOME: a fresh
    // ~10-day access token + `refresh_token: ""`. Shipping the full auth.json
    // (with the one-time-use refresh token) across a fleet trips provider
    // reuse-detection when two bees refresh the same token; blanking it keeps
    // the vault the sole holder of the real refresh token (research §2).
    ephemeral: {
      strategy: "ship-access-token",
      note: "ship access-token-only auth.json (refresh_token blanked) into remote CODEX_HOME",
    },
  },
  opencode: {
    runner: true,
    allowance: {
      subscription: {
        permittedTiers: ["server", "pty"],
        requiredFlags: OPENCODE_SERVER_FLAGS,
        scrubEnv: [],
        fingerprints: [],
        note: "OpenCode 1.17.18 serve REST/SSE with per-bee Basic auth; full permission/question endpoints and native session resume verified. Remote HSR delivers a single-provider-filtered auth.json (other providers dropped, OAuth refresh blanked) into the isolated XDG_DATA_HOME.",
        since: "2026-08-12",
      },
      "api-key": {
        permittedTiers: ["server", "pty"],
        requiredFlags: OPENCODE_SERVER_FLAGS,
        scrubEnv: [],
        fingerprints: [],
        note: "OpenCode 1.17.18 serve REST/SSE with intentional provider API-key billing and per-bee Basic auth. Remote HSR delivers a single-provider-filtered auth.json (the account's provider key only; every other provider dropped).",
        since: "2026-08-12",
      },
    },
    // opencode's auth.json is a multi-provider map (keyed by providerID). Ship
    // ONLY the account's own provider entry into the remote isolated home's
    // XDG_DATA_HOME (never the whole file), with any OAuth refresh token in that
    // entry blanked. An api-key provider (e.g. the glm coding plan) ships its
    // key verbatim — intentional provider billing, no rotating refresh to leak.
    ephemeral: {
      strategy: "ship-provider-file",
      note: "ship single-provider-filtered auth.json (refresh blanked) into remote OPENCODE XDG_DATA_HOME",
    },
  },
  cursor: {
    runner: true,
    // cursor's macOS credential store is a machine-global keychain slot that
    // per-bee credential delivery cannot satisfy (no home-relative auth file to
    // ship), so cursor stays local-only. Explicit here so a remote-hsr spawn is
    // rejected at the policy gate with a clear message, not late at minting.
    remoteHsr: "local-only",
    allowance: {
      subscription: {
        permittedTiers: ["turn", "pty"],
        requiredFlags: CURSOR_TURN_FLAGS,
        // No scrub: honeybee itself delivers the account identity via
        // CURSOR_AUTH_TOKEN/CURSOR_API_KEY (drivers.ts credentialEnv), so
        // deleting them here would strip the bound account's own credential.
        scrubEnv: [],
        fingerprints: [],
        note: "cursor-agent -p stream-json, process-per-turn with --resume=<chatId> continuation; envelope verified against the 2026.06.24 bundle.",
        since: "2026-07-03",
      },
      "api-key": {
        permittedTiers: ["turn", "pty"],
        requiredFlags: CURSOR_TURN_FLAGS,
        scrubEnv: [],
        fingerprints: [],
        note: "cursor-agent -p stream-json via CURSOR_API_KEY; API-key billing is intentional.",
        since: "2026-07-03",
      },
    },
    // No ephemeral policy: cursor's macOS credential store is a machine-global
    // keychain slot, so account-bound cursor bees stay local-only for now.
  },
  kimi: {
    runner: true,
    allowance: {
      subscription: {
        permittedTiers: ["stream", "pty"],
        requiredFlags: ["acp"],
        scrubEnv: [],
        fingerprints: [],
        note: "Kimi Code 0.27 ACP JSON-RPC over stdio, with model/mode applied through session config. Remote HSR ships credentials/kimi-code.json with the rotating refresh_token blanked into the isolated KIMI_CODE_HOME. NOTE: kimi access tokens are short-lived (~15 min); with the refresh token blanked a remote bee cannot self-refresh, so long runs may need a re-login.",
        since: "2026-08-12",
      },
      "api-key": {
        permittedTiers: ["stream", "pty"],
        requiredFlags: ["acp"],
        scrubEnv: [],
        fingerprints: [],
        note: "Kimi Code 0.27 ACP JSON-RPC over stdio. Remote HSR ships credentials/kimi-code.json with any refresh_token blanked; an api-key-only credential ships verbatim.",
        since: "2026-08-12",
      },
    },
    // kimi's credentials/kimi-code.json is a flat OAuth store whose refresh
    // token ROTATES on every grant (single-use) — shipping it whole across a
    // fleet trips reuse-detection. Blank the refresh token; the vault stays the
    // sole holder of the real one, exactly like codex.
    ephemeral: {
      strategy: "ship-refresh-blanked-file",
      note: "ship credentials/kimi-code.json (refresh_token blanked) into remote KIMI_CODE_HOME",
    },
  },
  grok: {
    runner: true,
    allowance: {
      subscription: {
        permittedTiers: ["stream", "pty"],
        requiredFlags: ["--no-auto-update", "agent", "--no-leader", "stdio"],
        // A subscription bee must never silently fall back to developer API
        // billing when its cached OAuth token is absent or expired.
        scrubEnv: ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY"],
        fingerprints: [],
        note: "Grok 0.2.102 native ACP stdio with cached-token authentication. Remote HSR ships auth.json with the OAuth refresh_token blanked into the isolated GROK_HOME; the adapter scrubs XAI_API_KEY so the delivered cached OAuth token (not API billing) is used.",
        since: "2026-08-12",
      },
      "api-key": {
        permittedTiers: ["stream", "pty"],
        requiredFlags: ["--no-auto-update", "agent", "--no-leader", "stdio"],
        scrubEnv: [],
        fingerprints: [],
        note: "Grok 0.2.102 ACP authenticates explicitly with xai.api_key and preserves XAI_API_KEY. Remote HSR ships auth.json with any refresh_token blanked; an api-key-only credential ships its key verbatim.",
        since: "2026-08-12",
      },
    },
    // grok's auth.json is keyed by issuer::client; each entry may carry an OAuth
    // refresh_token that grok uses to self-refresh. Blank it (codex-style) so
    // the vault stays the sole holder of the real refresh token; the delivered
    // `key`/`expires_at` are preserved and the adapter's XAI_API_KEY scrub keeps
    // a subscription bee on cached OAuth rather than developer API billing.
    ephemeral: {
      strategy: "ship-refresh-blanked-file",
      note: "ship auth.json (refresh_token blanked) into remote GROK_HOME",
    },
  },
  pi: {
    runner: false,
    allowance: {
      subscription: {
        permittedTiers: ["pty"],
        requiredFlags: [],
        scrubEnv: [],
        fingerprints: [],
        note: "no known structured mode; PTY only. unverified — refine in APIA-87/88.",
        since: "2026-07-02",
      },
      "api-key": {
        permittedTiers: ["pty"],
        requiredFlags: [],
        scrubEnv: [],
        fingerprints: [],
        note: "no known structured mode; PTY only. unverified — refine in APIA-87/88.",
        since: "2026-07-02",
      },
    },
  },
} as const satisfies Record<string, HarnessDescriptor>;

export type HarnessName = keyof typeof HARNESSES;

/**
 * The harnesses whose descriptor declares `runner: true`. adapters/index.ts
 * types its map `Record<RunnerHarness, RunnerAdapter>`, so this is the
 * compile-time link between the registry and the adapter registrations.
 */
export type RunnerHarness = {
  [K in HarnessName]: (typeof HARNESSES)[K] extends { readonly runner: true } ? K : never;
}[HarnessName];

// String-indexed view for runtime lookups by arbitrary harness names.
const REGISTRY: Readonly<Record<string, HarnessDescriptor>> = HARNESSES;

/** Registered harness names, in registration order. */
export function harnessNames(): string[] {
  return Object.keys(HARNESSES);
}

/** The full descriptor for a harness, or undefined if unregistered. */
export function harnessDescriptor(harness: string): HarnessDescriptor | undefined {
  return REGISTRY[harness];
}

/** The allowance policy for a `(harness, authKind)`, or undefined if unmodeled. */
export function harnessAllowance(harness: string, authKind: AuthKind): HarnessAllowancePolicy | undefined {
  return REGISTRY[harness]?.allowance?.[authKind];
}

/** The ephemeral-credential delivery policy for a harness, or undefined if unwired. */
export function ephemeralPolicyFor(harness: string): EphemeralCredentialPolicy | undefined {
  return REGISTRY[harness]?.ephemeral;
}

/** Harnesses with an ephemeral-credential policy, in registration order. */
export function ephemeralHarnesses(): string[] {
  return harnessNames().filter((name) => REGISTRY[name]?.ephemeral !== undefined);
}

/** Whether the harness may be started on a remote-HSR node. */
export function harnessSupportsRemoteHsr(harness: string): boolean {
  return REGISTRY[harness]?.remoteHsr !== "local-only";
}

/**
 * Cross-check every descriptor against the pieces it depends on but cannot
 * reference at compile time (the drivers.ts recipes, intra-descriptor
 * consistency). Returns human-readable problems; [] when the registry is
 * coherent. Enforced by tests/hsr-harness-registry.test.ts so a new harness
 * that misses a recipe fails CI instead of silently misbehaving at spawn.
 */
export async function validateHarnessRegistry(): Promise<string[]> {
  // Lazy import: drivers.ts registers adapters that import this module's
  // lookups, so a static drivers import here is a cycle (TDZ at load).
  const { hasAgentDriver, homeEnvForAgent, identityRecipeForAgent } = await import("../drivers.js");
  const problems: string[] = [];
  for (const name of harnessNames()) {
    const desc = REGISTRY[name]!;
    if (!desc.testOnly && !hasAgentDriver(name)) {
      problems.push(`${name}: registered as an HSR harness but src/drivers.ts has no AgentDriver for it`);
    }
    if (desc.runner && !desc.testOnly && !desc.allowance) {
      problems.push(`${name}: has a RunnerAdapter but no allowance policy — every real runner needs its tier/scrub rows`);
    }
    if (desc.ephemeral) {
      if (!homeEnvForAgent(name)) {
        problems.push(`${name}: has an ephemeral-credential policy but drivers.ts declares no homeEnv — credentials cannot be delivered into an isolated remote home`);
      }
      const recipe = identityRecipeForAgent(name);
      if (!recipe || recipe.credentialFiles.length === 0) {
        problems.push(`${name}: has an ephemeral-credential policy but drivers.ts declares no identity recipe / primary credential file to ship`);
      }
      if (desc.ephemeral.strategy === "mint-token" && !desc.ephemeral.tokenEnv) {
        problems.push(`${name}: mint-token ephemeral policy needs a tokenEnv to deliver the minted token`);
      }
    }
    for (const authKind of AUTH_KINDS) {
      const policy = desc.allowance?.[authKind];
      if (!policy) continue;
      if (policy.permittedTiers.length === 0) {
        problems.push(`${name}/${authKind}: allowance permits no tiers`);
      }
      if (policy.fingerprints.length > 0 && policy.permittedTiers.length < 2) {
        problems.push(`${name}/${authKind}: fingerprints imply a tier downgrade but there is no lower permitted tier`);
      }
    }
  }
  return problems;
}
