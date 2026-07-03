/**
 * HSR adapter registry (APIA-74).
 *
 * Maps a harness name to its RunnerAdapter. The SubstrateHsr and the daemon
 * socket look adapters up here rather than importing each adapter directly.
 *
 * The map is typed `Record<RunnerHarness, RunnerAdapter>`, where RunnerHarness
 * is derived from the harness registry's `runner` flags (harness.ts, HIVE-20).
 * That is the compile-time link: declaring `runner: true` on a descriptor
 * without registering its adapter here — or registering an adapter for a
 * harness the registry doesn't model as a runner — fails tsc.
 */

import type { RunnerAdapter } from "../types.js";
import type { RunnerHarness } from "../harness.js";
import { stubAdapter } from "./stub.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

const ADAPTERS: Record<RunnerHarness, RunnerAdapter> = {
  stub: stubAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
};

/** The RunnerAdapter for a harness, or undefined if unmodeled. */
export function adapterFor(harness: string): RunnerAdapter | undefined {
  return (ADAPTERS as Partial<Record<string, RunnerAdapter>>)[harness];
}
