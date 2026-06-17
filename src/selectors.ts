import { colonyExists, listColonies } from "./colony.js";
import { matchesSessionReference } from "./ids.js";
import { listSessions, type SessionRecord } from "./store.js";
import { swarmIds } from "./swarm.js";
import { effectiveTags, isReservedNamespace } from "./tags.js";

/**
 * Reverse-relationship verbs. owns/owned-by/reports-to are aliases reading the
 * same `reportsToId` edge; children-of reads `parentId`; forks-of reads
 * `forkedFromId`. (TAGS_AND_RELATIONSHIPS_PRD Phase 2)
 */
export type RelVerb = "owns" | "owned-by" | "reports-to" | "children-of" | "forks-of";

export type Selector =
  | { kind: "bee"; query: string }
  | { kind: "swarm"; name: string } // @x — kept, now also expressible as tag:swarm:x
  | { kind: "colony"; name: string } // colony:x — kept, now also expressible as tag:colony:x
  | { kind: "tag"; namespace?: string; value: string } // facet / user-tag match
  | { kind: "rel"; verb: RelVerb; target: string }; // reverse relationship traversal

export type ResolvedTarget =
  | { kind: "bee"; record: SessionRecord }
  | { kind: "swarm"; name: string; records: SessionRecord[] }
  | { kind: "colony"; name: string; records: SessionRecord[] }
  | { kind: "tag"; namespace?: string; value: string; records: SessionRecord[] }
  | { kind: "rel"; verb: RelVerb; target: string; records: SessionRecord[] };

export type SelectorState = {
  records: SessionRecord[];
  swarms?: Set<string>;
  colonies?: Set<string>;
};

const SWARM_PREFIX = "@";
const COLONY_PREFIX = "colony:";
const WORKSPACE_PREFIX = "ws:";
const TAG_PREFIX = "tag:";
const TAG_HASH = "#";
const REL_VERBS: RelVerb[] = ["owns", "owned-by", "reports-to", "children-of", "forks-of"];

export function parseSelector(query: string): Selector {
  const trimmed = query.trim();

  // colony:x → colony kind (kept for compat; resolves to the same set as
  // tag:colony:x, but preserves its dedicated unknown-colony throw).
  if (trimmed.startsWith(COLONY_PREFIX)) {
    const name = trimmed.slice(COLONY_PREFIX.length);
    if (!name) throw new Error(`Empty colony selector: ${query}`);
    return { kind: "colony", name };
  }

  // ws:x → workspace membership, an alias for tag:workspace:x. The reserved
  // `workspace:` getter derives the value from record.workspaceId, so this
  // matches every bee whose home workspace is x. (WORKSPACES_AND_QUESTS §9)
  if (trimmed.startsWith(WORKSPACE_PREFIX)) {
    const name = trimmed.slice(WORKSPACE_PREFIX.length);
    if (!name) throw new Error(`Empty workspace selector: ${query}`);
    return { kind: "tag", namespace: "workspace", value: name };
  }

  // @x → swarm kind (kept for compat; same set as tag:swarm:x).
  if (trimmed.startsWith(SWARM_PREFIX)) {
    const name = trimmed.slice(SWARM_PREFIX.length);
    if (!name) throw new Error(`Empty swarm selector: ${query}`);
    return { kind: "swarm", name };
  }

  // #migration → user tag (no namespace).
  if (trimmed.startsWith(TAG_HASH)) {
    const value = trimmed.slice(TAG_HASH.length);
    if (!value) throw new Error(`Empty tag selector: ${query}`);
    return { kind: "tag", value };
  }

  // tag:migration → user tag; tag:ns:val → namespaced tag.
  if (trimmed.startsWith(TAG_PREFIX)) {
    const rest = trimmed.slice(TAG_PREFIX.length);
    if (!rest) throw new Error(`Empty tag selector: ${query}`);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) return { kind: "tag", value: rest };
    const namespace = rest.slice(0, colonIdx);
    const value = rest.slice(colonIdx + 1);
    if (!namespace || !value) throw new Error(`Invalid tag selector: ${query}`);
    return { kind: "tag", namespace, value };
  }

  if (!trimmed) throw new Error("Empty selector");

  // owns:/owned-by:/reports-to:/children-of:/forks-of:<bee> → rel kind (reverse
  // relationship traversal). RESERVED selector prefixes alongside @/colony:/#/tag:.
  // Checked BEFORE the generic <ns>:<val> reserved-namespace branch so the rel
  // verbs (which are not reserved tag namespaces) never fall into the tag path.
  for (const verb of REL_VERBS) {
    const prefix = `${verb}:`;
    if (trimmed.startsWith(prefix)) {
      const target = trimmed.slice(prefix.length).trim();
      if (!target) throw new Error(`Empty relationship selector: ${query}`);
      return { kind: "rel", verb, target };
    }
  }

  // <ns>:<val> where <ns> is a known reserved namespace (e.g. quest:q-ab,
  // caste:reviewer) → tag kind. A non-reserved namespace (e.g. prio:p1) is a
  // bare-token user tag stored verbatim, so it falls through to the bee branch
  // only if it doesn't look like ns:val — but a user tag with a namespace is a
  // legitimate selector too, so route any `ns:val` we recognize as a tag.
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const namespace = trimmed.slice(0, colonIdx);
    const value = trimmed.slice(colonIdx + 1);
    if (value && isReservedNamespace(namespace)) {
      return { kind: "tag", namespace, value };
    }
  }

  return { kind: "bee", query: trimmed };
}

