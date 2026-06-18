/**
 * Tags — the unified labeling subsystem (TAGS_AND_RELATIONSHIPS_PRD Phase 1).
 *
 * A tag is a label carried by a bee, in one of two forms:
 *   - a bare token (`migration`, `waiting-review`) — a free-form user tag,
 *     stored verbatim with no invented prefix;
 *   - an explicit `namespace:value` (`prio:p1`) — a reserved facet or a
 *     power-user namespace.
 *
 * The existing single-hierarchy facets (colony/swarm/caste/node/agent/repo/…)
 * become RESERVED NAMESPACES whose value is DERIVED ON READ from the canonical
 * scalar fields that already store them — so "filter by colony", "filter by
 * swarm", and "filter by an arbitrary label" are the same line of code.
 *
 * This module is the single source of derivation logic: `effectiveTags`,
 * `renderTags`, and the selector predicate all read it, so the three consumers
 * never diverge (PRD §6 Effective tag set, §7.2 Layer 1).
 */
import { repoTagFor } from "./repoTag.js";
import type { SessionRecord } from "./store.js";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TAG GRAMMAR & VALIDATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * A parsed tag: either a bare user tag (no namespace) or `namespace:value`.
 * The value forbids whitespace, comma, tab, and newline — so the space-
 * delimited `@hive_tags` mirror and the tab-delimited `list-sessions` parse can
 * never be corrupted (PRD §6).
 */
export type ParsedTag = { namespace?: string; value: string };

// A tag value (and a bare tag) forbids whitespace, comma, tab, newline.
const TAG_VALUE_PATTERN = /^[^\s,\t\n]+$/;

// Per-field cap and per-bee cap (PRD §13: 32 tags × 64 chars).
export const MAX_TAG_LENGTH = 64;
export const MAX_TAGS_PER_BEE = 32;

/** Parse a token into a tag. Bare → user tag; `ns:val` → namespaced. */
export function parseTag(token: string): ParsedTag {
  const colonIdx = token.indexOf(":");
  if (colonIdx === -1) {
    // Bare user tag: no namespace.
    return { value: token };
  }
  const namespace = token.slice(0, colonIdx);
  const value = token.slice(colonIdx + 1);
  if (!namespace || !value) throw new Error(`Invalid tag format: ${token}`);
  return { namespace, value };
}

/** The namespace part of a tag, or undefined for a bare user tag. */
export function extractNamespace(tag: string): string | undefined {
  const colonIdx = tag.indexOf(":");
  return colonIdx === -1 ? undefined : tag.slice(0, colonIdx);
}

/** True when `tag` is a grammar-valid bare or `ns:val` token within the cap. */
export function isValidTagValue(tag: string): boolean {
  if (!tag || typeof tag !== "string") return false;
  if (tag.length > MAX_TAG_LENGTH) return false;
  const colonIdx = tag.indexOf(":");
  if (colonIdx === -1) {
    // Bare tag: must match the value pattern.
    return TAG_VALUE_PATTERN.test(tag);
  }
  // Namespaced: namespace is any non-empty string, value matches the pattern.
  const namespace = tag.slice(0, colonIdx);
  const value = tag.slice(colonIdx + 1);
  return namespace.length > 0 && value.length > 0 && TAG_VALUE_PATTERN.test(value);
}

