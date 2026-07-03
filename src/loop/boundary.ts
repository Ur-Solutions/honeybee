// Iteration boundary detection for the loop driver (PRD §14): decide when a
// bee's turn has ended by RACING seal detection against idle detection. Prefer a
// fresh seal; fall back to ~3s pane-idle for harnesses/tasks that never seal.
//
// Split out of loop/flow.ts so the driver (runLoop → resolveBoundarySeal) stays
// focused on policy while the mechanical pane/seal polling lives here. No
// console.* — callers own stdout/stderr.

import type { BeeHandle } from "../flow/index.js";
import { isPermissionPromptPane } from "../readiness.js";
import { scanLatestSeal, type SealRecord } from "../seal.js";
import { substrateFor } from "../substrates/index.js";
import { sleep } from "./internal.js";

export const IDLE_FALLBACK_MS = 3_000; // pane stability window (PRD §14: idle detection ~3s)
export const BOUNDARY_GRACE_MS = 2_000; // extra slack after idle for a late-landing seal
export const BOUNDARY_POLL_MS = 500;

/** Optional test override for the boundary's pane capture (avoids real tmux). */
export type CapturePaneHook = (args: { handle: BeeHandle; iter: number }) => Promise<string>;

/**
 * Iteration boundary detector — RACE seal detection against idle detection
 * (PRD §14: prefer the seal; fall back to ~3s idle detection for
 * harnesses/tasks that don't seal). One poll loop checks for a seal file beyond
 * the PRE-SEND filename cursor while fingerprinting the bee's pane; once the
 * pane has been stable for idleMs + graceMs with no new seal, the
 * boundary is concluded unsealed. timeoutMs remains the overall cap so a
 * never-idle, never-sealing bee cannot wedge an iteration forever.
 */
export async function waitForIterationBoundary(args: {
  handle: BeeHandle;
  iter: number;
  baselineFilename: string | null;
  timeoutMs: number;
  idleMs: number;
  graceMs: number;
  pollMs: number;
  signal?: AbortSignal | undefined;
  capturePane?: CapturePaneHook | undefined;
}): Promise<{ seal: SealRecord | null; blocked: boolean; highWaterFilename: string | null }> {
  const { handle } = args;
  const started = Date.now();
  let lastPane: string | undefined;
  let stableSince = Date.now();
  let goneSince: number | undefined;
  let highWaterFilename = args.baselineFilename;
  while (Date.now() - started < args.timeoutMs) {
    if (args.signal?.aborted) throw new Error(`loop boundary aborted: ${handle.name}`);
    const latest = await scanLatestSeal(handle.name, { afterFilename: highWaterFilename }).catch(() => null);
    if (latest?.seal) {
      highWaterFilename = latest.filename;
      return { seal: latest.seal, blocked: false, highWaterFilename };
    }
    const observed = await captureBoundaryPane(handle, args.iter, args.capturePane);
    if (observed === "gone") {
      // The session verifiably ended. A one-shot bee may have written its
      // seal moments before exiting, so keep polling the seal stream for graceMs
      // before concluding the boundary unsealed.
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= args.graceMs) return { seal: null, blocked: false, highWaterFilename };
    } else if (observed !== null) {
      goneSince = undefined;
      if (observed !== lastPane) {
        lastPane = observed;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= args.idleMs + args.graceMs) {
        // A stable pane sitting on an approval prompt is NOT a finished turn —
        // the bee is blocked on a human decision. Advancing would kill it
        // (fresh carrier) or paste the next prompt into the approval UI.
        return { seal: null, blocked: isPermissionPromptPane(lastPane ?? ""), highWaterFilename };
      }
    }
    // observed === null: transient capture failure (e.g. an ssh hiccup) — skip
    // the stability bookkeeping so it cannot masquerade as a stable idle pane.
    await sleep(args.pollMs);
  }
  return { seal: null, blocked: false, highWaterFilename }; // overall cap reached — unsealed boundary.
}

/**
 * Pane snapshot for the boundary's idleness fingerprint. Returns the pane
 * text, "gone" when the session verifiably no longer exists, or null when the
 * capture failed transiently (transport trouble) and nothing can be inferred.
 */
export async function captureBoundaryPane(
  handle: BeeHandle,
  iter: number,
  capturePane?: CapturePaneHook | undefined,
): Promise<string | "gone" | null> {
  if (capturePane) return capturePane({ handle, iter }).catch(() => null);
  try {
    const { loadSession } = await import("../store.js");
    const record = await loadSession(handle.name);
    // No record: nothing to capture — an empty observable pane. The idle
    // window still applies, so a seal that is about to land gets its chance
    // before the boundary concludes.
    if (!record) return "";
    const substrate = substrateFor(record);
    try {
      return await substrate.capture(record.tmuxTarget, 200, record.agentPaneId);
    } catch {
      // Clean "no such session" means the bee died; a transport throw means
      // we simply don't know this pass.
      const alive = await substrate.hasSession(record.tmuxTarget).catch(() => null);
      return alive === false ? "gone" : null;
    }
  } catch {
    return null;
  }
}
