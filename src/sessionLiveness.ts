import { LOCAL_NODE_NAME } from "./node.js";
import type { SessionRecord } from "./store.js";
import { localSubstrate, substrateFor, type Substrate } from "./substrates/index.js";

export type SessionLivenessOptions = {
  substrate?: Pick<Substrate, "hasSession">;
  localPanes?: () => Promise<Set<string>>;
};

/** Return a source-of-truth runtime failure, or null while the session is live. */
export async function sessionLivenessFailure(record: SessionRecord, options: SessionLivenessOptions = {}): Promise<string | null> {
  const substrate = options.substrate ?? substrateFor(record);
  if (!(await substrate.hasSession(record.tmuxTarget))) {
    return record.substrate === "hsr"
      ? `runner is not running: ${record.tmuxTarget}`
      : `tmux session is not running: ${record.tmuxTarget}`;
  }

  const isLocal = !record.node || record.node === LOCAL_NODE_NAME;
  if (isLocal && record.agentPaneId) {
    const panes = await (options.localPanes ?? (() => localSubstrate().listPanes()))();
    if (!panes.has(record.agentPaneId)) {
      return `tmux pane is not running for ${record.name}: ${record.agentPaneId}`;
    }
  }
  return null;
}

export async function ensureSessionLive(record: SessionRecord): Promise<void> {
  const failure = await sessionLivenessFailure(record);
  if (failure) throw new Error(failure);
}
