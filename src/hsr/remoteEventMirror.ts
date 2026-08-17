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
 *               subscription; a non-live/syncing mirror meta is written before
 *               replay and flips to `running` only after exact catch-up.
 *   append    — each relayed event → appendHsrEvent + (for `text`) a bounded
 *               ring.txt persisted before the remote acknowledgement, reusing
 *               the same ring bounding as the local stream runner.
 *   teardown  — when the bee leaves the node's live list (or its record/node is
 *               gone) the subscription is torn down and the mirror meta flips to
 *               "exited" so deriveState settles it dead/done.
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

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../fsx.js";
import {
  LifecycleConflictError,
  withSessionLifecycleTransactionIfPresent,
} from "../lifecycle.js";
import { loadNode as defaultLoadNode, LOCAL_NODE_NAME, type NodeRecord } from "../node.js";
import {
  remoteHsrSubstrateForNode,
  type RemoteHsrSubstrate,
} from "../substrates/index.js";
import type { SessionRecord } from "../store.js";
import {
  isArchivedSessionLifecycle,
  isEventHistoryObservationAdmissible,
} from "../stateMachine.js";
import {
  RemoteObservationDetachedError,
  RemoteObservationIntegrityError,
  type RemoteListRow,
} from "../substrates/remote-hsr.js";
import {
  appendHsrEvent,
  appendRingText,
  ensureHsrRunDir,
  hsrEventsPath,
  hsrRingPath,
  hsrRunDir,
  readHsrMeta,
  readHsrMetaStrict,
  resetHsrMirrorGeneration,
  writeHsrMeta,
  writeHsrRing,
  type HsrMeta,
} from "./runDir.js";
import type { RunnerEvent } from "./types.js";
import { importRemoteHsrEventIntegrityReceipt } from "./eventIntegrity.js";

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
  remoteLaunchId?: string;
  remoteIncarnation?: string;
  off: () => void | Promise<void>;
  ring: string;
  /** Highest remote-origin seq durably appended locally (cursor write may lag). */
  remoteSeq: number;
  record: SessionRecord;
};

type RemoteMirrorCursor = {
  version: 1;
  node: string;
  remoteLaunchId: string;
  remoteIncarnation: string;
  lastSeq: number;
};

const REMOTE_MIRROR_CURSOR_FILE = "remote-events-cursor.json";
const REMOTE_MIRROR_RING_STATE_FILE = "remote-ring-state.json";

function remoteMirrorCursorPath(bee: string): string {
  return join(hsrRunDir(bee), REMOTE_MIRROR_CURSOR_FILE);
}

function remoteMirrorRingStatePath(bee: string): string {
  return join(hsrRunDir(bee), REMOTE_MIRROR_RING_STATE_FILE);
}

