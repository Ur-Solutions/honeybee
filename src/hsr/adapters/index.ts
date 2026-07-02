/**
 * HSR adapter registry (APIA-74).
 *
 * Maps a harness name to its RunnerAdapter. The SubstrateHsr and the daemon
 * socket look adapters up here rather than importing each adapter directly.
 * codex/opencode/etc. land in later units.
 */

import type { RunnerAdapter } from "../types.js";
import { stubAdapter } from "./stub.js";
import { claudeAdapter } from "./claude.js";

/** The RunnerAdapter for a harness, or undefined if unmodeled. */
export function adapterFor(harness: string): RunnerAdapter | undefined {
  switch (harness) {
    case "stub":
      return stubAdapter;
    case "claude":
      return claudeAdapter;
    default:
      return undefined;
  }
}
