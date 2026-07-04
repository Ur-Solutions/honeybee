// ──────────────────────────────────────────────────────────────────────────
// `hive fleet [<ref>]` — the durable fleet-state surface. Given an orchestrator
// bee (default: self, via HIVE_BEE / the current pane), it walks the persisted
// spawnedById edges into the descendant tree and enriches each node with the
// same live state `hive ps` derives (running/blocked/sealed/dead), last
// activity, and last seal. An orchestrator re-reads this (--json) every cycle to
// reconcile its children from ground truth instead of holding the roster in
// context, which compaction drops.
// ──────────────────────────────────────────────────────────────────────────

import { bold, dim, formatTable, isPretty, truncate, type TableColumn } from "../format.js";
import { flag, truthy, type Parsed } from "../parse.js";
import { listNodes } from "../node.js";
import { listSessions, type SessionRecord } from "../store.js";
import { deriveState, formatStateCell, stateLabel, type BeeState } from "../state.js";
import { loadLatestSeal, type SealRecord } from "../seal.js";
import { buildStateContext, liveTargetsAcrossNodes, resolveBeeInCurrentPane, resolveSession } from "../cli/shared.js";
import { fleetForest, fleetTree, flattenFleet, type FleetEdge, type FleetNode } from "../fleet.js";

type EnrichedNode = {
  record: SessionRecord;
  depth: number;
  edge?: FleetEdge;
  state: BeeState;
  detail: string;
  lastActivityAt?: string;
  idleMs?: number;
  seal: SealRecord | null;
};

/** Newest of the activity timestamps, as epoch ms (NaN when none parse). */
function lastActivityMs(record: SessionRecord): number {
  let best = NaN;
  for (const value of [record.lastPromptAt, record.briefedAt, record.updatedAt]) {
    const ms = value ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && (!Number.isFinite(best) || ms > best)) best = ms;
  }
  return best;
}