type RemoteMirrorRingState = {
  version: 1;
  node: string;
  remoteLaunchId: string;
  remoteIncarnation: string;
  throughRemoteSeq: number;
  text: string;
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

  function exactMirrorGeneration(current: SessionRecord, entry: MirrorEntry): boolean {
    return current.node === entry.node
      && current.remoteLaunchId === entry.remoteLaunchId
      && current.remoteIncarnation === entry.remoteIncarnation;
  }

  function isMirrorIntegrityFence(current: SessionRecord): boolean {
    return current.status === "kill_failed"
      && current.lastError?.startsWith("remote event observation integrity failed:") === true;
  }

  async function withExactMirrorOwner<T>(
    bee: string,
    entry: MirrorEntry,
    fn: (current: SessionRecord) => Promise<T>,
    options: { destructive?: boolean } = {},
  ): Promise<T> {
    try {
      const result = await withSessionLifecycleTransactionIfPresent(entry.record, async (lifecycle) => {
        const run = async (current: SessionRecord) => {
          if (
            !exactMirrorGeneration(current, entry)
            || isArchivedSessionLifecycle(current)
            || !isEventHistoryObservationAdmissible(current)
          ) return { owned: false } as const;
          return { owned: true, value: await fn(current) } as const;
        };
        // Event callbacks mutate an independent projection, not the canonical
        // row. Hold the short canonical record lock across those irreversible
        // file writes anyway: an event-integrity marker either linearizes
        // before this check (and refuses the write) or after every byte lands.
        // No callback that began on stale in-memory admission can append after
        // the canonical fence has committed.
        return options.destructive
          ? lifecycle.destructiveCommit(run)
          : run(await lifecycle.refresh());
      });
      if (!result || !result.owned) {
        throw new RemoteObservationDetachedError(
          `remote mirror generation for ${bee} no longer owns the canonical session`,
        );
      }
      return result.value;
    } catch (error) {
      if (error instanceof RemoteObservationDetachedError) throw error;
      if (error instanceof LifecycleConflictError) {
        throw new RemoteObservationDetachedError(
          `remote mirror generation for ${bee} lost its lifecycle race`,
        );
      }
      throw error;
    }
  }

  async function fenceMirrorIntegrity(bee: string, entry: MirrorEntry, reason: string): Promise<boolean> {
    const detail = `remote event observation integrity failed: ${reason}`;
    try {
      const fenced = await withSessionLifecycleTransactionIfPresent(entry.record, async (lifecycle) => {
        let current = await lifecycle.refresh();
        if (!exactMirrorGeneration(current, entry)) return false;
        if (isArchivedSessionLifecycle(current)) return false;
        if (!isEventHistoryObservationAdmissible(current)) return false;
        if (current.status !== "kill_failed" || current.lastError !== detail) {
          current = await lifecycle.commit({ status: "kill_failed", lastError: detail });
        }
        // Quarantine the derived cache while the same lifecycle lock still
        // excludes retirement/replacement. No late A fence may erase B's files.
        await resetHsrMirrorGeneration(bee);
        await writeMirrorMetaUnchecked(bee, entry.node, "exited", {
          remoteLaunchId: entry.remoteLaunchId,
          remoteIncarnation: entry.remoteIncarnation,
        });
        return current.status === "kill_failed";
      });
      return fenced === true;
    } catch (error) {
      if (error instanceof LifecycleConflictError) return false;
      throw error;
    }
  }

  function cursorRecord(entry: MirrorEntry, lastSeq: number): RemoteMirrorCursor {
    if (!entry.remoteLaunchId || !entry.remoteIncarnation) {
      throw new Error("remote mirror cursor requires exact launch/incarnation authority");
    }
    return {
      version: 1,
      node: entry.node,
      remoteLaunchId: entry.remoteLaunchId,
      remoteIncarnation: entry.remoteIncarnation,
      lastSeq,
    };
  }

  async function persistMirrorCursor(bee: string, entry: MirrorEntry): Promise<void> {
    await atomicWriteFile(
      remoteMirrorCursorPath(bee),
      `${JSON.stringify(cursorRecord(entry, entry.remoteSeq))}\n`,
      { mode: 0o600 },
    );
  }

  async function persistMirrorRingState(bee: string, entry: MirrorEntry): Promise<void> {
    if (!entry.remoteLaunchId || !entry.remoteIncarnation) {
      throw new Error("remote mirror ring state requires exact launch/incarnation authority");
    }
    const state: RemoteMirrorRingState = {
      version: 1,
      node: entry.node,
      remoteLaunchId: entry.remoteLaunchId,
      remoteIncarnation: entry.remoteIncarnation,
      throughRemoteSeq: entry.remoteSeq,
      text: entry.ring,
    };
    await atomicWriteFile(remoteMirrorRingStatePath(bee), `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  async function initialMirrorCursor(
    bee: string,
    entry: MirrorEntry,
  ): Promise<{
    afterSeq: number;
    resetLegacy: boolean;
    persistAfterAuthorization: boolean;
    persistRingAfterAuthorization: boolean;
    ring: string;
  }> {
    let cursor: RemoteMirrorCursor | null = null;
    try {
      const parsed = JSON.parse(await readFile(remoteMirrorCursorPath(bee), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      const candidate = parsed as Partial<RemoteMirrorCursor>;
      if (
        candidate.version !== 1
        || candidate.node !== entry.node
        || candidate.remoteLaunchId !== entry.remoteLaunchId
        || candidate.remoteIncarnation !== entry.remoteIncarnation
        || !Number.isSafeInteger(candidate.lastSeq)
        || Number(candidate.lastSeq) < 0
      ) throw new Error("identity/high-water mismatch");
      cursor = candidate as RemoteMirrorCursor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`local remote-event cursor for ${bee} is unreadable or malformed`, { cause: error });
      }
    }

    let raw = "";
    try {
      raw = await readFile(hsrEventsPath(bee), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`local remote-event mirror for ${bee} is unreadable`, { cause: error });
      }
    }
    const local: RunnerEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as unknown;
        if (!isRunnerEvent(event)) throw new Error("not an event");
        local.push(event);
      } catch (error) {
        throw new Error(`local remote-event mirror for ${bee} is malformed`, { cause: error });
      }
    }
    const originSeqs: number[] = [];
    let compactedThrough = 0;
    let checkpointSeen = false;
    let originSeen = false;
    for (const event of local) {
      if (event.type === "remote_cursor_checkpoint") {
        if (checkpointSeen || originSeen) {
          throw new Error(`local remote-event compaction proof for ${bee} is duplicated or out of order`);
        }
        if (
          event.node !== entry.node
          || event.remoteLaunchId !== entry.remoteLaunchId
          || event.remoteIncarnation !== entry.remoteIncarnation
          || !Number.isSafeInteger(event.throughRemoteSeq)
          || event.throughRemoteSeq <= 0
        ) {
          throw new Error(`local remote-event compaction proof for ${bee} has the wrong generation`);
        }
        checkpointSeen = true;
        compactedThrough = event.throughRemoteSeq;
        continue;
      }
      if (event.remoteSeq === undefined) continue;
      if (!Number.isSafeInteger(event.remoteSeq) || Number(event.remoteSeq) <= 0) {
        throw new Error(`local remote-event mirror for ${bee} contains an invalid origin sequence`);
      }
      originSeen = true;
      originSeqs.push(Number(event.remoteSeq));
    }
    const seen = new Set<number>();
    for (const seq of originSeqs) {
      if (seen.has(seq)) throw new Error(`local remote-event mirror for ${bee} contains duplicate origin seq ${seq}`);
      seen.add(seq);
    }
    // The cursor is an optimization, never evidence. Prove the complete local
    // origin chain independently: absent a compaction checkpoint it starts at
    // one; with a checkpoint the retained suffix starts exactly at through+1.
    // Only after that proof may a lagging cursor be healed to the proven high.
    let lastSeq = compactedThrough;
    for (const seq of originSeqs) {
      if (seq !== lastSeq + 1) {
        throw new Error(
          seq > lastSeq + 1
            ? `local remote-event proof for ${bee} has a gap ${lastSeq + 1}..${seq - 1}`
            : `local remote-event proof for ${bee} is out of order at origin seq ${seq}`,
        );
      }
      lastSeq = seq;
    }
    if (cursor && cursor.lastSeq > lastSeq) {
      throw new Error(
        `local remote-event cursor ${cursor.lastSeq} for ${bee} is ahead of durable proof ${lastSeq}`,
      );
    }

    let ringState: RemoteMirrorRingState | null = null;
    try {
      const parsed = JSON.parse(await readFile(remoteMirrorRingStatePath(bee), "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      const candidate = parsed as Partial<RemoteMirrorRingState>;
      if (
        candidate.version !== 1
        || candidate.node !== entry.node
        || candidate.remoteLaunchId !== entry.remoteLaunchId
        || candidate.remoteIncarnation !== entry.remoteIncarnation
        || !Number.isSafeInteger(candidate.throughRemoteSeq)
        || Number(candidate.throughRemoteSeq) < 0
        || typeof candidate.text !== "string"
      ) throw new Error("identity/high-water mismatch");
      ringState = candidate as RemoteMirrorRingState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`local remote-event ring state for ${bee} is unreadable or malformed`, { cause: error });
      }
    }
    let rebuiltRing = ringState?.text ?? "";
    const ringThrough = ringState?.throughRemoteSeq ?? 0;
    if (ringThrough < compactedThrough || ringThrough > lastSeq) {
      throw new Error(
        `local remote-event ring proof ${ringThrough} for ${bee} is outside durable origin proof ${compactedThrough}..${lastSeq}`,
      );
    }
    for (const event of local) {
      if (
        event.type === "text"
        && event.text.length > 0
        && typeof event.remoteSeq === "number"
        && event.remoteSeq > ringThrough
      ) rebuiltRing = appendRingText(rebuiltRing, event.text);
    }
    if (!ringState) {
      let existingRing = "";
      try {
        existingRing = await readFile(hsrRingPath(bee), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new Error(`local remote-event ring for ${bee} is unreadable`, { cause: error });
        }
      }
      if (compactedThrough > 0) {
        throw new Error(`local remote-event ring proof for ${bee} is missing after compaction`);
      }
      if (existingRing && existingRing !== rebuiltRing) {
        throw new Error(`local remote-event ring for ${bee} does not match durable event proof`);
      }
    }

    const legacy = local.length > 0 && !checkpointSeen && originSeqs.length === 0;
    entry.remoteSeq = lastSeq;
    return {
      afterSeq: legacy ? 0 : lastSeq,
      resetLegacy: legacy,
      persistAfterAuthorization: legacy || !cursor || cursor.lastSeq !== lastSeq,
      persistRingAfterAuthorization: legacy || !ringState || ringThrough !== lastSeq,
      ring: rebuiltRing,
    };
  }

  async function appendMirrored(bee: string, entry: MirrorEntry, event: RunnerEvent): Promise<void> {
    const originSeq = event.seq;
    if (!Number.isSafeInteger(originSeq) || Number(originSeq) <= 0) {
      throw new Error(`remote mirror event for ${bee} has no exact origin sequence`);
    }
    await withExactMirrorOwner(bee, entry, async () => {
      if (Number(originSeq) <= entry.remoteSeq) {
        // Cursor persistence may have failed after local append. Retry the
        // cursor write without appending a second local copy.
        await persistMirrorCursor(bee, entry);
        return;
      }
      if (Number(originSeq) !== entry.remoteSeq + 1) {
        throw new Error(`remote mirror event gap for ${bee}: expected ${entry.remoteSeq + 1}, received ${originSeq}`);
      }
      await ensureHsrRunDir(bee);
      await appendHsrEvent(bee, { ...event, remoteSeq: Number(originSeq) });
      entry.remoteSeq = Number(originSeq);
      if (event.type === "text" && typeof event.text === "string" && event.text.length > 0) {
        entry.ring = appendRingText(entry.ring, event.text);
      }
      // Bind the independent ring bytes to the exact remote origin high-water
      // before the cursor/ack can advance. A crash can reconstruct ring.txt
      // from this state plus the retained origin suffix.
      await persistMirrorRingState(bee, entry);
      await writeHsrRing(bee, entry.ring);
      // The cursor is the final durability commit. A crash before it causes
      // exact replay; event and ring bytes are already durable at that point.
      await persistMirrorCursor(bee, entry);
    }, { destructive: true });
  }

  async function onEvent(bee: string, entry: MirrorEntry, raw: unknown): Promise<void> {
    if (!isRunnerEvent(raw)) return;
    if ((raw as RunnerEvent & { remoteObservationIntegrityFailure?: unknown }).remoteObservationIntegrityFailure === true) {
      try {
        await fenceMirrorIntegrity(bee, entry, raw.type === "error" ? raw.message : "unknown resume failure");
      } catch (error) {
        // Make the next daemon tick retry the canonical fence instead of
        // treating this poisoned in-memory subscription as healthy.
        if (mirrors.get(bee) === entry) mirrors.delete(bee);
        throw error;
      }
      if (mirrors.get(bee) === entry) mirrors.delete(bee);
      return;
    }
    await appendMirrored(bee, entry, raw);
  }

  async function writeMirrorMetaUnchecked(
    bee: string,
    node: string,
    status: "running" | "exited",
    generation?: {
      remoteLaunchId?: string;
      remoteIncarnation?: string;
      syncPhase?: "resetting" | "syncing";
    },
  ): Promise<void> {
    let existing = await readHsrMeta(bee).catch(() => null);
    const launchId = generation?.remoteLaunchId ?? existing?.mirrorRemoteLaunchId;
    const incarnation = generation?.remoteIncarnation ?? existing?.mirrorRemoteIncarnation;
    const sameGeneration = existing?.mirrorOfNode === node
      && existing.mirrorRemoteLaunchId === launchId
      && existing.mirrorRemoteIncarnation === incarnation;
    if (status === "running" && existing?.mirrorOfNode && !sameGeneration) {
      await resetHsrMirrorGeneration(bee);
      await rm(remoteMirrorCursorPath(bee), { force: true });
      existing = null;
    }
    const meta: HsrMeta = {
      bee,
      harness: existing?.harness ?? "",
      tier: existing?.tier ?? "stream",
      ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
      hostPid: 0, // sentinel: a mirror has no local host (see runDir.ts HsrMeta)
      startedAt: sameGeneration && existing?.startedAt ? existing.startedAt : new Date(now()).toISOString(),
      controlSocket: "",
      status,
      mirrorOfNode: node,
      ...(launchId ? { mirrorRemoteLaunchId: launchId } : {}),
      ...(incarnation ? { mirrorRemoteIncarnation: incarnation } : {}),
      ...(generation?.syncPhase ? { mirrorSyncPhase: generation.syncPhase } : {}),
      ...(status === "exited" ? { endedAt: new Date(now()).toISOString() } : {}),
    };
    await ensureHsrRunDir(bee);
    await writeHsrMeta(bee, meta);
  }

  async function ensureMirror(node: NodeRecord, substrate: RemoteHsrSubstrate, record: SessionRecord): Promise<void> {
    const bee = record.name;
    if (!record.remoteLaunchId || !record.remoteIncarnation) return;
    const existing = mirrors.get(bee);
    if (
      existing
      && existing.remoteLaunchId === record.remoteLaunchId
      && existing.remoteIncarnation === record.remoteIncarnation
    ) return; // already mirroring this exact remote generation.
    if (existing) {
      // Do not tear down a known-good exact subscription merely because a stale
      // SessionRecord with the same bee name appears in one tick. First require
      // a token-qualified RPC under the remote lifecycle lock; unlike ordinary
      // best-effort tailing, a qualified rejection throws.
      try {
        await substrate.eventsTail(bee, Number.MAX_SAFE_INTEGER, {
          remoteLaunchId: record.remoteLaunchId,
          remoteIncarnation: record.remoteIncarnation,
        });
      } catch {
        return;
      }
      await teardown(bee, existing, { markExited: false });
    }
    const probe: MirrorEntry = {
      node: node.name,
      remoteLaunchId: record.remoteLaunchId,
      remoteIncarnation: record.remoteIncarnation,
      off: () => undefined,
      ring: "",
      remoteSeq: 0,
      record,
    };
    let cursorPlan = {
      afterSeq: 0,
      resetLegacy: true,
      persistAfterAuthorization: true,
      persistRingAfterAuthorization: true,
      ring: "",
    };
    try {
      cursorPlan = await withExactMirrorOwner(bee, probe, async (current) => {
        // Delivery/cleanup doubt must not stop an exact observation from
        // collecting evidence. A fence raised by this mirror itself is
        // different: its local projection has been quarantined and the source
        // proof is already known bad, so admitting a fresh subscription would
        // retry poisoned authority forever (and can attach a second callback
        // to an entry whose failure was already reported).
        if (isMirrorIntegrityFence(current)) {
          throw new RemoteObservationDetachedError(
            `remote mirror generation for ${bee} is already integrity-fenced`,
          );
        }
        const meta = await readHsrMetaStrict(bee);
        const sameGeneration = meta?.mirrorOfNode === node.name
          && meta.mirrorRemoteLaunchId === record.remoteLaunchId
          && meta.mirrorRemoteIncarnation === record.remoteIncarnation;
        return sameGeneration
          ? meta?.mirrorSyncPhase === "resetting"
            ? {
                afterSeq: 0,
                resetLegacy: true,
                persistAfterAuthorization: true,
                persistRingAfterAuthorization: true,
                ring: "",
              }
            : initialMirrorCursor(bee, probe)
          : {
              afterSeq: 0,
              resetLegacy: true,
              persistAfterAuthorization: true,
              persistRingAfterAuthorization: true,
              ring: "",
            };
      });
    } catch (error) {
      if (error instanceof RemoteObservationDetachedError) return;
      // An unreadable local authority cursor cannot be healed by retrying from
      // an assumed zero. Fence the exact canonical generation before clearing
      // derived state; a retired/replaced generation is left untouched.
      await fenceMirrorIntegrity(
        bee,
        probe,
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
      process.stderr.write(
        `hive: remote event mirror admission for ${bee} failed closed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }
    // Reserve the slot BEFORE the async observe so a re-entrant call this tick
    // can't double-subscribe.
    const entry: MirrorEntry = {
      node: node.name,
      remoteLaunchId: record.remoteLaunchId,
      remoteIncarnation: record.remoteIncarnation,
      off: () => undefined,
      ring: cursorPlan.ring,
      remoteSeq: cursorPlan.afterSeq,
      record,
    };
    mirrors.set(bee, entry);
    try {
      entry.off = await substrate.observe(
        bee,
        (event) => onEvent(bee, entry, event),
        {
          remoteLaunchId: record.remoteLaunchId,
          remoteIncarnation: record.remoteIncarnation,
        },
        {
          afterSeq: cursorPlan.afterSeq,
          afterAuthorized: async () => {
            try {
              await withExactMirrorOwner(bee, entry, async (current) => {
                if (cursorPlan.resetLegacy) {
                  // Publish the successor's non-live reset intent BEFORE any
                  // predecessor projection is removed. Restart may safely redo
                  // a resetting phase because no successor replay/ack began.
                  await writeMirrorMetaUnchecked(bee, node.name, "exited", {
                    remoteLaunchId: record.remoteLaunchId,
                    remoteIncarnation: record.remoteIncarnation,
                    syncPhase: "resetting",
                  });
                  await resetHsrMirrorGeneration(bee);
                  await rm(remoteMirrorCursorPath(bee), { force: true });
                  await rm(remoteMirrorRingStatePath(bee), { force: true });
                  entry.remoteSeq = 0;
                  entry.ring = "";
                }
                // Non-live/syncing projection: only the post-replay exact write
                // below flips this generation to running.
                await writeMirrorMetaUnchecked(bee, node.name, "exited", {
                  remoteLaunchId: record.remoteLaunchId,
                  remoteIncarnation: record.remoteIncarnation,
                  syncPhase: "syncing",
                });
                if (cursorPlan.persistRingAfterAuthorization) await persistMirrorRingState(bee, entry);
                await writeHsrRing(bee, entry.ring);
                if (cursorPlan.persistAfterAuthorization) await persistMirrorCursor(bee, entry);
              }, { destructive: true });
            } catch (error) {
              if (error instanceof RemoteObservationDetachedError) throw error;
              throw new RemoteObservationIntegrityError(
                `local mirror authorization projection failed for ${bee}`,
                { cause: error },
              );
            }
          },
          afterSynchronized: async () => {
            try {
              await withExactMirrorOwner(bee, entry, () => writeMirrorMetaUnchecked(bee, node.name, "running", {
                remoteLaunchId: record.remoteLaunchId,
                remoteIncarnation: record.remoteIncarnation,
              }), { destructive: true });
            } catch (error) {
              if (error instanceof RemoteObservationDetachedError) throw error;
              throw new RemoteObservationIntegrityError(`local mirror activation failed for ${bee}`, { cause: error });
            }
          },
        },
      );
    } catch (error) {
      // Subscribe failed (transient tunnel / no live host): drop the reservation
      // so a later tick retries. The `running` meta stays — it flips to exited
      // once the bee genuinely leaves the remote list.
      try {
        await entry.off();
      } catch {
        // best-effort subscription rollback
      }
      if (mirrors.get(bee) === entry) mirrors.delete(bee);
      if (error instanceof RemoteObservationIntegrityError) {
        await fenceMirrorIntegrity(bee, entry, error.message).catch(() => undefined);
      }
      const classification = error instanceof RemoteObservationIntegrityError
        ? "failed closed"
        : "is temporarily unavailable and will retry";
      process.stderr.write(
        `hive: remote event mirror subscription for ${bee} ${classification}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      );
      return;
    }
  }

  /**
   * Import the final exact suffix for a generation that ended before (or while)
   * this daemon held a live subscription. The spawn-time stable consumer keeps
   * the source prefix retained, so this path needs no live control socket.
   */
  async function syncTerminalMirror(
    node: NodeRecord,
    substrate: RemoteHsrSubstrate,
    record: SessionRecord,
  ): Promise<void> {
    const bee = record.name;
    if (!record.remoteLaunchId || !record.remoteIncarnation) {
      throw new RemoteObservationIntegrityError(`terminal remote mirror for ${bee} lacks launch authority`);
    }
    const existing = mirrors.get(bee);
    if (existing) {
      if (!exactMirrorGeneration(record, existing)) {
        throw new RemoteObservationDetachedError(`terminal remote mirror generation changed for ${bee}`);
      }
      await substrate.syncObservation(bee, {
        remoteLaunchId: record.remoteLaunchId,
        remoteIncarnation: record.remoteIncarnation,
      });
      await withExactMirrorOwner(bee, existing, () => writeMirrorMetaUnchecked(bee, node.name, "exited", {
        remoteLaunchId: record.remoteLaunchId,
        remoteIncarnation: record.remoteIncarnation,
      }), { destructive: true });
      return;
    }

    const entry: MirrorEntry = {
      node: node.name,
      remoteLaunchId: record.remoteLaunchId,
      remoteIncarnation: record.remoteIncarnation,
      off: () => undefined,
      ring: "",
      remoteSeq: 0,
      record,
    };
    let cursorPlan = {
      afterSeq: 0,
      resetLegacy: true,
      persistAfterAuthorization: true,
      persistRingAfterAuthorization: true,
      ring: "",
    };
    cursorPlan = await withExactMirrorOwner(bee, entry, async () => {
      const meta = await readHsrMetaStrict(bee);
      const sameGeneration = meta?.mirrorOfNode === node.name
        && meta.mirrorRemoteLaunchId === record.remoteLaunchId
        && meta.mirrorRemoteIncarnation === record.remoteIncarnation;
      return sameGeneration
        ? meta?.mirrorSyncPhase === "resetting"
          ? {
              afterSeq: 0,
              resetLegacy: true,
              persistAfterAuthorization: true,
              persistRingAfterAuthorization: true,
              ring: "",
            }
          : initialMirrorCursor(bee, entry)
        : {
            afterSeq: 0,
            resetLegacy: true,
            persistAfterAuthorization: true,
            persistRingAfterAuthorization: true,
            ring: "",
          };
    });
    entry.remoteSeq = cursorPlan.afterSeq;
    entry.ring = cursorPlan.ring;
    mirrors.set(bee, entry);
    try {
      await withExactMirrorOwner(bee, entry, async () => {
        if (cursorPlan.resetLegacy) {
          await writeMirrorMetaUnchecked(bee, node.name, "exited", {
            remoteLaunchId: record.remoteLaunchId,
            remoteIncarnation: record.remoteIncarnation,
            syncPhase: "resetting",
          });
          await resetHsrMirrorGeneration(bee);
          await rm(remoteMirrorCursorPath(bee), { force: true });
          await rm(remoteMirrorRingStatePath(bee), { force: true });
          entry.remoteSeq = 0;
          entry.ring = "";
        }
        await writeMirrorMetaUnchecked(bee, node.name, "exited", {
          remoteLaunchId: record.remoteLaunchId,
          remoteIncarnation: record.remoteIncarnation,
          syncPhase: "syncing",
        });
        if (cursorPlan.persistRingAfterAuthorization) await persistMirrorRingState(bee, entry);
        await writeHsrRing(bee, entry.ring);
        if (cursorPlan.persistAfterAuthorization) await persistMirrorCursor(bee, entry);
      }, { destructive: true });
      await substrate.replayTerminalEvents(
        bee,
        (event) => onEvent(bee, entry, event),
        { remoteLaunchId: record.remoteLaunchId, remoteIncarnation: record.remoteIncarnation },
        entry.remoteSeq,
        () => withExactMirrorOwner(bee, entry, () => writeMirrorMetaUnchecked(bee, node.name, "exited", {
          remoteLaunchId: record.remoteLaunchId,
          remoteIncarnation: record.remoteIncarnation,
        }), { destructive: true }),
      );
    } finally {
      if (mirrors.get(bee) === entry) mirrors.delete(bee);
    }
  }

  async function teardown(bee: string, entry: MirrorEntry, options: { markExited: boolean }): Promise<void> {
    try {
      await entry.off();
    } catch {
      // best-effort
    }
    if (mirrors.get(bee) === entry) mirrors.delete(bee);
    if (options.markExited) {
      // Flip the mirror meta to exited so deriveState settles it dead/done.
      await withExactMirrorOwner(
        bee,
        entry,
        () => writeMirrorMetaUnchecked(bee, entry.node, "exited", {
          remoteLaunchId: entry.remoteLaunchId,
          remoteIncarnation: entry.remoteIncarnation,
        }),
        { destructive: true },
      ).catch(() => undefined);
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
    // A canonical event-history marker quarantines the exact source. Drop any
    // in-memory relay without publishing an `exited` mirror fact: the outside
    // receipt, not this derived cache, owns stop truth. The callback boundary
    // independently rechecks the marker under the record lock, so a relay
    // racing this tick cannot append after the fence.
    const integrityFenced = new Set(
      records
        .filter((record) => remoteNodeName(record) && !isEventHistoryObservationAdmissible(record))
        .map((record) => record.name),
    );
    for (const bee of integrityFenced) {
      const active = mirrors.get(bee);
      if (active) await teardown(bee, active, { markExited: false });
    }

    // Group the remote-hsr records by node so we call listSessions once per node.
    const byNode = new Map<string, SessionRecord[]>();
    for (const record of records) {
      const node = remoteNodeName(record);
      if (!node || !isEventHistoryObservationAdmissible(record)) continue;
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
      let rows: RemoteListRow[];
      try {
        rows = await substrate.listRemoteRows();
      } catch (error) {
        if (error instanceof RemoteObservationIntegrityError) {
          // A typed authority/storage failure is not an empty remote node. Fence
          // every exact generation on that authority and tear down poisoned
          // relays; ordinary tunnel loss below remains retryable.
          for (const record of nodeRecords) {
            if (!record.remoteLaunchId || !record.remoteIncarnation) continue;
            const entry = mirrors.get(record.name) ?? {
              node: nodeName,
              remoteLaunchId: record.remoteLaunchId,
              remoteIncarnation: record.remoteIncarnation,
              off: () => undefined,
              ring: "",
              remoteSeq: 0,
              record,
            };
            await fenceMirrorIntegrity(record.name, entry, error.message).catch(() => undefined);
            const active = mirrors.get(record.name);
            if (active) await teardown(record.name, active, { markExited: false });
          }
          continue;
        }
        // Tunnel down this tick: don't tear existing mirrors down (the transport
        // is reconnecting) and don't add new ones. Keep what we have.
        for (const record of nodeRecords) {
          if (mirrors.has(record.name)) wanted.add(record.name);
        }
        continue;
      }
      const rowByBee = new Map(rows.map((row) => [row.bee, row]));
      for (const record of nodeRecords) {
        const row = rowByBee.get(record.name);
        const exactRow = row
          && row.launchId === record.remoteLaunchId
          && row.incarnation === record.remoteIncarnation
          ? row
          : undefined;
        if (row && !exactRow) {
          // A same-name remote successor is not evidence about this canonical
          // generation. Preserve an exact existing mirror until lifecycle
          // reconciliation resolves the token mismatch.
          if (mirrors.has(record.name)) wanted.add(record.name);
          continue;
        }
        if (exactRow?.transitional) {
          if (mirrors.has(record.name)) wanted.add(record.name);
          continue;
        }
        if (exactRow?.unavailable === "busy") {
          // A writer owns the exact source authority right now. Preserve an
          // existing projection and retry; absence/busy is not corruption.
          if (mirrors.has(record.name)) wanted.add(record.name);
          continue;
        }
        if (exactRow?.unavailable === "integrity" || exactRow?.integrityFailure === true) {
          const probe = mirrors.get(record.name) ?? {
            node: nodeName,
            remoteLaunchId: record.remoteLaunchId,
            remoteIncarnation: record.remoteIncarnation,
            off: () => undefined,
            ring: "",
            remoteSeq: 0,
            record,
          };
          await fenceMirrorIntegrity(
            record.name,
            probe,
            exactRow.error ?? "remote per-Bee authority storage failed",
          ).catch(() => undefined);
          const active = mirrors.get(record.name);
          if (active) await teardown(record.name, active, { markExited: false });
          continue;
        }
        if (exactRow?.eventIntegrityReceipt) {
          try {
            await importRemoteHsrEventIntegrityReceipt(exactRow.eventIntegrityReceipt, record.name);
          } catch (error) {
            const probe = mirrors.get(record.name) ?? {
              node: nodeName,
              remoteLaunchId: record.remoteLaunchId,
              remoteIncarnation: record.remoteIncarnation,
              off: () => undefined,
              ring: "",
              remoteSeq: 0,
              record,
            };
            await fenceMirrorIntegrity(record.name, probe, `remote event-integrity import failed: ${error instanceof Error ? error.message : String(error)}`).catch(() => undefined);
          }
          const active = mirrors.get(record.name);
          if (active) await teardown(record.name, active, { markExited: false });
          continue;
        }
        if (exactRow?.live) {
          wanted.add(record.name);
          await ensureMirror(node, substrate, record);
          continue;
        }
        if (exactRow) {
          try {
            await syncTerminalMirror(node, substrate, record);
          } catch (error) {
            if (error instanceof RemoteObservationIntegrityError) {
              const probe = mirrors.get(record.name) ?? {
                node: nodeName,
                remoteLaunchId: record.remoteLaunchId,
                remoteIncarnation: record.remoteIncarnation,
                off: () => undefined,
                ring: "",
                remoteSeq: 0,
                record,
              };
              await fenceMirrorIntegrity(record.name, probe, error.message).catch(() => undefined);
            } else if (!(error instanceof RemoteObservationDetachedError)) {
              // Exact terminal history is still remotely retained. Keep an
              // existing projection alive and retry on the next daemon tick.
              if (mirrors.has(record.name)) wanted.add(record.name);
            }
          }
          continue;
        }
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
