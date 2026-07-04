import { hsrSubstrate } from "../hsr/substrate.js";
import { loadNodeSync, LOCAL_NODE_NAME, type NodeKind, type NodeRecord } from "../node.js";
import type { SessionRecord } from "../store.js";
import { createLocalTmuxSubstrate } from "./local-tmux.js";
import { createRemoteHsrSubstrate, type RemoteHsrSubstrate } from "./remote-hsr.js";
import { createSshTmuxSubstrate } from "./ssh-tmux.js";
import { type Substrate } from "./types.js";

export type { RemoteHsrSubstrate } from "./remote-hsr.js";

export type { KillResult, LaunchSpec, ProbeResult, Substrate, SubstrateKind, TmuxWindowOptions } from "./types.js";
export { LOCAL_NODE } from "./types.js";

const cache = new Map<string, Substrate>();

/**
 * One registry entry per NODE substrate kind: the stable cache key for a node's
 * substrate instance, and the builder that constructs it.
 */
type SubstrateEntry = {
  /** Stable cache key for this node's substrate instance (see getOrCache). */
  cacheKey(node: NodeRecord): string;
  /** Build a fresh substrate instance for this node. */
  build(node: NodeRecord): Substrate;
};

/**
 * The substrate registry (HIVE-32): the single place that maps a node kind to
 * how its substrate is keyed and built. substrateForRecord, substrateForNode's
 * local-overlay path, and remoteHsrSubstrateForNode all resolve through this
 * table, so adding a node substrate kind is one new entry here (plus the NodeKind
 * union + registerNode validation) rather than a branch ladder plus a bespoke
 * cache-key function scattered across this module.
 *
 * The `hsr` member of SubstrateKind is intentionally absent: it is a record-level
 * substrate (routed by `record.substrate`, not `node.kind`) and a parameterless
 * local singleton, so it lives outside node routing — see substrateFor's
 * short-circuit and hsr/substrate.ts.
 */
const SUBSTRATE_REGISTRY: Record<NodeKind, SubstrateEntry> = {
  "local-tmux": {
    // Local tmux ignores per-node transport fields, so the node name alone keys it.
    cacheKey: (node) => localTmuxCacheKey(node.name),
    build: () => createLocalTmuxSubstrate(),
  },
  "ssh-tmux": {
    // Key on every field that shapes the ssh transport, not just the endpoint:
    // `hive node update --ssh-args/--ssh-command` with an unchanged endpoint must
    // not leave long-lived processes (the daemon) reusing a stale substrate, and
    // two nodes sharing an endpoint must not collapse into one cache entry.
    cacheKey: (node) => JSON.stringify(["ssh-tmux", node.name, node.endpoint, node.sshCommand ?? "", node.sshArgs ?? []]),
    build: (node) => createSshTmuxSubstrate({ node }),
  },
  "remote-hsr": {
    // Key on the fields that shape the ssh transport (endpoint + ssh command/args)
    // plus the runner-host version, so a re-bootstrap or ssh-arg change doesn't
    // leave the daemon reusing a stale forwarded socket.
    cacheKey: (node) =>
      JSON.stringify(["remote-hsr", node.name, node.endpoint, node.sshCommand ?? "", node.sshArgs ?? [], node.runnerHostVersion ?? ""]),
    build: (node) => createRemoteHsrSubstrate(node),
  },
};

function localTmuxCacheKey(nodeName: string): string {
  return `local-tmux::${nodeName}`;
}

export function localSubstrate(): Substrate {
  return getOrCache(localTmuxCacheKey(LOCAL_NODE_NAME), createLocalTmuxSubstrate);
}

export function substrateFor(record: Pick<SessionRecord, "node" | "substrate">): Substrate {
  // HSR is a record-level, local-only substrate — route it before node routing.
  if (record.substrate === "hsr") return hsrSubstrate();
  const nodeName = record.node && record.node.length > 0 ? record.node : LOCAL_NODE_NAME;
  return substrateForNode(nodeName);
}

export function substrateForNode(nodeName: string | undefined): Substrate {
  const resolved = nodeName && nodeName.length > 0 ? nodeName : LOCAL_NODE_NAME;
  if (resolved === LOCAL_NODE_NAME) {
    const overlay = loadNodeSync(LOCAL_NODE_NAME, { tolerateInvalid: true });
    if (overlay && overlay.kind === "ssh-tmux") {
      // User explicitly aliased "local" to a remote endpoint. Honor it.
      return substrateForRecord(overlay);
    }
    return localSubstrate();
  }

  const node = loadNodeSync(resolved, { tolerateInvalid: true });
  if (!node) {
    throw new Error(`Unknown node: ${resolved}. Register it with: hive node register ${resolved} --kind ssh-tmux --endpoint user@host`);
  }
  return substrateForRecord(node);
}

export function substrateForRecord(node: NodeRecord): Substrate {
  const entry = SUBSTRATE_REGISTRY[node.kind];
  return getOrCache(entry.cacheKey(node), () => entry.build(node));
}

/**
 * The typed remote-HSR substrate for a node (the spawn path needs `spawnRemote`,
 * which is not on the base Substrate interface). Shares the per-node cache with
 * substrateForRecord so one resilient transport client is reused everywhere.
 */
export function remoteHsrSubstrateForNode(node: NodeRecord): RemoteHsrSubstrate {
  if (node.kind !== "remote-hsr") {
    throw new Error(`remoteHsrSubstrateForNode requires kind=remote-hsr, got ${node.kind}`);
  }
  return substrateForRecord(node) as RemoteHsrSubstrate;
}

function getOrCache(key: string, build: () => Substrate): Substrate {
  const existing = cache.get(key);
  if (existing) return existing;
  const built = build();
  cache.set(key, built);
  return built;
}

export function clearSubstrateCache(): void {
  cache.clear();
}

/**
 * Tear down every cached substrate that holds a live resource, then drop them.
 *
 * Only remote-hsr substrates own a long-lived handle: the `ssh -N -L` forward
 * tunnel child spawned to reach the runner host. That child keeps Node's event
 * loop alive, so a one-shot CLI that merely *probed* a remote node (e.g.
 * `hive ls` / `hive fleet` fanning out across nodes) would print its output and
 * then hang until the tunnel died on its own. Closing the substrate chains
 * RemoteRunnerClient.close → tunnel.close → child.kill, releasing the loop.
 *
 * Best-effort: a substrate without `close` (local-tmux, ssh-tmux) is skipped,
 * and a close that throws is swallowed — teardown must never fail a command.
 * Call this once, in a `finally`, after a one-shot command completes.
 */
export async function closeAllSubstrates(): Promise<void> {
  const closables = [...cache.values()].filter(
    (s): s is Substrate & { close(): Promise<void> } => typeof (s as { close?: unknown }).close === "function",
  );
  cache.clear();
  await Promise.all(closables.map((s) => s.close().catch(() => undefined)));
}
