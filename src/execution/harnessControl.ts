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
import type { JsonValue } from "../comb/types.js";
import { inspectProcessBirth, sameProcessBirthFingerprint, type ProcessIdentityReader } from "../hsr/processIdentity.js";
import type { HsrMeta } from "../hsr/runDir.js";

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

export type HsrHarnessControlOptions = { processIdentityReader?: ProcessIdentityReader };

async function liveMeta(beeName: string, options: HsrHarnessControlOptions): Promise<HsrMeta | null> {
  const { readHsrMeta } = await import("../hsr/runDir.js");
  const meta = await readHsrMeta(beeName);
  if (!meta || meta.status === "exited" || !meta.controlSocket) return null;
  if (!meta.mirrorOfNode) {
    const identity = await inspectProcessBirth(meta.hostPid, meta.hostFingerprint, options.processIdentityReader);
    if (identity !== "match") return null;
  }
  return meta;
}

async function initialHostStopped(
  beeName: string,
  initial: HsrMeta,
  options: HsrHarnessControlOptions,
): Promise<boolean> {
  const { readHsrMeta } = await import("../hsr/runDir.js");
  const current = await readHsrMeta(beeName);
  if (initial.mirrorOfNode) return !current || current.status === "exited";
  const verdict = await inspectProcessBirth(initial.hostPid, initial.hostFingerprint, options.processIdentityReader);
  if (verdict === "gone" || verdict === "mismatch") return true;
  return verdict === "match" && !!current && current.status === "exited" &&
    current.hostPid === initial.hostPid &&
    current.startedAt === initial.startedAt &&
    sameProcessBirthFingerprint(current.hostFingerprint, initial.hostFingerprint);
}

/** Classify an RPC failure that happened AFTER a connection was established. */
function classifyCallFailure(error: unknown): DispatchFailureOutcome {
  // A JSON-RPC error response carries a numeric code: the host received and
  // processed the request, and refused it — provably not delivered.
  return typeof (error as { code?: unknown })?.code === "number" ? "failed" : "indeterminate";
}

async function callControl(
  beeName: string,
  method: string,
  params: unknown,
  options: HsrHarnessControlOptions,
): Promise<unknown> {
  const meta = await liveMeta(beeName, options);
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

export function hsrHarnessControl(options: HsrHarnessControlOptions = {}): HarnessControl {
  return {
    async send(beeName, text, deliveryId) {
      // deliveryId rides the host's in-memory turn tracker only; no pending-
      // turn journal file is written, so the HSR auth-recovery drain can never
      // blindly redeliver a protocol command later.
      await callControl(beeName, "send", { text, deliveryId }, options);
    },
    async answer(_beeName, _inputRequestId, _answer) {
      throw new HarnessDispatchError(
        "failed",
        "run.command answer is unavailable until the signed command carries an expected runner-host epoch",
      );
    },
    async interrupt(beeName) {
      await callControl(beeName, "interrupt", undefined, options);
    },
    async pendingInputId(beeName) {
      const { pendingNeedsInput } = await import("../hsr/observe.js");
      const pending = await pendingNeedsInput(beeName);
      return pending?.requestId ?? null;
    },
    async stop(beeName) {
      const { readHsrMeta } = await import("../hsr/runDir.js");
      const recorded = await readHsrMeta(beeName);
      if (!recorded || recorded.status === "exited") return { stopped: true, detail: "no live harness" };
      if (!recorded.mirrorOfNode) {
        const identity = await inspectProcessBirth(
          recorded.hostPid,
          recorded.hostFingerprint,
          options.processIdentityReader,
        );
        if (identity === "gone" || identity === "mismatch") {
          return { stopped: true, detail: "recorded harness incarnation exited" };
        }
        if (identity !== "match") {
          return { stopped: false, detail: "clean stop unconfirmed: runner host birth identity is unavailable" };
        }
      }
      const meta = await liveMeta(beeName, options);
      if (!meta) {
        return await initialHostStopped(beeName, recorded, options)
          ? { stopped: true, detail: "recorded harness incarnation exited" }
          : { stopped: false, detail: "clean stop unconfirmed: runner host changed during ownership validation" };
      }
      try {
        await callControl(beeName, "stop", undefined, options);
      } catch (error) {
        // The host may have exited between the liveness read and the call;
        // re-check before declaring the stop unconfirmed.
        if (await initialHostStopped(beeName, meta, options)) return { stopped: true, detail: "harness exited" };
        return {
          stopped: false,
          detail: `clean stop unconfirmed: ${error instanceof Error ? error.message : String(error)}; refusing to signal an unverified pid`,
        };
      }
      // Give the host a brief grace to tear down the harness child and
      // finalize its meta, exactly like the substrate's clean-stop path.
      const deadline = Date.now() + 2_500;
      while (Date.now() < deadline) {
        if (await initialHostStopped(beeName, meta, options)) {
          return { stopped: true, detail: "clean stop confirmed" };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { stopped: false, detail: "stop acknowledged but exit unconfirmed within grace" };
    },
  };
}
