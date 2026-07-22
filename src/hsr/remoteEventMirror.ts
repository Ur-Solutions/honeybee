/**
 * Remote event mirror (APIA-94) — the daemon-side bridge that makes a REMOTE
 * HSR bee observable by the LOCAL machinery exactly like a local HSR bee.
 *
 * A remote-hsr bee's SessionRecord carries `node = <remote-hsr node>` and NO
 * local `substrate:"hsr"`, so its structured events live only on the remote's
 * run dir. Today the daemon can only see it through the coarse node-probe path
 * (probe + listSessionStates). This mirror closes that gap: for each LIVE
 * remote-hsr bee it maintains ONE `observe` subscription to that node's remote
 * serve and replays every event into the LOCAL run dir
 * `~/.hive/hsr/<bee>/{events.jsonl,ring.txt}`, plus a `meta.json` marked
 * `mirrorOfNode` (see runDir.ts HsrMeta). The existing local readers then work
 * unchanged:
 *   - usage sampler   — exact tokens + exhaustion from the mirrored `usage`/
 *                       `exhausted` events (APIA-86 path).
 *   - deriveState     — finer structured state (active/idle/blocked) than the
 *                       node-probe's coarse @hive_state.
 *   - Apiary capture  — ring.txt/events.jsonl are the live console fallback the
 *                       daemon socket already serves (APIA-83), now for remote
 *                       bees too.
 *
 * Lifecycle (idempotent, never throws — per-bee errors are captured):
 *   subscribe — a live remote bee with no mirror yet gets ONE observe
 *               subscription; a `running` mirror meta is written first so the
 *               local readers pick it up immediately.
 *   append    — each relayed event → appendHsrEvent + (for `text`) a bounded
 *               ring.txt (debounced), reusing the same ring bounding as the
 *               local stream runner.
 *   teardown  — when the bee leaves the node's live list (or its record/node is
 *               gone) the subscription is torn down and the mirror meta flips to
 *               "exited" so deriveState settles it dead/sealed.
 *   dedupe    — one subscription per bee; a repeated tick never double-subscribes.
 *   reconnect — the transport re-adopts the local hsr.event bridge across tunnel
 *               drops (remoteTransport.ts) and the substrate re-issues the
 *               remote `observe` RPC on reconnect so a RESTARTED serve rebuilds
 *               its relays (remote-hsr.ts, HIVE-11) — no re-arm needed here.
 *
 * NATIVE-TRANSCRIPT SHIPPING — DEFERRED (follow-up). Full provider-JSONL
 * shipping (so Apiary's capture host resolves a remote bee's native transcript
 * file locally) is a larger effort. For THIS issue the mirrored events.jsonl /
 * ring.txt ARE the local truth (they power console + state + usage); native
 * transcript shipping is a separate unit.
 *
 * Node builtins + local HSR/substrate modules only.
 */

import { loadNode as defaultLoadNode, LOCAL_NODE_NAME, type NodeRecord } from "../node.js";
import { remoteHsrSubstrateForNode, type RemoteHsrSubstrate } from "../substrates/index.js";
import type { SessionRecord } from "../store.js";
import {
  appendHsrEvent,
  appendRingText,
  ensureHsrRunDir,
  readHsrMeta,
  writeHsrMeta,
  writeHsrRing,
  type HsrMeta,
} from "./runDir.js";
import { readEventTail } from "./observe.js";
import type { RunnerEvent } from "./types.js";

/** Debounce ring.txt writes so a chatty remote bee does not thrash the disk. */
const RING_DEBOUNCE_MS = 50;

export type RemoteEventMirrorDeps = {
  /** Resolve a node record by name (injected in tests). */
  loadNode?: (name: string) => Promise<NodeRecord | null>;
  /** Build the typed remote-hsr substrate for a node (injected in tests). */
  createSubstrate?: (node: NodeRecord) => RemoteHsrSubstrate;
  now?: () => number;
};

export type RemoteEventMirrorDispatcher = {
  (records: SessionRecord[]): Promise<void>;
  close(): Promise<void>;
};

/** One live mirror: its node, unsubscribe fn, and in-memory ring state. */
type MirrorEntry = {
  node: string;
  off: () => void;
  ring: string;
  ringTimer: NodeJS.Timeout | null;
  /**
   * While the post-attach backfill runs, live events are buffered here instead
   * of appended, so the backfilled tail and the live stream can be merged
   * without duplicates. `null` once armed (backfill done) — the steady state.
   */
  pending: RunnerEvent[] | null;
};

type SubstrateEntry = {
  signature: string;
  substrate: RemoteHsrSubstrate;
};

/** A record bound to a remote-hsr node (non-local, kind === "remote-hsr"). */
function remoteNodeName(record: SessionRecord): string | undefined {
  const node = record.node;
  if (!node || node === LOCAL_NODE_NAME) return undefined;
  // A record already routed to the LOCAL hsr substrate is never a remote mirror.
  if (record.substrate === "hsr") return undefined;
  return node;
}

