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
import { fleetTree, flattenFleet, type FleetEdge, type FleetNode } from "../fleet.js";

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

/** Resolve the fleet root: an explicit ref, or the current bee (self). */
async function resolveRoot(parsed: Parsed): Promise<SessionRecord> {
  const ref = parsed.args[0];
  if (ref) return resolveSession(ref);
  const self = await resolveBeeInCurrentPane();
  if (!self) {
    throw new Error("hive fleet: no <ref> given and not running inside a bee — pass a bee name/id, e.g. `hive fleet convex-orchestrator`");
  }
  return self;
}

export async function cmdFleet(parsed: Parsed): Promise<void> {
  const root = await resolveRoot(parsed);
  const [records, nodes] = await Promise.all([listSessions(), listNodes()]);
  const rootKey = root.id ?? root.name;
  const tree = fleetTree(rootKey, records, { includeForks: truthy(flag(parsed, "forks")) });
  if (!tree) throw new Error(`hive fleet: ${root.name} is not in the session store`);

  const nodesFlat = flattenFleet(tree);
  const probe = await liveTargetsAcrossNodes(nodes);
  const context = await buildStateContext(records, probe);

  const enriched: EnrichedNode[] = await Promise.all(
    nodesFlat.map(async (node: FleetNode) => {
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

  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify(toJson(enriched), null, 2));
    return;
  }
  console.log(renderFleet(enriched));
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
