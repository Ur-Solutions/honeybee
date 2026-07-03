import { hsrSubstrate } from "../hsr/substrate.js";
import { loadNodeSync, LOCAL_NODE_NAME, type NodeRecord } from "../node.js";
import type { SessionRecord } from "../store.js";
import { createLocalTmuxSubstrate } from "./local-tmux.js";
import { createRemoteHsrSubstrate, type RemoteHsrSubstrate } from "./remote-hsr.js";
import { createSshTmuxSubstrate } from "./ssh-tmux.js";
import { type Substrate } from "./types.js";

export type { RemoteHsrSubstrate } from "./remote-hsr.js";

export type { KillResult, LaunchSpec, ProbeResult, Substrate, SubstrateKind, TmuxWindowOptions } from "./types.js";
export { LOCAL_NODE } from "./types.js";

const cache = new Map<string, Substrate>();

export function localSubstrate(): Substrate {
  return getOrCache(`local-tmux::${LOCAL_NODE_NAME}`, createLocalTmuxSubstrate);
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
    const overlay = loadNodeSync(LOCAL_NODE_NAME);
    if (overlay && overlay.kind === "ssh-tmux") {
      // User explicitly aliased "local" to a remote endpoint. Honor it.
      return getOrCache(sshCacheKey(overlay), () => createSshTmuxSubstrate({ node: overlay }));
    }
    return localSubstrate();
  }

  const node = loadNodeSync(resolved);
  if (!node) {
    throw new Error(`Unknown node: ${resolved}. Register it with: hive node register ${resolved} --kind ssh-tmux --endpoint user@host`);
  }
  return substrateForRecord(node);
}

export function substrateForRecord(node: NodeRecord): Substrate {
  if (node.kind === "local-tmux") {
    return getOrCache(`local-tmux::${node.name}`, createLocalTmuxSubstrate);
  }
  if (node.kind === "remote-hsr") {
    return getOrCache(remoteHsrCacheKey(node), () => createRemoteHsrSubstrate(node));
  }
  return getOrCache(sshCacheKey(node), () => createSshTmuxSubstrate({ node }));
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
  return getOrCache(remoteHsrCacheKey(node), () => createRemoteHsrSubstrate(node)) as RemoteHsrSubstrate;
}

// Key on the fields that shape the ssh transport (endpoint + ssh command/args)
// plus the runner-host version, so a re-bootstrap or ssh-arg change doesn't leave
// the daemon reusing a stale forwarded socket.
function remoteHsrCacheKey(node: NodeRecord): string {
  return JSON.stringify(["remote-hsr", node.name, node.endpoint, node.sshCommand ?? "", node.sshArgs ?? [], node.runnerHostVersion ?? ""]);
}

// Key on every field that shapes the ssh transport, not just the endpoint:
// `hive node update --ssh-args/--ssh-command` with an unchanged endpoint must
// not leave long-lived processes (the daemon) reusing a stale substrate, and
// two nodes sharing an endpoint must not collapse into one cache entry.
function sshCacheKey(node: NodeRecord): string {
  return JSON.stringify(["ssh-tmux", node.name, node.endpoint, node.sshCommand ?? "", node.sshArgs ?? []]);
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
