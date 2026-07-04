// ──────────────────────────────────────────────────────────────────────────
// The pricing table for the spend subsystem: real published Anthropic list
// rates (USD per 1,000,000 tokens), versioned by effectiveFrom so historical
// events price at the rate in force on their day. Cache writes split 5m vs 1h
// because Anthropic bills them differently (1h ephemeral writes are pricier).
//
// Multipliers off the base input rate (Anthropic published):
//   cache read     = 0.10 x input   (a cache hit / refresh read)
//   cache write 5m = 1.25 x input   (5-minute ephemeral write)
//   cache write 1h = 2.00 x input   (1-hour ephemeral write)
//
// Non-Anthropic models (codex/gpt-5.x, grok, …) are registered as `todo:true`
// rules with empty versions: they are counted and flagged loudly rather than
// silently priced at zero. Fill in real list prices before trusting their USD.
// ──────────────────────────────────────────────────────────────────────────

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { withFileLock } from "../lock.js";
import { ratesPath } from "./paths.js";
import type { RateRule, RateTable, RateVersion } from "./types.js";

/** Build a fully-priced Anthropic RateVersion from the base input/output rates. */
function anthropicVersion(effectiveFrom: string, inputPerMTok: number, outputPerMTok: number): RateVersion {
  const round = (value: number) => Math.round(value * 10000) / 10000;
  return {
    effectiveFrom,
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: round(inputPerMTok * 0.1),
    cacheWrite5mPerMTok: round(inputPerMTok * 1.25),
    cacheWrite1hPerMTok: round(inputPerMTok * 2),
  };
}

/** An Anthropic rule whose price never versioned (single flat list price). */
function anthropicRule(modelPattern: string, effectiveFrom: string, input: number, output: number, note?: string): RateRule {
  return {
    modelPattern,
    provider: "anthropic",
    ...(note ? { note } : {}),
    versions: [anthropicVersion(effectiveFrom, input, output)],
  };
}

/** A registered-but-unpriced model: counted and flagged, never priced at zero. */
function todoRule(modelPattern: string, provider: string, note: string): RateRule {
  return { modelPattern, provider, note, todo: true, versions: [] };
}

/**
 * The seeded pricing table. Patterns are literal model-id substrings; the
 * resolver (matchModelRule) picks the longest literal match, so specific
 * per-version rules win over the family fallbacks below them.
 */
export function seedRateTable(): RateTable {
  const rules: RateRule[] = [
    // ── Claude Opus, current $5 / $25 tier (4.5 → 4.8) ──────────────────────
    anthropicRule("claude-opus-4-8", "2026-05-19", 5, 25),
    anthropicRule("claude-opus-4-7", "2026-02-24", 5, 25),
    anthropicRule("claude-opus-4-6", "2025-12-15", 5, 25),
    anthropicRule("claude-opus-4-5", "2025-11-24", 5, 25),

    // ── Claude Opus, legacy $15 / $75 tier (4.0, 4.1) ───────────────────────
    // Opus 4.1 id is claude-opus-4-1-YYYYMMDD; Opus 4.0 id is
    // claude-opus-4-YYYYMMDD, matched here by the date-prefixed literal so it
    // does not fall through to the cheaper generic claude-opus fallback.
    anthropicRule("claude-opus-4-1", "2025-08-05", 15, 75),
    anthropicRule("claude-opus-4-2025", "2025-05-22", 15, 75, "Claude Opus 4.0 (claude-opus-4-20250514)"),

    // ── Claude Sonnet 5 — intro $2 / $10 through 2026-08-31, then $3 / $15 ──
    // Two versions: the resolver uses the latest effectiveFrom <= event day,
    // so events before the intro window closes price at the discounted rate.
    {
      modelPattern: "claude-sonnet-5",
      provider: "anthropic",
      note: "Sonnet 5: introductory $2/$10 per MTok through 2026-08-31, then standard $3/$15.",
      versions: [
        anthropicVersion("2026-02-01", 2, 10),
        anthropicVersion("2026-09-01", 3, 15),
      ],
    },

    // ── Claude Sonnet, $3 / $15 tier (4.0, 4.5, 4.6) ────────────────────────
    anthropicRule("claude-sonnet-4-6", "2026-01-01", 3, 15),
    anthropicRule("claude-sonnet-4-5", "2025-09-29", 3, 15),
    anthropicRule("claude-sonnet-4", "2025-05-22", 3, 15, "Claude Sonnet 4.0 (claude-sonnet-4-YYYYMMDD)"),

    // ── Claude Haiku 4.5, $1 / $5 tier ──────────────────────────────────────
    anthropicRule("claude-haiku-4-5", "2025-10-01", 1, 5),

    // ── Family fallbacks: newest-tier prices when a specific rule misses. ────
    // Longer literals above win; these catch unseen point releases at the
    // current per-tier list price. Anything not even matching these hits the
    // todo catch-all and is flagged.
    anthropicRule("claude-opus", "2025-11-24", 5, 25, "Fallback: assumes current Opus $5/$25 tier (pre-4.5 Opus billed $15/$75)."),
    anthropicRule("claude-sonnet", "2025-05-22", 3, 15, "Fallback: current Sonnet $3/$15 tier."),
    anthropicRule("claude-haiku", "2025-10-01", 1, 5, "Fallback: current Haiku $1/$5 tier."),

    // ── Non-Anthropic models: registered but unpriced (never zero). ─────────
    // OpenAI/codex (gpt-5.x) and grok list prices are not confirmed here; leave
    // as todo so they surface loudly instead of being silently mis-priced.
    todoRule("gpt-5", "openai", "codex/gpt-5.x: list price unconfirmed — fill input/output/cache before trusting USD."),
    todoRule("gpt-4", "openai", "codex/gpt-4.x: list price unconfirmed."),
    todoRule("o3", "openai", "OpenAI o3: list price unconfirmed."),
    todoRule("o4", "openai", "OpenAI o4: list price unconfirmed."),
    todoRule("codex", "openai", "codex harness model: list price unconfirmed."),
    todoRule("grok", "xai", "xAI grok: list price unconfirmed."),

    // ── Final catch-all: any other Claude id is counted but flagged. ────────
    todoRule("claude", "anthropic", "Unknown Claude model id — add an explicit rule to price it."),
  ];
  return { rules };
}

