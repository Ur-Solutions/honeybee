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
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import { LOCAL_NODE } from "../substrates/types.js";
import {
  ensureOrphanedChildGroupStopped,
  hsrSnapshot,
  inspectHsrHostProcess,
  listHsrBees,
  type HsrProcessSignalDependencies,
} from "./observe.js";
import { readHsrMeta, readHsrMetaStrict, writeHsrMeta, type HsrMeta } from "./runDir.js";
import { readProcessBirthFingerprint, sameProcessBirthFingerprint } from "./processIdentity.js";
import { connectRpcClient } from "./rpc.js";
import { clearPendingHsrTurns, enqueuePendingHsrTurn, withHsrTurnDeliveryLock } from "./pendingTurns.js";
import { stopSpawnedHsrHost } from "./runnerHost.js";

/** A queued or running host is live while its detached host pid is alive. */
async function hasSession(bee: string, deps: HsrProcessSignalDependencies = {}): Promise<boolean> {
  const meta = await readHsrMetaStrict(bee);
  if (!meta || meta.status === "exited") return false;
  if (meta.mirrorOfNode) return meta.status === "running";
  return await inspectHsrHostProcess(meta, deps) === "match";
}

/** Rendered text tail from ring.txt (Substrate.capture compat). */
async function capture(bee: string, lines?: number): Promise<string> {
  return hsrSnapshot(bee, lines);
}