/** Coarse idle duration (s/m/h/d). */
function fmtIdle(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Which fleet trees to show:
 *  - `--all` or (no <ref> and not inside a bee) → every fleet (the forest).
 *  - explicit <ref> → just that orchestrator's tree.
 *  - no <ref> inside a bee → self's tree.
 */
async function resolveRoots(parsed: Parsed, records: SessionRecord[], opts: { includeForks?: boolean }): Promise<FleetNode[]> {
  const ref = parsed.args[0];
  if (truthy(flag(parsed, "all"))) return fleetForest(records, opts);
  if (ref) {
    const root = await resolveSession(ref);
    const tree = fleetTree(root.id ?? root.name, records, opts);
    if (!tree) throw new Error(`hive fleet: ${root.name} is not in the session store`);
    return [tree];
  }
  const self = await resolveBeeInCurrentPane();
  if (self) {
    const tree = fleetTree(self.id ?? self.name, records, opts);
    return tree ? [tree] : [];
  }
  // Human shell, no ref → show every fleet.
  return fleetForest(records, opts);
}

/** Enrich one tree's nodes with live state + last seal (root-first, flat). */
async function enrichTree(tree: FleetNode, context: Awaited<ReturnType<typeof buildStateContext>>): Promise<EnrichedNode[]> {
  return Promise.all(
    flattenFleet(tree).map(async (node) => {
      const derived = deriveState(node.record, context);
      const activity = lastActivityMs(node.record);
      return {
        record: node.record,
        depth: node.depth,
        edge: node.edge,
        state: derived.state,
        detail: derived.detail,
        lastActivityAt: Number.isFinite(activity) ? new Date(activity).toISOString() : undefined,
        idleMs: Number.isFinite(activity) ? Math.max(0, context.now - activity) : undefined,
        seal: await loadLatestSeal(node.record.name),
      };
    }),
  );
}

export async function cmdFleet(parsed: Parsed): Promise<void> {
  const opts = { includeForks: truthy(flag(parsed, "forks")) };
  const [records, nodes] = await Promise.all([listSessions(), listNodes()]);
  const roots = await resolveRoots(parsed, records, opts);
  const probe = await liveTargetsAcrossNodes(nodes);
  const context = await buildStateContext(records, probe);
  const fleets = await Promise.all(roots.map((tree) => enrichTree(tree, context)));

  if (truthy(flag(parsed, "json"))) {
    // A single self/explicit root stays the flat reconcile object an orchestrator
    // reads; the forest wraps them in { fleets: [...] }.
    if (fleets.length === 1 && !truthy(flag(parsed, "all"))) {
      console.log(JSON.stringify(toJson(fleets[0]!), null, 2));
    } else {
      console.log(JSON.stringify({ fleets: fleets.map(toJson) }, null, 2));
    }
    return;
  }
  if (fleets.length === 0) {
    console.log(dim("no fleets — no orchestrator has spawned children yet (lineage is captured going forward)"));
    return;
  }
  console.log(fleets.map(renderFleet).join("\n"));
}

/** Machine-readable fleet: root, per-state counts, and a flat bee list. */
function toJson(enriched: EnrichedNode[]) {
  const [root, ...descendants] = enriched;
  const counts: Record<string, number> = {};
  for (const node of descendants) counts[node.state] = (counts[node.state] ?? 0) + 1;
  const beeJson = (node: EnrichedNode) => ({
    name: node.record.name,
    id: node.record.id ?? null,
    agent: node.record.agent,
    depth: node.depth,
    edge: node.edge ?? null,
    state: node.state,
    detail: node.detail || null,
    lastActivityAt: node.lastActivityAt ?? null,
    idleSeconds: node.idleMs === undefined ? null : Math.floor(node.idleMs / 1000),
    seal: node.seal ? { status: node.seal.status, summary: node.seal.summary, sealedAt: node.seal.sealedAt } : null,
    brief: node.record.brief ?? null,
    account: node.record.accountId ?? null,
    node: node.record.node ?? null,
    cwd: node.record.cwd,
    providerSessionId: node.record.providerSessionId ?? null,
  });
  return {
    root: root ? beeJson(root) : null,
    total: descendants.length,
    counts,
    bees: descendants.map(beeJson),
  };
}

const R = (header: string): TableColumn => ({ header, align: "right" });
const L = (header: string): TableColumn => ({ header });

function renderFleet(enriched: EnrichedNode[]): string {
  const [root, ...descendants] = enriched;
  if (!root) return dim("no such bee");
  if (descendants.length === 0) {
    return `\n  ${bold("Fleet")} ${dim("·")} ${bold(root.record.name)}\n  ${dim("no spawned children on record")}\n`;
  }

  const counts = new Map<BeeState, number>();
  for (const node of descendants) counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
  const summary = [...counts.entries()].map(([state, n]) => `${n} ${stateLabel(state)}`).join(" · ");

  const columns = [L(""), L("STATE"), L("BEE"), L("AGENT"), R("IDLE"), L("SEAL"), L("BRIEF")];
  const body = descendants.map((node) => {
    const indent = "  ".repeat(Math.max(0, node.depth - 1));
    const sealCell = node.seal ? sealLabel(node.seal.status) : dim("—");
    return [
      dim(indent + (node.edge === "reports-to" ? "◇" : node.edge === "forked" ? "⑂" : "└")),
      formatStateCell(node.state),
      node.record.name,
      dim(node.record.agent),
      dim(fmtIdle(node.idleMs)),
      sealCell,
      node.record.brief ? truncate(node.record.brief, 44) : node.detail ? dim(truncate(node.detail, 44)) : "",
    ];
  });

  const header = `\n  ${bold("Fleet")} ${dim("·")} ${bold(root.record.name)}   ${dim(`${descendants.length} bees · ${summary}`)}`;
  return `${header}\n${formatTable(columns, body)}\n`;
}

function sealLabel(status: SealRecord["status"]): string {
  if (status === "blocked" || status === "failed" || status === "needs_input") return bold(status);
  return dim(status);
}
