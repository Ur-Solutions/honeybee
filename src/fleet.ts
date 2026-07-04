// ──────────────────────────────────────────────────────────────────────────
// Fleet graph: the durable orchestrator→worker tree derived from the session
// store. An orchestrator bee spawns children; each child records its spawner in
// `spawnedById` (captured automatically at spawn — see commands/spawn.ts). This
// module walks those edges so a coordinator can reconcile "what is my fleet
// doing" from ground truth every cycle, instead of holding the roster in its
// own context (which compaction silently drops).
//
// Pure over SessionRecord[]: no I/O, no status probing. The command layer reads
// sessions, calls in here for structure, then enriches nodes with live state.
// Shared with future apiary lineage views — keep it dependency-light.
// ──────────────────────────────────────────────────────────────────────────

import type { SessionRecord } from "./store.js";

/** How a child connects to its parent, most-authoritative first. */
export type FleetEdge = "spawned" | "reports-to" | "forked";

export type FleetNode = {
  record: SessionRecord;
  /** 0 for the root, 1 for its direct children, etc. */
  depth: number;
  /** The edge from this node up to its parent; undefined for the root. */
  edge?: FleetEdge;
  children: FleetNode[];
};

/** The distinct identity keys another record may point at (id or name). */
function keysOf(record: SessionRecord): string[] {
  const keys = new Set<string>();
  if (record.id) keys.add(record.id);
  if (record.name) keys.add(record.name);
  return [...keys];
}

/**
 * The parent this record points at, and via which edge. Precedence: the
 * automatic spawn edge wins over an operator-set reports-to, which wins over
 * fork lineage. Returns null for a root (no parent edge).
 */
export function parentEdgeOf(record: SessionRecord, opts?: { includeForks?: boolean }): { ref: string; edge: FleetEdge } | null {
  if (record.spawnedById) return { ref: record.spawnedById, edge: "spawned" };
  if (record.reportsToId) return { ref: record.reportsToId, edge: "reports-to" };
  if (opts?.includeForks && record.forkedFromId) return { ref: record.forkedFromId, edge: "forked" };
  return null;
}

/** Resolve a ref (id/name) to the session it identifies, or undefined. */
export function findSession(ref: string, sessions: SessionRecord[]): SessionRecord | undefined {
  return sessions.find((record) => record.id === ref || record.name === ref);
}

type BuildResult = {
  /** ref-key -> the node for the session that key identifies. */
  nodeByKey: Map<string, FleetNode>;
  /** parent ref-key -> child nodes pointing at it. */
  childrenByParentRef: Map<string, FleetNode[]>;
};

function buildIndex(sessions: SessionRecord[], opts?: { includeForks?: boolean }): BuildResult {
  const nodeByKey = new Map<string, FleetNode>();
  const nodes: FleetNode[] = [];
  for (const record of sessions) {
    const node: FleetNode = { record, depth: 0, children: [] };
    nodes.push(node);
    for (const key of keysOf(record)) nodeByKey.set(key, node);
  }
  const childrenByParentRef = new Map<string, FleetNode[]>();
  for (const node of nodes) {
    const parent = parentEdgeOf(node.record, opts);
    if (!parent) continue;
    node.edge = parent.edge;
    const list = childrenByParentRef.get(parent.ref) ?? [];
    list.push(node);
    childrenByParentRef.set(parent.ref, list);
  }
  return { nodeByKey, childrenByParentRef };
}

/**
 * The fleet tree rooted at `rootRef` (a bee id or name). Returns null when the
 * root isn't a known session. Children are attached by edge, sorted by
 * createdAt then name for stable output, and cycles are broken by a visited set
 * (a self-referential or mutually-referential edge never loops forever).
 */
export function fleetTree(rootRef: string, sessions: SessionRecord[], opts?: { includeForks?: boolean }): FleetNode | null {
  const { nodeByKey, childrenByParentRef } = buildIndex(sessions, opts);
  const root = nodeByKey.get(rootRef);
  if (!root) return null;

  const visited = new Set<FleetNode>();
  const attach = (node: FleetNode, depth: number): void => {
    if (visited.has(node)) return;
    visited.add(node);
    node.depth = depth;
    const kids: FleetNode[] = [];
    for (const key of keysOf(node.record)) {
      for (const child of childrenByParentRef.get(key) ?? []) {
        if (!visited.has(child)) kids.push(child);
      }
    }
    kids.sort(
      (a, b) =>
        (a.record.createdAt ?? "").localeCompare(b.record.createdAt ?? "") ||
        (a.record.name ?? "").localeCompare(b.record.name ?? ""),
    );
    node.children = kids;
    for (const child of kids) attach(child, depth + 1);
  };
  attach(root, 0);
  return root;
}

/** Flatten a fleet tree depth-first (root first). */
export function flattenFleet(root: FleetNode): FleetNode[] {
  const out: FleetNode[] = [];
  const walk = (node: FleetNode): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

/**
 * The descendant records of `rootRef` (excluding the root itself), in tree
 * order. The flat list a coordinator reconciles against `hive ps`.
 */
export function fleetDescendants(rootRef: string, sessions: SessionRecord[], opts?: { includeForks?: boolean }): FleetNode[] {
  const root = fleetTree(rootRef, sessions, opts);
  if (!root) return [];
  return flattenFleet(root).filter((node) => node !== root);
}

/**
 * Every distinct fleet, as a forest: each top-level orchestrator (a bee with no
 * resolvable parent in the set) that has at least one descendant, rendered as a
 * full tree. The operator's "show me all the fleets" view — no need to know the
 * orchestrator names. Sorted by createdAt then name.
 */
export function fleetForest(sessions: SessionRecord[], opts?: { includeForks?: boolean }): FleetNode[] {
  const roots: FleetNode[] = [];
  for (const record of sessions) {
    const parent = parentEdgeOf(record, opts);
    // A resolvable parent inside the set means this bee sits UNDER another fleet,
    // so it is not a top-level root (it still appears within its parent's tree).
    if (parent && findSession(parent.ref, sessions)) continue;
    const tree = fleetTree(record.id ?? record.name, sessions, opts);
    if (tree && tree.children.length > 0) roots.push(tree);
  }
  return roots.sort(
    (a, b) =>
      (a.record.createdAt ?? "").localeCompare(b.record.createdAt ?? "") ||
      (a.record.name ?? "").localeCompare(b.record.name ?? ""),
  );
}