// Resolve a bee anchor token to a RAW id for relationship matching. Mirrors the
// bee resolver's exact→prefix→ambiguity logic, but returns the matched record's
// id (or name) on a hit and undefined on a miss — so rel resolution can fall
// back to the raw token for a DEAD/removed anchor (§8.2 dead-anchor policy).
function resolveBeeId(state: SelectorState, token: string): string | undefined {
  const exact = state.records.find((r) => r.name === token);
  if (exact) return exact.id ?? exact.name;
  const matches = state.records.filter((r) => matchesSessionReference(r, token));
  if (matches.length === 1) return matches[0]!.id ?? matches[0]!.name;
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id ?? m.name).join(", ");
    throw new Error(`Ambiguous bee selector ${token}: ${ids}`);
  }
  return undefined; // dead/unknown anchor → caller falls back to the raw token
}

// Which SessionRecord field a rel verb reverse-queries. owns/owned-by/reports-to
// are aliases for the operator-set reportsToId edge.
function fieldFor(verb: RelVerb): "reportsToId" | "parentId" | "forkedFromId" {
  switch (verb) {
    case "owns":
    case "owned-by":
    case "reports-to":
      return "reportsToId";
    case "children-of":
      return "parentId";
    case "forks-of":
      return "forkedFromId";
  }
}

export function resolveSelectorFromState(selector: Selector, state: SelectorState): ResolvedTarget {
  if (selector.kind === "swarm") {
    const records = state.records.filter((record) => record.swarmId === selector.name);
    if (records.length === 0 && state.swarms && !state.swarms.has(selector.name)) {
      throw new Error(`Unknown swarm: @${selector.name}`);
    }
    return { kind: "swarm", name: selector.name, records };
  }

  if (selector.kind === "colony") {
    const records = state.records.filter((record) => record.colony === selector.name);
    if (records.length === 0 && state.colonies && !state.colonies.has(selector.name)) {
      throw new Error(`Unknown colony: colony:${selector.name}`);
    }
    return { kind: "colony", name: selector.name, records };
  }

  if (selector.kind === "tag") {
    // One predicate for every membership/tag selector: effective-tag-set
    // membership. The unknown-value THROW bifurcates per reserved namespace —
    // colony:/swarm: check their existence sets (matching legacy behavior),
    // while quest:/workspace: have no set yet (match 0..N) and user tags never
    // throw (PRD §8.2).
    const want = selector.namespace ? `${selector.namespace}:${selector.value}` : selector.value;
    const records = state.records.filter((record) => effectiveTags(record).has(want));
    if (records.length === 0 && selector.namespace) {
      if (selector.namespace === "colony" && state.colonies && !state.colonies.has(selector.value)) {
        throw new Error(`Unknown colony: ${want}`);
      }
      if (selector.namespace === "swarm" && state.swarms && !state.swarms.has(selector.value)) {
        throw new Error(`Unknown swarm: ${want}`);
      }
    }
    return { kind: "tag", namespace: selector.namespace, value: selector.value, records };
  }

  if (selector.kind === "rel") {
    // Resolve the anchor to a raw id; a DEAD/unknown anchor falls back to the
    // raw token (§8.2 dead-anchor policy) so reverse queries still match the
    // surviving bees that carry the now-dead id. A live but AMBIGUOUS anchor
    // still throws (user error) inside resolveBeeId.
    const targetId = resolveBeeId(state, selector.target) ?? selector.target;
    const field = fieldFor(selector.verb);
    const records = state.records.filter((record) => record[field] === targetId);
    return { kind: "rel", verb: selector.verb, target: selector.target, records };
  }

  const exact = state.records.find((record) => record.name === selector.query);
  if (exact) return { kind: "bee", record: exact };

  const matches = state.records.filter((record) => matchesSessionReference(record, selector.query));
  if (matches.length === 1) return { kind: "bee", record: matches[0]! };
  if (matches.length > 1) {
    const ids = matches.map((m) => m.id ?? m.name).join(", ");
    throw new Error(`Ambiguous bee selector ${selector.query}: ${ids}`);
  }
  throw new Error(`Unknown bee selector: ${selector.query}`);
}

export function isSelectorMulti(selector: Selector): boolean {
  return selector.kind === "swarm" || selector.kind === "colony" || selector.kind === "tag" || selector.kind === "rel";
}

export function formatSelector(selector: Selector): string {
  switch (selector.kind) {
    case "bee":
      return selector.query;
    case "swarm":
      return `@${selector.name}`;
    case "colony":
      return `colony:${selector.name}`;
    case "tag":
      return selector.namespace ? `${selector.namespace}:${selector.value}` : `#${selector.value}`;
    case "rel":
      return `${selector.verb}:${selector.target}`;
  }
}

export async function resolveSelector(query: string): Promise<ResolvedTarget> {
  const selector = parseSelector(query);
  const records = await listSessions();
  const state: SelectorState = { records };

  // The tag kind reuses colony:/swarm: existence sets for its unknown-value
  // throw, so a `tag:colony:x` / `tag:swarm:x` selector loads the same sets a
  // legacy colony:/@swarm selector would (PRD §8.2).
  const wantsSwarmSet = selector.kind === "swarm" || (selector.kind === "tag" && selector.namespace === "swarm");
  const wantsColonySet = selector.kind === "colony" || (selector.kind === "tag" && selector.namespace === "colony");
  const colonyName = selector.kind === "colony" ? selector.name : selector.kind === "tag" ? selector.value : undefined;

  if (wantsSwarmSet) state.swarms = await swarmIds();
  if (wantsColonySet) {
    const colonies = await listColonies();
    state.colonies = new Set(colonies.map((c) => c.name));
    // A colony created after the listColonies snapshot is still a valid
    // target; recheck the store before resolveSelectorFromState rejects it.
    if (colonyName && !state.colonies.has(colonyName) && (await colonyExists(colonyName))) {
      state.colonies.add(colonyName);
    }
  }
  return resolveSelectorFromState(selector, state);
}
