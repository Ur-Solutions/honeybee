/**
 * SubstrateHsr (APIA-76) — the record-level, local-only HSR substrate.
 *
 * HSR bees run under a detached, self-supervising runner host (see host.ts and
 * HSR_EXPLORATION.md §7), NOT inside a tmux session. This substrate therefore
 * never talks to tmux: it observes bees by reading their run dirs (meta.json,
 * ring.txt) and steers/stops them over each bee's per-bee JSON-RPC control
 * socket. Spawn does not go through `newSession` — the spawn path forks the
 * runner host directly (`hive __hsr-run`) and only then records the bee — so the
 * `newSession` verb throws.
 *
 * For an HSR bee the `target` argument passed to every method IS the bee name
 * (spawn sets `record.tmuxTarget = record.name`, a logical id). There are no
 * panes, so `paneId` args are ignored.
 *
 * Node builtins only.
 */

import type {
  KillResult,
  LaunchSpec,
  NewSessionResult,
  ProbeResult,
  SendTextOptions,
  Substrate,
  TmuxWindowOptions,
} from "../substrates/types.js";
import { LOCAL_NODE } from "../substrates/types.js";
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import { hsrSnapshot, isHsrProcessGroupAlive, killOrphanedChildGroup, listHsrBees } from "./observe.js";
import { readHsrMeta, type HsrMeta } from "./runDir.js";
import { connectRpcClient } from "./rpc.js";
import { clearPendingHsrTurns, enqueuePendingHsrTurn, withHsrTurnDeliveryLock } from "./pendingTurns.js";

/** A queued or running host is live while its detached host pid is alive. */
async function hasSession(bee: string): Promise<boolean> {
  const meta = await readHsrMeta(bee);
  return !!meta && meta.status !== "exited" && isPidAlive(meta.hostPid);
}

/** Rendered text tail from ring.txt (Substrate.capture compat). */
async function capture(bee: string, lines?: number): Promise<string> {
  return hsrSnapshot(bee, lines);
}

/** Deliver a user turn over the bee's control socket. Throws if no live host. */
async function sendText(bee: string, text: string, _paneId?: string, options?: SendTextOptions): Promise<void> {
  await withHsrTurnDeliveryLock(bee, async () => {
    const meta = await readHsrMeta(bee);
    if (meta?.status === "queued" && isPidAlive(meta.hostPid)) {
      // A queued/booting host has no live turn — the pending turn drains once
      // its harness and control socket are ready, so delivery mode is moot.
      await enqueuePendingHsrTurn(bee, text);
      return;
    }
    if (!meta || meta.status !== "running" || !isPidAlive(meta.hostPid)) {
      throw new Error(`HSR bee ${bee} has no live runner host to steer`);
    }
    const client = await connectRpcClient(meta.controlSocket);
    try {
      if (options?.mode === "next-tool") {
        // Steering joins an already-open provider turn and has no independent
        // turn_end boundary to ack against, so it keeps its existing native
        // queue semantics rather than masquerading as a recoverable new turn.
        await client.call("send", { text, mode: "next-tool" });
      } else {
        // Persist BEFORE stdin/RPC acceptance. The host acks this file only on
        // a completed non-auth turn; a login-required failure leaves the exact
        // operator text available for restart+replay.
        const turn = await enqueuePendingHsrTurn(bee, text);
        await client.call("send", { text, deliveryId: turn.filename });
      }
    } finally {
      client.close();
    }
  });
}

/** Poll the same runtime incarnation until it is no longer live. */
async function waitUntilHostStopped(bee: string, expectedHostPid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(expectedHostPid)) return true;
    // Remote/in-process hosts deliberately share this process (the host test
    // exercises that supported shape). Their process cannot exit when one
    // logical HSR session stops, so the incarnation's finalized meta is the
    // strongest available confirmation. Detached production hosts always have
    // another pid and still require observed OS exit below.
    if (expectedHostPid === process.pid) {
      const latest = await readHsrMeta(bee);
      if (latest?.hostPid === expectedHostPid && latest.status === "exited") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // Meta status is not enough: finalize writes `exited` immediately before the
  // host process itself returns. Confirm OS liveness so terminal Run state can
  // never race that final process-exit window.
  if (!isPidAlive(expectedHostPid)) return true;
  if (expectedHostPid !== process.pid) return false;
  const latest = await readHsrMeta(bee);
  return latest?.hostPid === expectedHostPid && latest.status === "exited";
}

function childGroupOf(meta: HsrMeta | null): number {
  return meta?.childPgid ?? meta?.childPid ?? 0;
}

async function confirmChildGroupStopped(meta: HsrMeta | null): Promise<boolean> {
  const pgid = childGroupOf(meta);
  if (!isHsrProcessGroupAlive(pgid)) return true;
  await killOrphanedChildGroup(meta);
  return !isHsrProcessGroupAlive(pgid);
}

/**
 * Best-effort stop: ask the host to stop cleanly over the control socket and
 * give it a brief grace to finalize (the host's stop tears down the harness
 * child, then flips meta to "exited"). Only if that clean stop does not take —
 * the socket is dead/unreachable, or the host ignores it — SIGTERM the host pid
 * as a fallback (its SIGTERM handler stops the child too). Never throws —
 * killing an already-dead bee is a no-op success.
 */
