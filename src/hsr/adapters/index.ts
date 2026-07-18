/**
 * HSR adapter registry (APIA-74).
 *
 * Maps a harness name to its RunnerAdapter. The SubstrateHsr and the daemon
 * socket look adapters up here rather than importing each adapter directly.
 * The map is typed against RunnerHarness, so a descriptor cannot flip
 * `runner:true` without a compile-linked adapter (or retain an adapter after
 * flipping it false). Drivers separately expose the same instances to the
 * shared interactive/headless capability registry.
 */

import type { RunnerAdapter } from "../types.js";
import type { RunnerHarness } from "../harness.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { openCodeAdapter } from "./opencode.js";
import { stubAdapter } from "./stub.js";

const ADAPTERS = {
  stub: stubAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  opencode: openCodeAdapter,
  cursor: cursorAdapter,
  grok: grokAdapter,
  kimi: kimiAdapter,
} satisfies Record<RunnerHarness, RunnerAdapter>;

/** The RunnerAdapter for a harness, or undefined if unmodeled. */
export function adapterFor(harness: string): RunnerAdapter | undefined {
  return (ADAPTERS as Readonly<Record<string, RunnerAdapter>>)[harness];
}
