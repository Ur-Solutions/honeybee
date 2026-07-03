/**
 * Remote HSR substrate (APIA-92) — the LOCAL Substrate that drives HSR bees on a
 * `remote-hsr` node over the forwarded runner-host socket.
 *
 * It mirrors the shape of ssh-tmux.ts (a remote Substrate) but delegates over the
 * runner-host JSON-RPC control plane (connectRemoteRunnerHost — see
 * remoteTransport.ts) instead of tmux. A remote-hsr bee is NOT a local HSR bee:
 * its SessionRecord carries `node = <remote-hsr node>` and NO `substrate:"hsr"`,
 * so substrateFor(record) routes it here by node.kind — and the daemon tick +
 * `hive bees` observe it purely through the node-probe path (probe() +
 * listSessionStates()), exactly like ssh-tmux, with no special-casing.
 *
 * The runner host itself lives ON the remote (forked by its serve on `spawn`);
 * this side only forwards steer/observe/kill calls and reads liveness/list back.
 * Spawn resolves the AgentSpec LOCALLY and hands the resolved spec to the remote
 * `spawn` RPC (no resolveAgent on the remote) via {@link RemoteHsrSubstrate.spawnRemote}.
 *
 * The ssh WIRE between this substrate and the remote serve is stood in for tests
 * by a direct/relayed socket (injectable transport deps); real loopback ssh e2e
 * is APIA-98. Credential delivery to the remote home is APIA-93 — for now the
 * remote uses its own home's auth (for a loopback remote that IS this machine).
 *
 * Node builtins only.
 */

import type { NodeRecord } from "../node.js";
import type { BeeState } from "../state.js";
import {
  connectRemoteRunnerHost,
  type ConnectRemoteOptions,
  type RemoteRunnerClient,
} from "../hsr/remoteTransport.js";
import type {
  KillResult,
  NewSessionResult,
  ProbeResult,
  Substrate,
  TmuxWindowOptions,
} from "./types.js";

/** Short per-call budget for the tick-facing calls (probe/liveness/list). */
const PROBE_TIMEOUT_MS = 2_500;

/** A row of the remote `list` RPC (see remoteHost.ts buildController.list). */
type RemoteListRow = {
  bee: string;
  live: boolean;
  state: BeeState | null;
  tier: string | null;
  sessionId: string | null;
  status: string | null;
  controlSocket: string | null;
};