/**
 * Lightly validate an untrusted parsed value into a RateTable, rejecting
 * malformed input. Numeric price fields must be a finite number or null; a
 * `todo` rule may carry empty/partial versions.
 */
export function validateRateTable(raw: unknown): RateTable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("rate table must be an object");
  }
  const rulesValue = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rulesValue)) throw new Error("rate table must have a rules array");

  const rules: RateRule[] = rulesValue.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`rule ${index} must be an object`);
    }
    const object = entry as Record<string, unknown>;
    if (typeof object.modelPattern !== "string" || object.modelPattern.length === 0) {
      throw new Error(`rule ${index} must have a non-empty modelPattern`);
    }
    if (object.todo !== undefined && typeof object.todo !== "boolean") {
      throw new Error(`rule ${index} todo must be a boolean`);
    }
    if (!Array.isArray(object.versions)) {
      throw new Error(`rule ${index} must have a versions array`);
    }
    const versions = object.versions.map((versionEntry, versionIndex) => validateVersion(versionEntry, index, versionIndex));
    const rule: RateRule = {
      modelPattern: object.modelPattern,
      versions,
      ...(typeof object.provider === "string" ? { provider: object.provider } : {}),
      ...(typeof object.note === "string" ? { note: object.note } : {}),
      ...(object.todo === true ? { todo: true } : {}),
    };
    return rule;
  });
  return { rules };
}

function validateVersion(raw: unknown, ruleIndex: number, versionIndex: number): RateVersion {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`rule ${ruleIndex} version ${versionIndex} must be an object`);
  }
  const object = raw as Record<string, unknown>;
  if (typeof object.effectiveFrom !== "string" || object.effectiveFrom.length === 0) {
    throw new Error(`rule ${ruleIndex} version ${versionIndex} must have an effectiveFrom date`);
  }
  const price = (key: keyof RateVersion): number | null => {
    const value = object[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`rule ${ruleIndex} version ${versionIndex} ${String(key)} must be a number or null`);
    }
    return value;
  };
  return {
    effectiveFrom: object.effectiveFrom,
    inputPerMTok: price("inputPerMTok"),
    outputPerMTok: price("outputPerMTok"),
    cacheReadPerMTok: price("cacheReadPerMTok"),
    cacheWrite5mPerMTok: price("cacheWrite5mPerMTok"),
    cacheWrite1hPerMTok: price("cacheWrite1hPerMTok"),
  };
}

/**
 * Load the on-disk rate table, or the seeded default when the file is absent.
 * Read-only: a missing file is NOT written here (see ensureRatesFile).
 */
export async function loadRates(path: string = ratesPath()): Promise<RateTable> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return seedRateTable();
    throw error;
  }
  return validateRateTable(JSON.parse(raw));
}

/**
 * Write the seeded rate table to disk when absent and return the path; if the
 * file already exists, leave it untouched (the user's edits are preserved).
 */
export async function ensureRatesFile(path: string = ratesPath()): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    try {
      // wx: create-only — a concurrent writer or a pre-existing file both land
      // in EEXIST, which we swallow so an existing table is never clobbered.
      await writeFile(path, `${JSON.stringify(seedRateTable(), null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  });
  return path;
}

/** Persist a rate table, overwriting any existing file. Serialized by lock. */
export async function saveRates(table: RateTable, path: string = ratesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await withFileLock(`${path}.lock`, async () => {
    await writeFile(path, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 });
  });
}