/** Dedupe a tag list preserving first-seen order. */
export function dedupeTags(tags: string[]): string[] {
  return [...new Set(tags)];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// RESERVED NAMESPACES
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// The reserved namespace names that CANNOT be written via `hive tag` and that
// are stripped from `record.tags` on load (defense-in-depth). `state` is here
// for the rejection/strip guard, but is NOT in `RESERVED_NAMESPACES` below —
// it is a tmux-facet tag only, never derived in the store-only filter path
// (PRD §13, §16 Q6).
const RESERVED_NAMESPACE_LIST = [
  "colony", "swarm", "caste", "node", "agent", "repo", // live-in-v1 / net-new
  "quest", "workspace", "comb", // lights-up-later tiers
  "state", // special: tmux-facet only, never store-derived
];

/** True when `ns` is a reserved namespace (rejected by `hive tag`). */
export function isReservedNamespace(ns: string | undefined): boolean {
  if (!ns) return false;
  return RESERVED_NAMESPACE_LIST.includes(ns);
}

/** The full reserved-namespace list (copy). */
export function getReservedNamespaces(): string[] {
  return [...RESERVED_NAMESPACE_LIST];
}

/**
 * The reserved-namespace getters. Each maps a namespace to a function that
 * derives the tag value from a SessionRecord. Split by tier (PRD §6):
 *   - live-in-v1: back an existing field, derive with zero new data;
 *   - net-new derivation this PRD builds: repo;
 *   - lights-up-later: getters present, return undefined until WORKSPACES_AND_
 *     QUESTS / fork-and-pane populate their fields.
 *
 * `state` is intentionally absent — per §13 it must never trigger a per-bee
 * tmux round-trip in the store-only filter path; `--state` (Tier 0) handles
 * live state separately.
 */
export const RESERVED_NAMESPACES: Record<string, (record: SessionRecord) => string | undefined> = {
  // Live in v1 (back an existing field):
  colony: (r) => r.colony,
  swarm: (r) => r.swarmId,
  caste: (r) => r.caste,
  node: (r) => r.node,
  agent: (r) => r.agent,
  // Net-new derivation this PRD builds:
  repo: (r) => repoTagFor(r.cwd),
  // Lights up when its owning PRD lands (getter present, value undefined today):
  quest: (r) => (r as { questId?: string }).questId,
  workspace: (r) => (r as { workspaceId?: string }).workspaceId,
  comb: (r) => r.combId ?? r.tmuxTarget,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EFFECTIVE TAG SET (the one derivation point)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * The effective tag set for a bee: derived reserved tags (from every getter
 * returning a non-empty value) ∪ the stored user tags in `record.tags`. This is
 * the ONE derivation point — the selector predicate, `hive tag --list`, and the
 * `@hive_tags` renderer all read it, so they never diverge (PRD §6, §7.2).
 *
 * `state:` is NOT included — per §13 state is a tmux-facet tag surfaced only
 * where the live state map is already in hand, never as a store-only filter.
 */
export function effectiveTags(record: SessionRecord): Set<string> {
  const tags = new Set<string>();

  // Derived reserved tags: for each getter returning a non-empty value, add
  // the `ns:value` pair.
  for (const [ns, getter] of Object.entries(RESERVED_NAMESPACES)) {
    const value = getter(record);
    if (value && value.length > 0) tags.add(`${ns}:${value}`);
  }

  // User tags: stored verbatim (bare or power-user namespaced).
  if (record.tags) {
    for (const tag of record.tags) tags.add(tag);
  }

  return tags;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TMUX MIRRORING
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Render the effective tag set as the `@hive_tags` wire form: a single space-
 * delimited string with a LEADING and TRAILING space (sentinel-wrapped), so
 * tmux word-boundary matching works:
 *
 *   tmux ls -f '#{m:* migration *,#{@hive_tags}}' -F '#{@hive_id}'
 *
 * matches `migration` exactly without false-positive `migration-foo` (verified
 * on tmux 3.6a, PRD §9.1). Tags are sorted for a stable string. The empty set
 * renders as "" (clears the option).
 */
export function renderTags(record: SessionRecord): string {
  const tags = effectiveTags(record);
  if (tags.size === 0) return "";
  const sorted = Array.from(tags).sort();
  return ` ${sorted.join(" ")} `;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// GUARDS & VALIDATION
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Per-namespace redirect to the canonical write verb, used by `hive tag`.
const RESERVED_REDIRECTS: Record<string, string> = {
  colony: "set it via hive spawn --colony / hive move <bee> --colony, not hive tag",
  swarm: "swarm is set at spawn; move bees via swarm destroy/spawn, not hive tag",
  caste: "set it via hive spawn --frame at spawn (immutable), not hive tag",
  node: "set it via hive spawn --node at spawn (immutable), not hive tag",
  agent: "set it via hive spawn <agent> at spawn (immutable), not hive tag",
  repo: "repo is read-only; it derives from cwd, not hive tag",
  quest: "set it via quest start (when WORKSPACES_AND_QUESTS lands), not hive tag",
  workspace: "set it via workspace add (when WORKSPACES_AND_QUESTS lands), not hive tag",
  comb: "set it via hive split at spawn/split (immutable), not hive tag",
  state: "state is a live tmux facet, not writable via hive tag",
};

/**
 * Guard for `hive tag`: if `tag` carries a reserved namespace, return a human
 * message redirecting to the canonical verb; otherwise null (the tag is OK to
 * write as a user tag).
 */
export function rejectReservedNamespaceTag(tag: string): string | null {
  const ns = extractNamespace(tag);
  if (!isReservedNamespace(ns)) return null;
  const redirect = RESERVED_REDIRECTS[ns!] ?? "set it via the canonical verb, not hive tag";
  return `${ns} is a reserved facet — ${redirect}`;
}

/**
 * Helper for `normalizeSessionRecord`: a persistable user tag is grammar-valid
 * AND not in a reserved namespace (so a hand-edited file can't smuggle
 * `colony:x` into `record.tags`).
 */
export function isValidSessionTag(tag: string): boolean {
  return isValidTagValue(tag) && !isReservedNamespace(extractNamespace(tag));
}

/**
 * Normalize a candidate user-tag argument for matching/storage. Tags are stored
 * and matched verbatim (bare or `ns:val`), so this is identity today; kept as a
 * single chokepoint so `hive list --tag` and `hive tag` share one rule.
 */
export function normalizeTagArg(tag: string): string {
  return tag;
}
