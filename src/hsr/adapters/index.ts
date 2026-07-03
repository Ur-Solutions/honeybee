/**
 * HSR adapter registry (APIA-74).
 *
 * Maps a harness name to its RunnerAdapter. The SubstrateHsr and the daemon
 * socket look adapters up here rather than importing each adapter directly.
 * Real harnesses register their adapter on the agent capability registry
 * (AGENT_DRIVERS.hsrAdapter in drivers.ts) so a new HSR-capable agent is one
 * table entry; only the test-only stub stays here.
 */

import type { RunnerAdapter } from "../types.js";
import { hsrAdapterForAgent } from "../../drivers.js";
import { stubAdapter } from "./stub.js";

/** The RunnerAdapter for a harness, or undefined if unmodeled. */
export function adapterFor(harness: string): RunnerAdapter | undefined {
  // "stub" is a test-only harness, not a spawnable agent kind — kept out of
  // AGENT_DRIVERS so it never surfaces in pickers or driver validation.
  if (harness === "stub") return stubAdapter;
  return hsrAdapterForAgent(harness);
}
