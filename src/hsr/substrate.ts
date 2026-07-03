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
  Substrate,
  TmuxWindowOptions,
} from "../substrates/types.js";
import { LOCAL_NODE } from "../substrates/types.js";
import { hsrSnapshot, killOrphanedChildGroup, listHsrBees } from "./observe.js";
import { readHsrMeta } from "./runDir.js";
import { connectRpcClient } from "./rpc.js";

/** Signal-0 liveness probe; EPERM means the pid exists but isn't ours. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A runner host is live iff meta says running AND its host pid is alive. */
async function hasSession(bee: string): Promise<boolean> {
  const meta = await readHsrMeta(bee);
  return !!meta && meta.status === "running" && isPidAlive(meta.hostPid);
}

/** Rendered text tail from ring.txt (Substrate.capture compat). */
async function capture(bee: string, lines?: number): Promise<string> {
  return hsrSnapshot(bee, lines);
}

/** Deliver a user turn over the bee's control socket. Throws if no live host. */
async function sendText(bee: string, text: string): Promise<void> {
  const meta = await readHsrMeta(bee);
  if (!meta || meta.status !== "running" || !isPidAlive(meta.hostPid)) {
    throw new Error(`HSR bee ${bee} has no live runner host to steer`);
  }
  const client = await connectRpcClient(meta.controlSocket);
  try {
    await client.call("send", { text });
  } finally {
    client.close();
  }
}

/** Poll meta until the host is no longer "running" (clean exit), or timeout. */
async function waitUntilNotRunning(bee: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await readHsrMeta(bee);
    if (!meta || meta.status !== "running" || !isPidAlive(meta.hostPid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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
  const meta = await readHsrMeta(bee);
  let stopped = false;
  if (meta?.controlSocket) {
    try {
      const client = await connectRpcClient(meta.controlSocket);
      try {
        await client.call("stop");
      } finally {
        client.close();
      }
      stopped = await waitUntilNotRunning(bee, 2_500);
    } catch {
      // Host unreachable / socket stale — fall through to the signal fallback.
    }
  }
  // Fallback only when the host is still supposed to be running: an already
  // "exited" meta means the bee stopped cleanly (its socket file is gone, so the
  // stop attempt above throws) — signalling meta.hostPid then would target a
  // recycled/unrelated pid.
  if (!stopped && meta && meta.status === "running") {
    if (isPidAlive(meta.hostPid)) {
      try {
        process.kill(meta.hostPid, "SIGTERM");
      } catch {
        // Already gone or not signalable.
      }
    } else {
      // The host died without finalize (crashed __hsr-run): its detached
      // harness child is orphaned with no control socket. Signal the recorded
      // child group directly so kill actually stops the harness (HIVE-53).
      await killOrphanedChildGroup(meta);
    }
  }
  return { ok: true, stdout: "", stderr: "", exitCode: 0 };
}

let cached: Substrate | undefined;

/** The singleton HSR substrate (local-only, record-routed). */
export function hsrSubstrate(): Substrate {
  if (cached) return cached;
  cached = {
    kind: "hsr",
    node: LOCAL_NODE,
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
    sendText: (target: string, text: string) => sendText(target, text),
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
