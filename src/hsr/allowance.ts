/**
 * HSR allowance registry v1 (APIA-77).
 *
 * Lookup view over the harness registry (harness.ts — the single registration
 * point per HIVE-20). Each row models one `(harness, authKind)` pair: which
 * runner tiers are permitted (best-first), which flags the adapter must
 * append, which env vars to scrub from the spawn env, and which stderr/stdout
 * fingerprints force a tier downgrade. The versioned policy DATA itself lives
 * in each harness's descriptor (HARNESSES.<name>.allowance); this module keeps
 * the row-shaped public API stable for callers and tests.
 *
 * This is pure data + lookups; no process spawning, no wiring.
 */

import type { RunnerTier } from "./types.js";
import { AUTH_KINDS, harnessAllowance, harnessNames, type AuthKind } from "./harness.js";

/** One policy row for a `(harness, authKind)` pair. */
export type AllowanceRow = {
  harness: string;
  authKind: AuthKind;
  permittedTiers: RunnerTier[]; // best-first
  requiredFlags: string[]; // flags the adapter MUST include for this tier/auth
  scrubEnv: string[]; // env vars to delete from the spawn env (e.g. ANTHROPIC_API_KEY for claude subscription)
  fingerprints: string[]; // stderr/stdout substrings that force a tier downgrade (e.g. "--bare")
  note: string; // policy note
  since: string; // ISO date the row was last verified
};

// Materialized once from the harness registry, in registration order.
const ALLOWANCES: AllowanceRow[] = harnessNames().flatMap((harness) =>
  AUTH_KINDS.flatMap((authKind) => {
    const policy = harnessAllowance(harness, authKind);
    if (!policy) return [];
    return [
      {
        harness,
        authKind,
        permittedTiers: [...policy.permittedTiers],
        requiredFlags: [...policy.requiredFlags],
        scrubEnv: [...policy.scrubEnv],
        fingerprints: [...policy.fingerprints],
        note: policy.note,
        since: policy.since,
      },
    ];
  }),
);

/** The full policy row for a `(harness, authKind)`, or undefined if unmodeled. */
export function allowanceFor(harness: string, authKind: AuthKind): AllowanceRow | undefined {
  return ALLOWANCES.find((row) => row.harness === harness && row.authKind === authKind);
}

/** The best (first-permitted) tier for a `(harness, authKind)`. */
export function bestTier(harness: string, authKind: AuthKind): RunnerTier | undefined {
  return allowanceFor(harness, authKind)?.permittedTiers[0];
}

/** Env vars to delete from the spawn env for this `(harness, authKind)`. */
export function scrubEnvFor(harness: string, authKind: AuthKind): string[] {
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
  authKind: AuthKind,
  observed: string,
): RunnerTier | undefined {
  const row = allowanceFor(harness, authKind);
  if (!row) return undefined;
  const tripped = row.fingerprints.some((fp) => observed.includes(fp));
  if (!tripped) return row.permittedTiers[0];
  return row.permittedTiers[1]; // next-lower permitted tier (best-first ordering)
}
