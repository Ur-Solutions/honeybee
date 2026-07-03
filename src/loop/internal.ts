// Small shared helpers for the loop driver (flow.ts), the boundary detector
// (boundary.ts), and the spawn helpers (spawn.ts). Kept in a leaf module so all
// three can import them without forming a cycle (flow.ts already imports
// boundary.ts and spawn.ts).

import type { BeeHandle } from "../flow/index.js";
import type { SessionRecord } from "../store.js";

/** Per-harness boot timeouts (mirror cli.ts defaultBootMs). */
export function bootMs(agent: string): number {
  switch (agent) {
    case "claude":
      return 15_000;
    case "codex":
      return 30_000;
    case "opencode":
      return 15_000;
    case "grok":
      return 10_000;
    case "pi":
      return 10_000;
    case "droid":
      return 5_000;
    default:
      return 10_000;
  }
}

/** Project a saved SessionRecord onto the substrate-neutral BeeHandle shape. */
export function handleOf(record: SessionRecord): BeeHandle {
  const handle: BeeHandle = {
    id: record.id ?? record.name,
    name: record.name,
    agent: record.agent,
    cwd: record.cwd,
  };
  if (record.node) handle.node = record.node;
  return handle;
}

export async function readFileSafe(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8").catch(() => "");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
