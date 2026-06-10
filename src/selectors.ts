import { colonyExists, listColonies } from "./colony.js";
import { matchesSessionReference } from "./ids.js";
import { listSessions, type SessionRecord } from "./store.js";
import { swarmIds } from "./swarm.js";

export type Selector =
  | { kind: "bee"; query: string }
  | { kind: "swarm"; name: string }
  | { kind: "colony"; name: string };

export type ResolvedTarget =
  | { kind: "bee"; record: SessionRecord }
  | { kind: "swarm"; name: string; records: SessionRecord[] }
  | { kind: "colony"; name: string; records: SessionRecord[] };

export type SelectorState = {
  records: SessionRecord[];
  swarms?: Set<string>;
  colonies?: Set<string>;
};

const SWARM_PREFIX = "@";
const COLONY_PREFIX = "colony:";

export function parseSelector(query: string): Selector {
  const trimmed = query.trim();
  if (trimmed.startsWith(COLONY_PREFIX)) {
    const name = trimmed.slice(COLONY_PREFIX.length);
    if (!name) throw new Error(`Empty colony selector: ${query}`);
    return { kind: "colony", name };
  }
  if (trimmed.startsWith(SWARM_PREFIX)) {
    const name = trimmed.slice(SWARM_PREFIX.length);
    if (!name) throw new Error(`Empty swarm selector: ${query}`);
    return { kind: "swarm", name };
  }
  if (!trimmed) throw new Error("Empty selector");
  return { kind: "bee", query: trimmed };
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
  return selector.kind === "swarm" || selector.kind === "colony";
}

export function formatSelector(selector: Selector): string {
  switch (selector.kind) {
    case "bee":
      return selector.query;
    case "swarm":
      return `@${selector.name}`;
    case "colony":
      return `colony:${selector.name}`;
  }
}

export async function resolveSelector(query: string): Promise<ResolvedTarget> {
  const selector = parseSelector(query);
  const records = await listSessions();
  const state: SelectorState = { records };
  if (selector.kind === "swarm") state.swarms = await swarmIds();
  if (selector.kind === "colony") {
    const colonies = await listColonies();
    state.colonies = new Set(colonies.map((c) => c.name));
    // A colony created after the listColonies snapshot is still a valid
    // target; recheck the store before resolveSelectorFromState rejects it.
    if (!state.colonies.has(selector.name) && (await colonyExists(selector.name))) {
      state.colonies.add(selector.name);
    }
  }
  return resolveSelectorFromState(selector, state);
}