/** Deliver a user turn over the bee's control socket. Throws if no live host. */
async function sendText(bee: string, text: string, _paneId?: string, options?: SendTextOptions): Promise<void> {
  await withHsrTurnDeliveryLock(bee, async () => {
    const meta = await readHsrMeta(bee);
    const live = !!meta && (meta.mirrorOfNode ? meta.status === "running" : await inspectHsrHostProcess(meta) === "match");
    if (meta?.status === "queued" && live) {
      // A queued/booting host has no live turn — the pending turn drains once
      // its harness and control socket are ready, so delivery mode is moot.
      await enqueuePendingHsrTurn(bee, text);
      return;
    }
    if (!meta || meta.status !== "running" || !live) {
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
function sameHostIncarnation(left: HsrMeta, right: HsrMeta | null): boolean {
  return !!right && left.hostPid === right.hostPid && left.startedAt === right.startedAt &&
    sameProcessBirthFingerprint(left.hostFingerprint, right.hostFingerprint);
}

async function waitUntilHostStopped(
  bee: string,
  expected: HsrMeta,
  timeoutMs: number,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  // An exited pre-fingerprint host is never safe to signal, but exact numeric
  // PID absence is sufficient to prove that the recorded host is no longer
  // running. A live/reused PID or an unreadable census remains unconfirmed.
  if (expected.status === "exited" && !expected.hostFingerprint) {
    try {
      const current = await (deps.readProcessIdentity ?? readProcessBirthFingerprint)(expected.hostPid);
      if (current === null) return true;
    } catch {
      return false;
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await inspectHsrHostProcess(expected, deps);
    if (identity === "gone" || identity === "mismatch") return true;
    if (identity === "unverifiable") return false;
    // Remote/in-process hosts deliberately share this process (the host test
    // exercises that supported shape). Their process cannot exit when one
    // logical HSR session stops, so the incarnation's finalized meta is the
    // strongest available confirmation. Detached production hosts always have
    // another pid and still require observed OS exit below.
    if (expected.hostPid === process.pid) {
      const latest = await readHsrMetaStrict(bee);
      if (sameHostIncarnation(expected, latest) && latest?.status === "exited") return true;
    }
    await (deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(50);
  }
  // Meta status is not enough: finalize writes `exited` immediately before the
  // host process itself returns. Confirm OS liveness so terminal Run state can
  // never race that final process-exit window.
  const identity = await inspectHsrHostProcess(expected, deps);
  if (identity === "gone" || identity === "mismatch") return true;
  if (identity !== "match" || expected.hostPid !== process.pid) return false;
  const latest = await readHsrMetaStrict(bee);
  return sameHostIncarnation(expected, latest) && latest?.status === "exited";
}

async function confirmChildGroupStopped(
  meta: HsrMeta | null,
  deps: HsrProcessSignalDependencies = {},
): Promise<boolean> {
  return ensureOrphanedChildGroupStopped(meta, deps);
}

/**
 * Numeric-absence death proof for a host whose birth fingerprint is not
 * comparable (legacy or hand-repaired metadata). Exact PID absence still
 * proves the RECORDED host process no longer exists — the same carve-out
 * waitUntilHostStopped grants exited pre-fingerprint metas, extended to
 * stale `running` metas so a long-dead host cannot wedge kill/revive
 * forever behind "HSR stop unconfirmed" (cell-smoothness Phase 2). A live,
 * reused, or unreadable pid stays unconfirmed; mirrors and sentinel pids
 * are never death-provable this way.
 */
async function recordedHostPidAbsent(meta: HsrMeta, deps: HsrProcessSignalDependencies): Promise<boolean> {
  if (meta.mirrorOfNode || !Number.isSafeInteger(meta.hostPid) || meta.hostPid <= 0) return false;
  if (meta.hostPid === process.pid) return false;
  try {
    return (await (deps.readProcessIdentity ?? readProcessBirthFingerprint)(meta.hostPid)) === null;
  } catch {
    return false;
  }
}

/**
 * Publish a proven stop outcome onto the exact incarnation's metadata. A
 * confirmed-stopped host whose meta still says queued/running re-enters every
 * observer and stop path looking alive (the revive wedge: each retry re-fails
 * the same verification). Mirrors reapDeadHosts' flip; best-effort — the stop
 * result stands even when the write fails, and a replacement incarnation's
 * metadata is never touched.
 */
async function publishProvenStop(bee: string, initial: HsrMeta, current: HsrMeta | null): Promise<void> {
  // Only the freshly-read on-disk meta authorizes the write: a replacement
  // incarnation's metadata (or an already-final record) is never overwritten.
  // Unlike the signalling paths, a pair of fingerprint-LESS metas with the
  // same pid + startedAt is the same incarnation for this non-destructive
  // publication — legacy metas must not be exempt from the flip.
  if (!current || current.status === "exited") return;
  const sameIncarnation = initial.hostPid === current.hostPid && initial.startedAt === current.startedAt &&
    (sameProcessBirthFingerprint(initial.hostFingerprint, current.hostFingerprint) ||
      (initial.hostFingerprint === undefined && current.hostFingerprint === undefined));
  if (!sameIncarnation) return;
  await writeHsrMeta(bee, { ...current, status: "exited", endedAt: new Date().toISOString() }).catch(() => undefined);
}

/**
 * Best-effort stop: ask the host to stop cleanly over the control socket and
 * give it a brief grace to finalize (the host's stop tears down the harness
 * child, then flips meta to "exited"). Only if that clean stop does not take —
 * the socket is dead/unreachable, or the host ignores it — SIGTERM the host pid
 * as a fallback (its SIGTERM handler stops the child too). Never throws —
 * killing an already-dead bee is a no-op success.
 */
export async function stopHsrIncarnation(
  bee: string,
  initial: HsrMeta,
  deps: HsrProcessSignalDependencies = {},
): Promise<KillResult> {
  // An `exited` meta can be visible just before the detached host process
  // returns. Treat it as a reason not to signal a possibly recycled pid, but
  // still confirm both the recorded host incarnation and its child group.
  let stopped = initial.status === "exited"
    ? await waitUntilHostStopped(bee, initial, 1_000, deps)
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
      stopped = await waitUntilHostStopped(bee, initial, 2_500, deps);
    } catch {
      // Host unreachable / socket stale — fall through to the signal fallback.
    }
  }
  // Fallback only when the host is still supposed to be running: an already
  // "exited" meta means the bee stopped cleanly (its socket file is gone, so the
  // stop attempt above throws) — signalling meta.hostPid then would target a
  // recycled/unrelated pid.
  if (!stopped) {
    const latest = await readHsrMetaStrict(bee);
    if (sameHostIncarnation(initial, latest)) ownedMeta = latest!;
    // Only signal the exact runtime incarnation read at entry. A replacement
    // host under the same bee name is not ours to shoot by a recycled pid.
    const hostIdentity = await inspectHsrHostProcess(initial, deps);
    if (latest && latest.status !== "exited" && sameHostIncarnation(initial, latest) && hostIdentity === "match") {
      try {
        (deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)))(initial.hostPid, "SIGTERM");
      } catch {
        // Already gone or not signalable.
      }
      stopped = await waitUntilHostStopped(bee, initial, 2_000, deps);
      if (!stopped) {
        const current = await readHsrMetaStrict(bee);
        const currentIdentity = await inspectHsrHostProcess(initial, deps);
        if (current && current.status !== "exited" && sameHostIncarnation(initial, current) && currentIdentity === "match") {
          try {
            (deps.kill ?? ((pid: number, signal: NodeJS.Signals | 0) => process.kill(pid, signal)))(initial.hostPid, "SIGKILL");
          } catch {
            // Already gone or not signalable.
          }
        }
        stopped = await waitUntilHostStopped(bee, initial, 1_000, deps);
      }
    } else {
      // Missing/replacement/exited meta never authorizes a signal. A gone or
      // different OS birth proves only that the INITIAL host is gone; a match
      // behind replacement metadata stays unconfirmed. An unverifiable birth
      // (legacy/hand-repaired meta without a comparable fingerprint) may still
      // be death-proven by exact numeric PID absence; a live or unreadable
      // pid keeps failing closed.
      stopped = hostIdentity === "gone" || hostIdentity === "mismatch" ||
        (hostIdentity === "unverifiable" && await recordedHostPidAbsent(initial, deps)) ||
        (initial.hostPid === process.pid && sameHostIncarnation(initial, latest) && latest?.status === "exited");
    }
  }

  const finalMeta = await readHsrMetaStrict(bee);
  if (sameHostIncarnation(initial, finalMeta)) ownedMeta = finalMeta!;
  let childStopped = stopped ? await confirmChildGroupStopped(ownedMeta, deps) : false;
  // A host that died BEFORE child admission completed ("pending"/legacy, no
  // child pid ever recorded) leaves nothing to verify — and, being dead, can
  // never publish a locator either. With the host incarnation itself proven
  // stopped above, refusing forever only wedges kill/revive on exactly the
  // Cells that crashed during boot; treat the never-recorded child group as
  // moot. A RECORDED child with unverifiable identity still fails closed.
  if (stopped && !childStopped && ownedMeta.childPid === undefined && ownedMeta.childPgid === undefined) {
    childStopped = true;
  }
  const confirmed = stopped && childStopped;
  if (confirmed) {
    await clearPendingHsrTurns(bee).catch(() => undefined);
    await publishProvenStop(bee, initial, finalMeta);
    return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  }
  return {
    ok: false,
    stdout: "",
    stderr: `HSR stop unconfirmed for ${bee}: host or detached harness process group remains live`,
    exitCode: 1,
  };
}

/**
 * Stop only the runner-host incarnation returned by spawnHsrHost. If metadata
 * already names a replacement, leave it untouched and report whether the
 * launched pid is independently confirmed gone.
 */
export async function stopHsrIncarnationByPid(bee: string, expectedHostPid: number): Promise<KillResult> {
  // Check the spawn handle before metadata. If this process already reaped the
  // exact child, a recycled same-number pid in replacement metadata must never
  // be adopted or signalled.
  const current = await readHsrMetaStrict(bee);
  if (current?.hostPid === expectedHostPid) return stopHsrIncarnation(bee, current);
  // Publication may lag spawn. The spawning process retains the returned
  // ChildProcess handle, so rollback does not adopt whatever same-name
  // metadata appeared meanwhile; the host's SIGTERM path retains its existing
  // birth-validated descendant teardown.
  const spawnedStop = await stopSpawnedHsrHost(expectedHostPid);
  // The exact host handle proves only host exit. Without metadata, a detached
  // harness child may have escaped during startup, so neither a clean handle
  // exit nor numeric pid absence is sufficient child-group absence proof.
  return {
    ok: false,
    stdout: "",
    stderr: `HSR stop unconfirmed for ${bee}: ${
      spawnedStop === "unconfirmed" || isPidAlive(expectedHostPid)
        ? `launched host ${expectedHostPid} or its child tree remains observable`
        : `metadata does not prove child absence for launched host ${expectedHostPid}`
    }`,
    exitCode: 1,
  };
}

/** Generic user kill also fails closed when the child locator is absent. */
async function kill(bee: string, deps: HsrProcessSignalDependencies = {}): Promise<KillResult> {
  const initial = await readHsrMetaStrict(bee);
  if (!initial) {
    return {
      ok: false,
      stdout: "",
      stderr: `HSR stop unconfirmed for ${bee}: metadata is absent and detached child absence is unproven`,
      exitCode: 1,
    };
  }
  return stopHsrIncarnation(bee, initial, deps);
}

/**
 * Strict stop for an execution launcher that already knows spawn returned.
 * Missing metadata is not evidence that the detached host is dead: startup
 * publication may simply be late, so terminal failure must remain forbidden.
 */
export async function stopKnownHsrExecution(bee: string): Promise<KillResult> {
  const initial = await readHsrMetaStrict(bee);
  if (!initial) {
    return {
      ok: false,
      stdout: "",
      stderr: `HSR stop unconfirmed for ${bee}: spawned runtime metadata is not yet observable`,
      exitCode: 1,
    };
  }
  return stopHsrIncarnation(bee, initial);
}

let cached: Substrate | undefined;

/** The singleton HSR substrate (local-only, record-routed). */
export function hsrSubstrate(): Substrate {
  if (cached) return cached;
  cached = createHsrSubstrate();
  return cached;
}

/** Injectable HSR substrate for deterministic incarnation-safety tests. */
export function createHsrSubstrate(processSignals: HsrProcessSignalDependencies = {}): Substrate {
  return {
    kind: "hsr",
    node: LOCAL_NODE,
    // The runner host sees tool events inline, so it can hold a next-tool send.
    supportsNextTool: true,
    async probe(): Promise<ProbeResult> {
      return { ok: true };
    },
    hasSession: (target: string) => hasSession(target, processSignals),
    // Spawn forks the runner host directly (hive __hsr-run) and records the bee;
    // it never routes through newSession.
    newSession(): Promise<NewSessionResult> {
      throw new Error("HSR bees spawn via the runner host, not newSession");
    },
    // Combs are retired (APIA-85): no newPane/killPane. Killing an HSR bee is
    // killing its runner host (kill), since there is no pane.
    kill: (target: string) => kill(target, processSignals),
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
}
