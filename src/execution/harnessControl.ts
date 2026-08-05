// In-process harness steering for the execution protocol (H3): run.command
// send/answer/interrupt and the cancel/release safe-stop, delivered ONLY over
// the bee's per-run-dir JSON-RPC control socket (the same channel `hive`
// itself steers HSR bees on). Never tmux send-keys, never a CLI fallback, and
// never a bare signal to a stored pid: a pid recorded before a crash can be
// recycled by an unrelated process, so an unreachable-but-alive host is
// reported honestly as "stop unconfirmed" instead of being shot blind.
//
// Delivery semantics are at-most-once and classified fail-closed:
//   - "failed": the host was provably never reached (no live host, connect
//     refused) or it processed the call and refused it (typed RPC error) —
//     nothing was delivered, a NEW effect may retry;
//   - "indeterminate": the transport broke after the request may have left
//     this process (mid-call close, timeout, partial write) — the coordinator
//     records indeterminate and never blindly redelivers (RFC §10.6).
import { defaultIsPidAlive as isPidAlive } from "../fsx.js";
import type { JsonValue } from "../comb/types.js";

export type DispatchFailureOutcome = "failed" | "indeterminate";

/** Typed dispatch failure: `outcome` is the honest command terminal state. */
export class HarnessDispatchError extends Error {
  readonly outcome: DispatchFailureOutcome;
  constructor(outcome: DispatchFailureOutcome, message: string) {
    super(message);
    this.name = "HarnessDispatchError";
    this.outcome = outcome;
  }
}

export type HarnessStopResult = {
  /** True when the harness is provably down (clean stop confirmed or already gone). */
  stopped: boolean;
  detail: string;
};

export type HarnessControl = {
  send(beeName: string, text: string, deliveryId: string): Promise<void>;
  answer(beeName: string, inputRequestId: string, answer: JsonValue): Promise<void>;
  interrupt(beeName: string, reason?: string): Promise<void>;
  /** Open needs-input request id from durable runner events; null when none. */
  pendingInputId(beeName: string): Promise<string | null>;
  /** Clean, socket-only stop; never signals an unverified pid. */
  stop(beeName: string): Promise<HarnessStopResult>;
};

type LiveMeta = { controlSocket: string; hostPid: number };

async function liveMeta(beeName: string): Promise<LiveMeta | null> {
  const { readHsrMeta } = await import("../hsr/runDir.js");
  const meta = await readHsrMeta(beeName);
  if (!meta || meta.status === "exited" || !meta.controlSocket) return null;
  if (!meta.mirrorOfNode && !isPidAlive(meta.hostPid)) return null;
  return { controlSocket: meta.controlSocket, hostPid: meta.hostPid };
}

/** Classify an RPC failure that happened AFTER a connection was established. */
function classifyCallFailure(error: unknown): DispatchFailureOutcome {
  // A JSON-RPC error response carries a numeric code: the host received and
  // processed the request, and refused it — provably not delivered.
  return typeof (error as { code?: unknown })?.code === "number" ? "failed" : "indeterminate";
}

async function callControl(beeName: string, method: string, params: unknown): Promise<unknown> {
  const meta = await liveMeta(beeName);
  if (!meta) {
    throw new HarnessDispatchError("failed", `no live runner host for ${beeName}; nothing was delivered`);
  }
  const { connectRpcClient } = await import("../hsr/rpc.js");
  let client;
  try {
    client = await connectRpcClient(meta.controlSocket);
  } catch (error) {
    throw new HarnessDispatchError("failed", `control socket for ${beeName} is unreachable: ${String(error)}`);
  }
  try {
    return await client.call(method, params);
  } catch (error) {
    const outcome = classifyCallFailure(error);
    throw new HarnessDispatchError(
      outcome,
      outcome === "failed"
        ? `harness refused ${method}: ${error instanceof Error ? error.message : String(error)}`
        : `transport broke during ${method}; delivery outcome is unknowable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    client.close();
  }
}

export function hsrHarnessControl(): HarnessControl {
  return {
    async send(beeName, text, deliveryId) {
      // deliveryId rides the host's in-memory turn tracker only; no pending-
      // turn journal file is written, so the HSR auth-recovery drain can never
      // blindly redeliver a protocol command later.
      await callControl(beeName, "send", { text, deliveryId });
    },
    async answer(beeName, inputRequestId, answer) {
      await callControl(beeName, "answer", { requestId: inputRequestId, answer });
    },
    async interrupt(beeName) {
      await callControl(beeName, "interrupt", undefined);
    },
    async pendingInputId(beeName) {
      const { pendingNeedsInput } = await import("../hsr/observe.js");
      const pending = await pendingNeedsInput(beeName);
      return pending?.requestId ?? null;
    },
    async stop(beeName) {
      const { readHsrMeta } = await import("../hsr/runDir.js");
      const meta = await liveMeta(beeName);
      if (!meta) return { stopped: true, detail: "no live harness" };
      try {
        await callControl(beeName, "stop", undefined);
      } catch (error) {
        // The host may have exited between the liveness read and the call;
        // re-check before declaring the stop unconfirmed.
        const still = await liveMeta(beeName);
        if (!still) return { stopped: true, detail: "harness exited" };
        return {
          stopped: false,
          detail: `clean stop unconfirmed: ${error instanceof Error ? error.message : String(error)}; refusing to signal an unverified pid`,
        };
      }
      // Give the host a brief grace to tear down the harness child and
      // finalize its meta, exactly like the substrate's clean-stop path.
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        const current = await readHsrMeta(beeName);
        if (!current || current.status === "exited" || !isPidAlive(current.hostPid)) {
          return { stopped: true, detail: "clean stop confirmed" };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { stopped: false, detail: "stop acknowledged but exit unconfirmed within grace" };
    },
  };
}