async function kill(bee: string): Promise<KillResult> {
  const initial = await readHsrMeta(bee);
  if (!initial) {
    await clearPendingHsrTurns(bee).catch(() => undefined);
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  // An `exited` meta can be visible just before the detached host process
  // returns. Treat it as a reason not to signal a possibly recycled pid, but
  // still confirm both the recorded host incarnation and its child group.
  let stopped = initial.status === "exited"
    ? await waitUntilHostStopped(bee, initial.hostPid, 1_000)
    : false;
  // `ownedMeta` may learn childPid/childPgid only while meta still names the
  // initial host. A replacement incarnation is never adopted for cleanup.
  let ownedMeta: HsrMeta = initial;
  if (initial.status !== "exited" && initial.controlSocket) {
    try {
      const client = await connectRpcClient(initial.controlSocket);
      try {
        await client.call("stop");
      } finally {
        client.close();
      }
      stopped = await waitUntilHostStopped(bee, initial.hostPid, 2_500);
    } catch {
      // Host unreachable / socket stale — fall through to the signal fallback.
    }
  }
  // Fallback only when the host is still supposed to be running: an already
  // "exited" meta means the bee stopped cleanly (its socket file is gone, so the
  // stop attempt above throws) — signalling meta.hostPid then would target a
  // recycled/unrelated pid.
  if (!stopped) {
    const latest = await readHsrMeta(bee);
    if (latest?.hostPid === initial.hostPid) ownedMeta = latest;
    // Only signal the exact runtime incarnation read at entry. A replacement
    // host under the same bee name is not ours to shoot by a recycled pid.
    if (latest && latest.status !== "exited" && latest.hostPid === initial.hostPid && isPidAlive(initial.hostPid)) {
      try {
        process.kill(initial.hostPid, "SIGTERM");
      } catch {
        // Already gone or not signalable.
      }
      stopped = await waitUntilHostStopped(bee, initial.hostPid, 2_000);
      if (!stopped) {
        const current = await readHsrMeta(bee);
        if (current && current.status !== "exited" && current.hostPid === initial.hostPid && isPidAlive(initial.hostPid)) {
          try {
            process.kill(initial.hostPid, "SIGKILL");
          } catch {
            // Already gone or not signalable.
          }
        }
        stopped = await waitUntilHostStopped(bee, initial.hostPid, 1_000);
      }
    } else if (!latest || latest.status === "exited") {
      stopped = !isPidAlive(initial.hostPid);
    } else if (latest.hostPid !== initial.hostPid) {
      // Replacement raced the stop. If the initial pid is still observable we
      // cannot prove ownership (it could also have been recycled), so preserve
      // lost/unconfirmed state and leave BOTH replacement host/group untouched.
      stopped = !isPidAlive(initial.hostPid);
    } else {
      // The host died without finalize (crashed __hsr-run): its detached
      // harness child is orphaned with no control socket. Signal the recorded
      // child group directly so kill actually stops the harness (HIVE-53).
      stopped = true;
    }
  }

  const finalMeta = await readHsrMeta(bee);
  if (finalMeta?.hostPid === initial.hostPid) ownedMeta = finalMeta;
  const childStopped = stopped ? await confirmChildGroupStopped(ownedMeta) : false;
  const confirmed = stopped && childStopped;
  await clearPendingHsrTurns(bee).catch(() => undefined);
  return confirmed
    ? { ok: true, stdout: "", stderr: "", exitCode: 0 }
    : {
        ok: false,
        stdout: "",
        stderr: `HSR stop unconfirmed for ${bee}: host or detached harness process group remains live`,
        exitCode: 1,
      };
}

let cached: Substrate | undefined;

/** The singleton HSR substrate (local-only, record-routed). */
export function hsrSubstrate(): Substrate {
  if (cached) return cached;
  cached = {
    kind: "hsr",
    node: LOCAL_NODE,
    // The runner host sees tool events inline, so it can hold a next-tool send.
    supportsNextTool: true,
    async probe(): Promise<ProbeResult> {
      return { ok: true };
    },
    hasSession,
    // Spawn forks the runner host directly (hive __hsr-run) and records the bee;
    // it never routes through newSession.
    newSession(): Promise<NewSessionResult> {
      throw new Error("HSR bees spawn via the runner host, not newSession");
    },
    // Combs are retired (APIA-85): no newPane/killPane. Killing an HSR bee is
    // killing its runner host (kill), since there is no pane.
    kill: (target: string) => kill(target),
    capture: (target: string, lines?: number) => capture(target, lines),
    sendText: (target: string, text: string, paneId?: string, options?: SendTextOptions) =>
      sendText(target, text, paneId, options),
    // HSR turns are committed atomically by sendText (the runner encodes and
    // flushes one user message); there is no separate terminal Enter/keystroke
    // channel the way tmux has, so these are intentional no-ops.
    async sendEnter(): Promise<void> {
      /* no-op: HSR has no separate Enter — sendText commits the turn */
    },
    async sendKey(): Promise<void> {
      /* no-op: HSR has no keystroke channel */
    },
    listSessions: () => listHsrBees(),
    // No panes, and HSR state/liveness is answered by the observe/deriveState
    // follow-up (run-dir based), not tmux session-state options.
    async listPanes(): Promise<Set<string>> {
      return new Set();
    },
    async listSessionStates(): Promise<Map<string, string>> {
      return new Map();
    },
    // Best-effort tmux-only concerns; no-ops for a pane-less bee.
    async setUserOptions(): Promise<void> {
      /* no-op */
    },
    async setWindowOptions(_target: string, _options: TmuxWindowOptions | undefined): Promise<void> {
      /* no-op */
    },
    async renameWindow(): Promise<void> {
      /* no-op */
    },
    // No tmux target to attach; a read-only console tab is a later Apiary concern.
    attachCommand(): string[] {
      return [];
    },
    async attachSession(): Promise<void> {
      throw new Error("HSR bees have no tmux target; use hive tail/transcript");
    },
  };
  return cached;
}
