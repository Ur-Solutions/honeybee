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
import type { DeliveredCredentials } from "../hsr/remoteCreds.js";
import type { RunnerEvent } from "../hsr/types.js";
import {
  connectRemoteRunnerHost,
  type ConnectRemoteOptions,
  type RemoteRunnerClient,
} from "../hsr/remoteTransport.js";
import type {
  KillResult,
  NewSessionResult,
  ProbeResult,
  SendTextOptions,
  Substrate,
  TmuxWindowOptions,
} from "./types.js";

/** Short per-call budget for the tick-facing calls (probe/liveness/list). */
const PROBE_TIMEOUT_MS = 2_500;

/** A clone can be slow (network + checkout), so provision gets a long budget. */
const PROVISION_TIMEOUT_MS = 120_000;
/** A token refresh stops + re-delivers + restarts + resumes a codex boot — moderate budget. */
const REFRESH_TIMEOUT_MS = 60_000;
/** listCheckouts shells git across several dirs — a moderate budget over probe. */
const LIST_CHECKOUTS_TIMEOUT_MS = 15_000;

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
  /**
   * The bee's working dir. OMITTED for a plain remote-hsr spawn — a local path
   * doesn't exist on the node (spawn() ENOENT), so the remote derives a per-bee
   * cwd under its own storeRoot. Sent ONLY when it is already a real REMOTE path:
   * a provisioned checkout (APIA-95).
   */
  cwd?: string;
  sessionId?: string;
  resume?: boolean;
  authKind?: "subscription" | "api-key";
  model?: string;
  comb?: string;
  parent?: string;
  /**
   * APIA-93 ephemeral credential material (opaque, base64 in transit) delivered
   * into the remote isolated home at spawn and shredded on kill. Only present
   * for an account-bound spawn on an ephemeral-token node. NEVER logged.
   */
  creds?: DeliveredCredentials;
  /**
   * Isolated-home override. Normally OMITTED — the remote derives the harness
   * home under its own storeRoot (a local path is meaningless on the node) and
   * writes delivered credentials there. An explicit REMOTE path is honored as-is
   * (tests inject one). Only relevant when `creds` carry files.
   */
  home?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

export type RemoteSpawnResult = { bee: string; tier?: string; sessionId?: string; cwd?: string };

/**
 * UNIT 2 token refresh: re-deliver a FRESH ephemeral credential to a LIVE remote
 * bee and have the runner adopt it (stop → shred old → write new → restart with
 * resume). Only the fresh credential material crosses the wire — the vault stays
 * local. Never logged.
 */
export type RemoteRefreshCredsParams = { bee: string; creds: DeliveredCredentials };
export type RemoteRefreshCredsResult = { ok: boolean; sessionId?: string; error?: string };

/**
 * APIA-95 working-copy provisioning params/result. Clone (or idempotently reuse)
 * a git checkout ON THE REMOTE under its `<storeRoot>/worktrees/<name>`, then run
 * the bee inside it. Groundwork for Apiary's "where-it-lives" selector on
 * non-local substrates (substrates-research §5.3 / architecture §7.5).
 */
export type RemoteProvisionParams = { repo: string; branch?: string; name?: string; ref?: string };
export type RemoteProvisionResult = { path: string; repo: string; branch?: string; reused: boolean };

/** A row of the remote `listCheckouts` RPC (a provisioned git checkout on the node). */
export type RemoteCheckoutRow = {
  name: string;
  path: string;
  repo: string | null;
  branch: string | null;
  dirty?: boolean;
};

/**
 * The Substrate returned for a `remote-hsr` node, plus the two verbs the tmux
 * Substrate interface has no slot for: {@link spawnRemote} (the spawn path calls
 * it after resolving the AgentSpec locally) and {@link observe} (relayed event
 * stream), and {@link close} for teardown.
 */