export type RemoteSpawnParams = {
  bee: string;
  kind: string;
  cwd: string;
  sessionId?: string;
  resume?: boolean;
  authKind?: "subscription" | "api-key";
  model?: string;
  comb?: string;
  parent?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

export type RemoteSpawnResult = { bee: string; tier?: string; sessionId?: string };

/**
 * The Substrate returned for a `remote-hsr` node, plus the two verbs the tmux
 * Substrate interface has no slot for: {@link spawnRemote} (the spawn path calls
 * it after resolving the AgentSpec locally) and {@link observe} (relayed event
 * stream), and {@link close} for teardown.
 */
export type RemoteHsrSubstrate = Substrate & {
  spawnRemote(params: RemoteSpawnParams): Promise<RemoteSpawnResult>;
  /** Subscribe to a bee's relayed event stream. Returns an unsubscribe fn. */
  observe(bee: string, onEvent: (event: unknown) => void): Promise<() => void>;
  /** Tear down the cached transport client (tests / shutdown). */
  close(): Promise<void>;
};

export type RemoteHsrSubstrateOptions = {
  /** Injectable transport deps (tests point these at an in-process serve). */
  transport?: ConnectRemoteOptions;
  /** Full override of the transport factory (tests). */
  connect?: (node: NodeRecord, opts: ConnectRemoteOptions) => Promise<RemoteRunnerClient>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coarse @hive_state (working|waiting|done|failed) for a structured BeeState.
 * Inlined (mirrors hiveState.ts hiveStateFor) to keep this module off the
 * hiveState → substrates import cycle. Empty string = no override.
 */
function coarseHiveState(state: BeeState | null): string {
  switch (state) {
    case "booting":
    case "active":
      return "working";
    case "ready":
    case "blocked":
      return "waiting";
    case "idle_with_output":
    case "sealed":
      return "done";
    case "error":
    case "kill_failed":
      return "failed";
    default:
      return "";
  }
}

export function createRemoteHsrSubstrate(
  node: NodeRecord,
  options: RemoteHsrSubstrateOptions = {},
): RemoteHsrSubstrate {
  if (node.kind !== "remote-hsr") {
    throw new Error(`createRemoteHsrSubstrate requires kind=remote-hsr, got ${node.kind}`);
  }
  const connect = options.connect ?? connectRemoteRunnerHost;
  const deps = options.transport ?? {};

  // Lazily establish ONE resilient client per node (reused by the daemon tick,
  // steer, observe). A failed establish is NOT cached — the next call retries,
  // so a transient tunnel drop never wedges the substrate.
  let clientPromise: Promise<RemoteRunnerClient> | undefined;
  function client(): Promise<RemoteRunnerClient> {
    if (!clientPromise) {
      clientPromise = connect(node, deps).catch((error) => {
        clientPromise = undefined;
        throw error;
      });
    }
    return clientPromise;
  }

  async function callList(): Promise<RemoteListRow[]> {
    const c = await client();
    const rows = await c.call("list", undefined, { timeoutMs: PROBE_TIMEOUT_MS });
    return Array.isArray(rows) ? (rows as RemoteListRow[]) : [];
  }

  async function probe(): Promise<ProbeResult> {
    try {
      const c = await client();
      const res = (await c.call("ping", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as { ok?: boolean } | null;
      if (res && res.ok === false) return { ok: false, reason: "remote serve reported not-ok" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: messageOf(error) };
    }
  }

  async function hasSession(bee: string): Promise<boolean> {
    // Throws on transport failure (tunnel down) so callers (transactionalKill,
    // clean --dead) don't delete records of live bees on an unreachable node —
    // mirrors ssh-tmux.hasSession's ssh-255 discipline.
    const c = await client();
    const live = (await c.call("liveness", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as Record<string, boolean> | null;
    return Boolean(live && live[bee] === true);
  }

  async function capture(bee: string, lines?: number): Promise<string> {
    try {
      const c = await client();
      const res = (await c.call("snapshot", typeof lines === "number" ? { bee, lines } : { bee })) as
        | { ok?: boolean; result?: unknown }
        | null;
      if (res && res.ok && typeof res.result === "string") return res.result;
      return "";
    } catch {
      return "";
    }
  }

  async function sendText(bee: string, text: string): Promise<void> {
    const c = await client();
    const res = (await c.call("send", { bee, text })) as { ok?: boolean; error?: string } | null;
    if (!res || !res.ok) throw new Error(`remote HSR send to ${bee} on ${node.name} failed: ${res?.error ?? "unknown"}`);
  }

  async function kill(bee: string): Promise<KillResult> {
    try {
      const c = await client();
      const res = (await c.call("kill", { bee })) as
        | { ok?: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }
        | null;
      if (res && res.ok) {
        return { ok: true, stdout: res.stdout ?? "", stderr: res.stderr ?? "", exitCode: res.exitCode ?? 0 };
      }
      return { ok: false, stdout: "", stderr: res?.error ?? "remote kill failed", exitCode: 1 };
    } catch (error) {
      return { ok: false, stdout: "", stderr: messageOf(error), exitCode: 1 };
    }
  }

  async function listSessions(): Promise<string[]> {
    try {
      return (await callList()).filter((row) => row.live).map((row) => row.bee);
    } catch {
      return [];
    }
  }

  async function listSessionStates(): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    // Never throws: a down tunnel yields an empty map (bees read as gone this
    // tick) exactly as ssh-tmux does on a failed list-sessions.
    let rows: RemoteListRow[];
    try {
      rows = await callList();
    } catch {
      return states;
    }
    for (const row of rows) {
      if (!row.live) continue;
      states.set(row.bee, coarseHiveState(row.state));
    }
    return states;
  }

  async function spawnRemote(params: RemoteSpawnParams): Promise<RemoteSpawnResult> {
    const c = await client();
    const res = (await c.call("spawn", {
      bee: params.bee,
      kind: params.kind,
      cwd: params.cwd,
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.resume ? { resume: true } : {}),
      ...(params.authKind ? { authKind: params.authKind } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.comb ? { comb: params.comb } : {}),
      ...(params.parent ? { parent: params.parent } : {}),
      spec: params.spec,
    })) as { ok?: boolean; bee?: string; tier?: string; error?: string } | null;
    if (!res || !res.ok) {
      throw new Error(`remote HSR spawn of ${params.bee} on ${node.name} failed: ${res?.error ?? "unknown"}`);
    }
    return {
      bee: res.bee ?? params.bee,
      ...(res.tier ? { tier: res.tier } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
  }

  async function observe(bee: string, onEvent: (event: unknown) => void): Promise<() => void> {
    const c = await client();
    const off = c.on("hsr.event", (params) => {
      const p = (params ?? {}) as { bee?: unknown; event?: unknown };
      if (String(p.bee ?? "") === bee) onEvent(p.event);
    });
    const res = (await c.call("observe", { bee })) as { ok?: boolean; error?: string } | null;
    if (!res || !res.ok) {
      off();
      throw new Error(`remote HSR observe of ${bee} on ${node.name} failed: ${res?.error ?? "unknown"}`);
    }
    return off;
  }

  return {
    kind: "remote-hsr",
    node: node.name,
    endpoint: node.endpoint,
    probe,
    hasSession,
    // Spawn goes through spawnRemote (the remote serve forks the runner host), so
    // the tmux newSession verb is never reached — throw to catch a mis-route.
    newSession(): Promise<NewSessionResult> {
      throw new Error("remote HSR bees spawn via the remote runner host, not newSession");
    },
    kill,
    capture,
    sendText,
    // HSR commits a turn atomically in sendText — no separate Enter/keystroke channel.
    async sendEnter(): Promise<void> {
      /* no-op */
    },
    async sendKey(): Promise<void> {
      /* no-op */
    },
    listSessions,
    async listPanes(): Promise<Set<string>> {
      return new Set();
    },
    listSessionStates,
    // Pane/window/user-option verbs are tmux-only; remote HSR bees have no pane.
    async setUserOptions(): Promise<void> {
      /* no-op */
    },
    async setWindowOptions(_target: string, _options: TmuxWindowOptions | undefined): Promise<void> {
      /* no-op */
    },
    async renameWindow(): Promise<void> {
      /* no-op */
    },
    attachCommand(): string[] {
      return [];
    },
    async attachSession(): Promise<void> {
      throw new Error("remote HSR bees have no tmux target; use hive tail/transcript");
    },
    spawnRemote,
    observe,
    async close(): Promise<void> {
      if (!clientPromise) return;
      const pending = clientPromise;
      clientPromise = undefined;
      await pending.then((c) => c.close()).catch(() => undefined);
    },
  };
}
