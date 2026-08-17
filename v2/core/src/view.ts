/**
 * B8 — the derived read model as a pure function. This is the ONE place the
 * user-facing questions (working / waiting_for_you / reachable / blocked) are
 * answered. `CoreStore.view()` calls it against the live store; the v2 CLI's
 * read-only SQLite fallback calls it against directly-read rows so a stale
 * read still derives through the same logic.
 */
import type { BeeRow, BeeView, Flag, RuntimeRow } from "./types.ts";

export function deriveBeeView(
  beeId: string,
  bee: BeeRow | null,
  runtime: RuntimeRow | null,
  flags: Flag[],
  opts: { readCursor?: number } = {},
): BeeView {
  if (!bee) {
    // Deleted (or never-existed) bee: unreachable — the one lifecycle that is.
    return {
      beeId,
      exists: false,
      lifecycle: null,
      generation: null,
      runtimeState: null,
      exitCause: null,
      working: false,
      waitingForYou: false,
      lastOutputAt: null,
      reachable: false,
      blocked: false,
      flags: [],
    };
  }
  const state = runtime?.state ?? null;
  const working = state === "booting" || state === "running";
  const unreadOutput =
    bee.lastOutputAt != null && (opts.readCursor == null || opts.readCursor < bee.lastOutputAt);
  const waitingForYou = state === "idle" || (state === "stopped" && unreadOutput);
  return {
    beeId,
    exists: true,
    lifecycle: bee.lifecycle,
    generation: runtime?.generation ?? null,
    runtimeState: state,
    exitCause: runtime?.exitCause ?? null,
    working,
    waitingForYou,
    lastOutputAt: bee.lastOutputAt,
    reachable: true, // lifecycle ≠ deleted (deleted rows do not exist). Nothing else.
    blocked: flags.length > 0,
    flags,
  };
}