export type RemoteHsrSubstrate = Substrate & {
  /**
   * Live handshake against the remote runner-host `ping` (APIA-96): `{ ok }` plus
   * the runner-host `version` string (`runner-host <core>`) when the serve is
   * reachable. `hive node status` times this and reads the version/drift from it;
   * a down tunnel resolves `{ ok:false, reason }` (never throws).
   */
  ping(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  spawnRemote(params: RemoteSpawnParams): Promise<RemoteSpawnResult>;
  /**
   * UNIT 2: re-deliver a fresh ephemeral credential to a live bee and restart its
   * runner with resume so it adopts the new token. Never throws — a down tunnel /
   * failed restart resolves `{ ok:false, reason/error }`.
   */
  refreshCredsRemote(params: RemoteRefreshCredsParams): Promise<RemoteRefreshCredsResult>;
  /**
   * APIA-95: clone (or idempotently reuse) a working copy on the remote and
   * return its path — the spawn path uses it as the bee's cwd.
   */
  provisionRemote(params: RemoteProvisionParams): Promise<RemoteProvisionResult>;
  /** APIA-95: enumerate existing checkouts on the remote node. */
  listCheckouts(): Promise<RemoteCheckoutRow[]>;
  /** Subscribe to a bee's relayed event stream. Returns an unsubscribe fn. */
  observe(bee: string, onEvent: (event: unknown) => void): Promise<() => void>;
  /**
   * The bounded events.jsonl tail for a bee on the node — optionally only events
   * strictly newer than `afterTs` (epoch ms). The daemon's event mirror uses it
   * to backfill events emitted before its observe subscription attached. Never
   * throws — a down tunnel or an older runner-host (no `events` RPC) resolves [].
   */
  eventsTail(bee: string, afterTs?: number): Promise<RunnerEvent[]>;
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
    case "queued":
    case "booting":
    case "active":
      return "working";
    case "ready":
    case "blocked":
    case "auth-needed":
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

  // Observed bees (refcounted across subscribers). The remote relay behind the
  // `observe` RPC lives only in the serve process's memory — if that process
  // restarts (crash/OOM/redeploy), the transport reconnects and re-adopts the
  // local `hsr.event` bridge, but the fresh serve has an EMPTY relay map and
  // would never broadcast again (HIVE-11). So we track what we observe and
  // re-issue the observe RPC on every transport `reconnect`.
  const observed = new Map<string, number>();

  async function reobserve(c: RemoteRunnerClient): Promise<void> {
    for (const [bee, count] of [...observed]) {
      try {
        // `sync` makes the remote SET its relay refcount to our subscriber
        // count: against a surviving serve a plain observe would inflate the
        // count past what our unobserve calls return (HIVE-56); against a
        // restarted serve it re-creates the relay with the right count.
        // `ok:false` (bee gone) is left to the mirror's teardown pass; a
        // thrown call (tunnel flapped again) is retried by the next reconnect.
        await c.call("observe", { bee, sync: count });
      } catch {
        return;
      }
    }
  }

  // Lazily establish ONE resilient client per node (reused by the daemon tick,
  // steer, observe). A failed establish is NOT cached — the next call retries,
  // so a transient tunnel drop never wedges the substrate. Caching a client that
  // later goes 'down' is safe too: its call()/on() kick a fresh reconnect, so
  // the memoized client self-heals once the network recovers (HIVE-9).
  let clientPromise: Promise<RemoteRunnerClient> | undefined;
  function client(): Promise<RemoteRunnerClient> {
    if (!clientPromise) {
      clientPromise = connect(node, deps)
        .then((c) => {
          c.on("reconnect", () => void reobserve(c));
          return c;
        })
        .catch((error) => {
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

  async function ping(): Promise<{ ok: boolean; version?: string; reason?: string }> {
    try {
      const c = await client();
      const res = (await c.call("ping", undefined, { timeoutMs: PROBE_TIMEOUT_MS })) as
        | { ok?: boolean; version?: string }
        | null;
      if (res && res.ok === false) return { ok: false, reason: "remote serve reported not-ok" };
      return { ok: true, ...(res && typeof res.version === "string" ? { version: res.version } : {}) };
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

  async function eventsTail(bee: string, afterTs?: number): Promise<RunnerEvent[]> {
    try {
      const c = await client();
      const res = (await c.call("events", afterTs === undefined ? { bee } : { bee, afterTs })) as
        | { ok?: boolean; events?: unknown }
        | null;
      if (res?.ok && Array.isArray(res.events)) return res.events as RunnerEvent[];
      return [];
    } catch {
      return [];
    }
  }

  async function sendText(bee: string, text: string, _paneId?: string, options?: SendTextOptions): Promise<void> {
    const c = await client();
    const res = (await c.call("send", {
      bee,
      text,
      ...(options?.mode === "next-tool" ? { mode: "next-tool" } : {}),
    })) as { ok?: boolean; error?: string } | null;
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
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      ...(params.resume ? { resume: true } : {}),
      ...(params.authKind ? { authKind: params.authKind } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.comb ? { comb: params.comb } : {}),
      ...(params.parent ? { parent: params.parent } : {}),
      ...(params.creds ? { creds: params.creds } : {}),
      ...(params.home ? { home: params.home } : {}),
      spec: params.spec,
    })) as { ok?: boolean; bee?: string; tier?: string; cwd?: string; error?: string } | null;
    if (!res || !res.ok) {
      throw new Error(`remote HSR spawn of ${params.bee} on ${node.name} failed: ${res?.error ?? "unknown"}`);
    }
    return {
      bee: res.bee ?? params.bee,
      ...(res.tier ? { tier: res.tier } : {}),
      ...(typeof res.cwd === "string" && res.cwd ? { cwd: res.cwd } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    };
  }

  async function refreshCredsRemote(params: RemoteRefreshCredsParams): Promise<RemoteRefreshCredsResult> {
    try {
      const c = await client();
      const res = (await c.call("refreshCreds", { bee: params.bee, creds: params.creds }, { timeoutMs: REFRESH_TIMEOUT_MS })) as
        | { ok?: boolean; sessionId?: string; error?: string }
        | null;
      if (res && res.ok) return { ok: true, ...(typeof res.sessionId === "string" && res.sessionId ? { sessionId: res.sessionId } : {}) };
      return { ok: false, error: res?.error ?? "remote refreshCreds failed" };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  }

  async function provisionRemote(params: RemoteProvisionParams): Promise<RemoteProvisionResult> {
    const c = await client();
    const res = (await c.call(
      "provision",
      {
        repo: params.repo,
        ...(params.branch ? { branch: params.branch } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.ref ? { ref: params.ref } : {}),
      },
      { timeoutMs: PROVISION_TIMEOUT_MS },
    )) as { ok?: boolean; path?: string; repo?: string; branch?: string; reused?: boolean; error?: string } | null;
    if (!res || !res.ok || typeof res.path !== "string") {
      throw new Error(`remote HSR provision on ${node.name} failed: ${res?.error ?? "unknown"}`);
    }
    return {
      path: res.path,
      repo: res.repo ?? params.repo,
      ...(res.branch ? { branch: res.branch } : {}),
      reused: Boolean(res.reused),
    };
  }

  async function listCheckouts(): Promise<RemoteCheckoutRow[]> {
    const c = await client();
    const rows = await c.call("listCheckouts", undefined, { timeoutMs: LIST_CHECKOUTS_TIMEOUT_MS });
    return Array.isArray(rows) ? (rows as RemoteCheckoutRow[]) : [];
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
    observed.set(bee, (observed.get(bee) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
      const count = observed.get(bee) ?? 0;
      if (count <= 1) observed.delete(bee);
      else observed.set(bee, count - 1);
      // Release the remote side too (HIVE-56): decrement the serve's relay
      // refcount so the last unsubscribe closes its connection to the bee's
      // control socket. Best-effort and fire-and-forget — if the tunnel is
      // down the next reconnect's `sync` reconciles the count anyway. Reuses
      // the memoized client only; never opens a connection just to release.
      void clientPromise?.then((c) => c.call("unobserve", { bee })).catch(() => undefined);
    };
  }

  return {
    kind: "remote-hsr",
    node: node.name,
    endpoint: node.endpoint,
    // The remote runner host sees tool events inline; the mode forwards over
    // the send RPC, so a next-tool hold works exactly as it does locally.
    supportsNextTool: true,
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
    ping,
    spawnRemote,
    refreshCredsRemote,
    provisionRemote,
    listCheckouts,
    observe,
    eventsTail,
    async close(): Promise<void> {
      const releasing = [...observed];
      observed.clear();
      if (!clientPromise) return;
      const pending = clientPromise;
      clientPromise = undefined;
      await pending
        .then(async (c) => {
          // Best-effort: release every relay we still hold before dropping the
          // connection, so the serve's per-bee clients don't outlive us (HIVE-56).
          for (const [bee, count] of releasing) {
            await c.call("unobserve", { bee, count }).catch(() => undefined);
          }
          c.close();
        })
        .catch(() => undefined);
    },
  };
}