function isRunnerEvent(value: unknown): value is RunnerEvent {
  return !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}

function substrateSignature(node: NodeRecord): string {
  return JSON.stringify(["remote-hsr", node.name, node.endpoint, node.sshCommand ?? "", node.sshArgs ?? [], node.runnerHostVersion ?? ""]);
}

/**
 * Build the stateful per-tick mirror dispatcher. Call {@link createRemoteEventMirror}
 * ONCE per daemon run so subscriptions persist across ticks; invoke the returned
 * function every tick with the current SessionRecords.
 */
export function createRemoteEventMirror(deps: RemoteEventMirrorDeps = {}): RemoteEventMirrorDispatcher {
  const loadNode = deps.loadNode ?? defaultLoadNode;
  const createSubstrate = deps.createSubstrate ?? remoteHsrSubstrateForNode;
  const now = deps.now ?? (() => Date.now());

  // Live subscriptions, keyed by bee name. A reserved-then-populated entry
  // prevents a double-subscribe within a single tick's async setup.
  const mirrors = new Map<string, MirrorEntry>();
  // One resilient substrate per node, reused across ticks (its transport client
  // is lazy + reconnecting internally).
  const substrates = new Map<string, SubstrateEntry>();

  async function closeSubstrate(nodeName: string): Promise<void> {
    const entry = substrates.get(nodeName);
    if (!entry) return;
    substrates.delete(nodeName);
    await entry.substrate.close().catch(() => undefined);
  }

  async function substrateForNode(node: NodeRecord): Promise<RemoteHsrSubstrate> {
    const signature = substrateSignature(node);
    const existing = substrates.get(node.name);
    if (existing && existing.signature === signature) return existing.substrate;
    if (existing) {
      await teardownNodeMirrors(node.name, false);
      await closeSubstrate(node.name);
    }
    const substrate = createSubstrate(node);
    substrates.set(node.name, { signature, substrate });
    return substrate;
  }

  function scheduleRingWrite(bee: string, entry: MirrorEntry): void {
    if (entry.ringTimer) return;
    entry.ringTimer = setTimeout(() => {
      entry.ringTimer = null;
      void writeHsrRing(bee, entry.ring).catch(() => undefined);
    }, RING_DEBOUNCE_MS);
  }

  function appendMirrored(bee: string, entry: MirrorEntry, event: RunnerEvent): void {
    // The runner is the single writer locally too — appendHsrEvent serializes
    // per bee, so mirrored events land in production order.
    void appendHsrEvent(bee, event).catch(() => undefined);
    if (event.type === "text" && typeof event.text === "string" && event.text.length > 0) {
      entry.ring = appendRingText(entry.ring, event.text);
      scheduleRingWrite(bee, entry);
    }
  }

  function onEvent(bee: string, entry: MirrorEntry, raw: unknown): void {
    if (!isRunnerEvent(raw)) return;
    // Backfill in flight: hold the live event until the remote tail is merged,
    // so an event present in both never lands twice.
    if (entry.pending !== null) {
      entry.pending.push(raw);
      return;
    }
    appendMirrored(bee, entry, raw);
  }

  /**
   * Merge the remote events.jsonl tail into the local mirror file. Events
   * emitted between spawn and the first mirror tick predate the observe
   * subscription and would otherwise be lost locally (they exist only on the
   * remote). Boundary discipline: only events with ts strictly greater than the
   * newest local ts are appended, and live events buffered during the backfill
   * are flushed through the same boundary — dedupe is by timestamp, which the
   * runner stamps monotonically enough per bee (same-ms boundary collisions are
   * the accepted residual, versus losing the whole pre-attach tail today).
   */
  async function backfill(bee: string, entry: MirrorEntry, substrate: RemoteHsrSubstrate): Promise<void> {
    let boundary = 0;
    try {
      // A daemon restart re-arms mirrors for bees whose local file already has
      // history — resume after the newest local event instead of re-fetching.
      const local = await readEventTail(bee);
      for (const event of local) {
        if (typeof event.ts === "number" && event.ts > boundary) boundary = event.ts;
      }
      const missed = await substrate.eventsTail(bee, boundary > 0 ? boundary : undefined);
      for (const event of missed) {
        if (!isRunnerEvent(event)) continue;
        if (typeof event.ts === "number") {
          if (event.ts <= boundary) continue;
          boundary = event.ts;
        }
        appendMirrored(bee, entry, event);
      }
    } catch {
      // Transient tunnel failure or an older runner-host without the events
      // RPC: live events still flow; only the pre-attach tail stays remote.
    } finally {
      const buffered = entry.pending ?? [];
      entry.pending = null; // armed — onEvent appends directly from here on.
      for (const event of buffered) {
        if (typeof event.ts === "number" && event.ts <= boundary) continue;
        appendMirrored(bee, entry, event);
      }
    }
  }

  async function writeMirrorMeta(bee: string, node: string, status: "running" | "exited"): Promise<void> {
    const existing = await readHsrMeta(bee).catch(() => null);
    const meta: HsrMeta = {
      bee,
      harness: existing?.harness ?? "",
      tier: existing?.tier ?? "stream",
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      hostPid: 0, // sentinel: a mirror has no local host (see runDir.ts HsrMeta)
      startedAt: existing?.startedAt ?? new Date(now()).toISOString(),
      controlSocket: "",
      status,
      mirrorOfNode: node,
      ...(status === "exited" ? { endedAt: new Date(now()).toISOString() } : {}),
    };
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, meta);
  }

  async function ensureMirror(node: NodeRecord, substrate: RemoteHsrSubstrate, bee: string): Promise<void> {
    if (mirrors.has(bee)) return; // already mirrored — dedupe.
    // Reserve the slot BEFORE the async observe so a re-entrant call this tick
    // can't double-subscribe.
    const entry: MirrorEntry = { node: node.name, off: () => undefined, ring: "", ringTimer: null, pending: [] };
    mirrors.set(bee, entry);
    // Seed a `running` mirror meta so the local readers see the bee at once,
    // even before the first event arrives.
    await writeMirrorMeta(bee, node.name, "running").catch(() => undefined);
    try {
      entry.off = await substrate.observe(bee, (event) => onEvent(bee, entry, event));
    } catch {
      // Subscribe failed (transient tunnel / no live host): drop the reservation
      // so a later tick retries. The `running` meta stays — it flips to exited
      // once the bee genuinely leaves the remote list.
      mirrors.delete(bee);
      return;
    }
    // Recover the pre-attach tail (spawn → first mirror tick) before going live.
    await backfill(bee, entry, substrate).catch(() => undefined);
  }

  async function teardown(bee: string, entry: MirrorEntry, options: { markExited: boolean }): Promise<void> {
    try {
      entry.off();
    } catch {
      // best-effort
    }
    if (entry.ringTimer) {
      clearTimeout(entry.ringTimer);
      entry.ringTimer = null;
      await writeHsrRing(bee, entry.ring).catch(() => undefined);
    }
    mirrors.delete(bee);
    if (options.markExited) {
      // Flip the mirror meta to exited so deriveState settles it dead/sealed.
      await writeMirrorMeta(bee, entry.node, "exited").catch(() => undefined);
    }
  }

  async function teardownNodeMirrors(nodeName: string, markExited: boolean): Promise<void> {
    for (const [bee, entry] of [...mirrors]) {
      if (entry.node === nodeName) await teardown(bee, entry, { markExited });
    }
  }

  async function close(): Promise<void> {
    for (const [bee, entry] of [...mirrors]) {
      await teardown(bee, entry, { markExited: false });
    }
    await Promise.all([...substrates.keys()].map((nodeName) => closeSubstrate(nodeName)));
  }

  const dispatch: RemoteEventMirrorDispatcher = Object.assign(async (records: SessionRecord[]): Promise<void> => {
    // Group the remote-hsr records by node so we call listSessions once per node.
    const byNode = new Map<string, SessionRecord[]>();
    for (const record of records) {
      const node = remoteNodeName(record);
      if (!node) continue;
      const list = byNode.get(node);
      if (list) list.push(record);
      else byNode.set(node, [record]);
    }

    // The set of bees that SHOULD be mirrored after this tick (record present +
    // node still remote-hsr + live per the node's remote list).
    const wanted = new Set<string>();

    for (const [nodeName, nodeRecords] of byNode) {
      let node: NodeRecord | null;
      try {
        node = await loadNode(nodeName);
      } catch {
        node = null;
      }
      if (!node || node.kind !== "remote-hsr") {
        await teardownNodeMirrors(nodeName, true);
        await closeSubstrate(nodeName);
        continue;
      }
      const substrate = await substrateForNode(node);
      let liveBees: Set<string>;
      try {
        liveBees = new Set(await substrate.listSessions());
      } catch {
        // Tunnel down this tick: don't tear existing mirrors down (the transport
        // is reconnecting) and don't add new ones. Keep what we have.
        for (const record of nodeRecords) {
          if (mirrors.has(record.name)) wanted.add(record.name);
        }
        continue;
      }
      for (const record of nodeRecords) {
        if (!liveBees.has(record.name)) continue;
        wanted.add(record.name);
        await ensureMirror(node, substrate, record.name);
      }
    }

    // Teardown pass: any active mirror not wanted this tick (bee left the remote
    // list, or its record/node disappeared) is unsubscribed + marked exited.
    for (const [bee, entry] of [...mirrors]) {
      if (!wanted.has(bee)) await teardown(bee, entry, { markExited: true });
    }
    const activeMirrorNodes = new Set([...mirrors.values()].map((entry) => entry.node));
    for (const nodeName of [...substrates.keys()]) {
      if (!byNode.has(nodeName) && !activeMirrorNodes.has(nodeName)) await closeSubstrate(nodeName);
    }
  }, { close });

  return dispatch;
}
