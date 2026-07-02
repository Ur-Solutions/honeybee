/**
 * HSR allowance registry v1 (APIA-77).
 *
 * Versioned DATA, not code — the policy table that keeps HSR on the right side
 * of each provider's rules (docs/HSR_EXPLORATION.md §2, apiary
 * substrates-research.md §2). Each row models one `(harness, authKind)` pair:
 * which runner tiers are permitted (best-first), which flags the adapter must
 * append, which env vars to scrub from the spawn env, and which stderr/stdout
 * fingerprints force a tier downgrade. Rows carry a policy note and a
 * last-verified date so the table can be refreshed independently of releases.
 *
 * This is pure data + lookups; no process spawning, no wiring.
 */

import type { RunnerTier } from "./types.js";

/** One policy row for a `(harness, authKind)` pair. */
export type AllowanceRow = {
  harness: string;
  authKind: "subscription" | "api-key";
  permittedTiers: RunnerTier[]; // best-first
  requiredFlags: string[]; // flags the adapter MUST include for this tier/auth
  scrubEnv: string[]; // env vars to delete from the spawn env (e.g. ANTHROPIC_API_KEY for claude subscription)
  fingerprints: string[]; // stderr/stdout substrings that force a tier downgrade (e.g. "--bare")
  note: string; // policy note
  since: string; // ISO date the row was last verified
};

// The claude stream-json flag set. Descriptive — these are the tokens the
// adapter appends for tier "stream"; shared by both auth kinds.
const CLAUDE_STREAM_FLAGS = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];

const ALLOWANCES: AllowanceRow[] = [
  {
    harness: "claude",
    authKind: "subscription",
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
  {
    harness: "claude",
    authKind: "api-key",
    permittedTiers: ["stream", "pty"],
    requiredFlags: CLAUDE_STREAM_FLAGS,
    scrubEnv: [], // api billing is intentional
    fingerprints: ["--bare"],
    note: "API-key billing is intentional — no env scrub; same stream-json flags as subscription.",
    since: "2026-07-02",
  },
  {
    harness: "codex",
    authKind: "subscription",
    permittedTiers: ["server", "turn", "pty"],
    requiredFlags: [], // app-server needs no extra flags
    scrubEnv: [],
    fingerprints: [],
    note: "codex exec/app-server on ChatGPT-plan sign-in officially supported.",
    since: "2026-07-02",
  },
  {
    harness: "codex",
    authKind: "api-key",
    permittedTiers: ["server", "turn", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "codex exec/app-server; API-key sign-in equally supported.",
    since: "2026-07-02",
  },
  {
    harness: "opencode",
    authKind: "subscription",
    permittedTiers: ["server", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "opencode serve REST + official SDK; best embedding story. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "opencode",
    authKind: "api-key",
    permittedTiers: ["server", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "opencode serve REST + official SDK. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "kimi",
    authKind: "subscription",
    permittedTiers: ["stream", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "kimi acp (Agent Client Protocol over stdio); subscription permits third-party embedding. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "kimi",
    authKind: "api-key",
    permittedTiers: ["stream", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "kimi acp over stdio. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "grok",
    authKind: "subscription",
    permittedTiers: ["turn", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "grok -p headless streaming JSON; no server mode found, per-turn only. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "grok",
    authKind: "api-key",
    permittedTiers: ["turn", "pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "grok -p headless streaming JSON. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "pi",
    authKind: "subscription",
    permittedTiers: ["pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "no known structured mode; PTY only. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
  {
    harness: "pi",
    authKind: "api-key",
    permittedTiers: ["pty"],
    requiredFlags: [],
    scrubEnv: [],
    fingerprints: [],
    note: "no known structured mode; PTY only. unverified — refine in APIA-87/88.",
    since: "2026-07-02",
  },
];

/** The full policy row for a `(harness, authKind)`, or undefined if unmodeled. */
export function allowanceFor(harness: string, authKind: "subscription" | "api-key"): AllowanceRow | undefined {
  return ALLOWANCES.find((row) => row.harness === harness && row.authKind === authKind);
}

/** The best (first-permitted) tier for a `(harness, authKind)`. */
export function bestTier(harness: string, authKind: "subscription" | "api-key"): RunnerTier | undefined {
  return allowanceFor(harness, authKind)?.permittedTiers[0];
}

/** Env vars to delete from the spawn env for this `(harness, authKind)`. */
export function scrubEnvFor(harness: string, authKind: "subscription" | "api-key"): string[] {
  return allowanceFor(harness, authKind)?.scrubEnv ?? [];
}

/**
 * Resolve the tier to use after observing runner output. If `observed` contains
 * any of the row's fingerprint substrings, return the next-lower permitted tier
 * (a downgrade); otherwise return the current best tier. Undefined when the
 * pair is unmodeled or the best tier has no lower fallback.
 */
export function tierAfterFingerprint(
  harness: string,
  authKind: "subscription" | "api-key",
  observed: string,
): RunnerTier | undefined {
  const row = allowanceFor(harness, authKind);
  if (!row) return undefined;
  const tripped = row.fingerprints.some((fp) => observed.includes(fp));
  if (!tripped) return row.permittedTiers[0];
  return row.permittedTiers[1]; // next-lower permitted tier (best-first ordering)
}
