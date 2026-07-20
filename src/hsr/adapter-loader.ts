/**
 * Child-side HSR adapter loader.
 *
 * The synchronous registry in adapters/index.ts is useful to parent-side
 * capability checks, but importing it in a detached runner eagerly evaluates
 * every harness adapter. Keep this registry async so a runner loads only the
 * adapter named by its payload.
 */

import type { RunnerHarness } from "./harness.js";
import type { RunnerAdapter } from "./types.js";

export type RunnerAdapterLoader = () => Promise<RunnerAdapter>;

const ADAPTER_LOADERS = {
  stub: async () => (await import("./adapters/stub.js")).stubAdapter,
  claude: async () => (await import("./adapters/claude.js")).claudeAdapter,
  codex: async () => (await import("./adapters/codex.js")).codexAdapter,
  opencode: async () => (await import("./adapters/opencode.js")).openCodeAdapter,
  cursor: async () => (await import("./adapters/cursor.js")).cursorAdapter,
  grok: async () => (await import("./adapters/grok.js")).grokAdapter,
  kimi: async () => (await import("./adapters/kimi.js")).kimiAdapter,
} satisfies Record<RunnerHarness, RunnerAdapterLoader>;

/** Load only the adapter for `harness`, or return undefined when unmodeled. */
export async function loadAdapterFor(
  harness: string,
  loaders: Readonly<Record<string, RunnerAdapterLoader>> = ADAPTER_LOADERS,
): Promise<RunnerAdapter | undefined> {
  // A direct own-key check keeps prototype names such as `toString` from being
  // treated as loaders when the harness value came from an external payload.
  if (!Object.hasOwn(loaders, harness)) return undefined;
  return loaders[harness]?.();
}
