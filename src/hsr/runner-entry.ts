#!/usr/bin/env node
/**
 * Minimal detached HSR child entry. This module owns only payload hydration and
 * the runner-host lifecycle; parent-side spawning stays in runnerHost.ts.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadAdapterFor } from "./adapter-loader.js";
import { runHsrHost } from "./host.js";
import { hsrRunDir } from "./runDir.js";
import type { RunnerOpts } from "./types.js";

/** The JSON payload handed to a detached local HSR host. */
export type HsrRunPayload = {
  bee: string;
  kind: string;
  cwd: string;
  sessionId?: string;
  authKind?: "subscription" | "api-key";
  model?: string;
  /** Resume an existing provider session instead of starting fresh. */
  resume?: boolean;
  /** Lineage for HIVE_COMB/HIVE_PARENT env stamping (APIA-82). */
  comb?: string;
  parent?: string;
  spec: { command: string; args: string[]; env: Record<string, string> };
};

/**
 * Read a payload, load its one harness adapter, and live exactly as long as the
 * provider session. Also exported through runnerHost.ts for the __hsr-run CLI
 * compatibility path.
 */
export async function runHsrHostFromPayload(payloadPath: string | undefined): Promise<void> {
  if (!payloadPath) {
    process.stderr.write("hive __hsr-run: missing payload path\n");
    process.exit(1);
  }
  let payload: HsrRunPayload;
  try {
    payload = JSON.parse(await readFile(payloadPath, "utf8")) as HsrRunPayload;
  } catch (error) {
    process.stderr.write(`hive __hsr-run: unreadable payload ${payloadPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  const adapter = await loadAdapterFor(payload.kind);
  if (!adapter) {
    process.stderr.write(`hive __hsr-run: no HSR adapter for harness "${payload.kind}"\n`);
    process.exit(1);
    return;
  }
  // The harness child needs a complete env (PATH etc.), not just the spawn
  // overrides. Overlay the payload's resolved spec on the inherited host env.
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  Object.assign(childEnv, payload.spec.env);
  // HSR children have no pane, so HIVE_BEE is the pane-less identity anchor.
  childEnv.HIVE_BEE = payload.bee;
  childEnv.HIVE_COMB = payload.comb ?? payload.bee;
  if (payload.parent) childEnv.HIVE_PARENT = payload.parent;
  const opts: RunnerOpts = {
    bee: payload.bee,
    cwd: payload.cwd,
    env: childEnv,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.authKind ? { authKind: payload.authKind } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.resume ? { resume: true } : {}),
    command: payload.spec.command,
    args: payload.spec.args,
    runDir: hsrRunDir(payload.bee),
  };
  const handle = await runHsrHost({ bee: payload.bee, adapter, opts, queueStartup: true });
  const shutdown = async (): Promise<void> => {
    try {
      await handle.stop();
    } catch {
      // best-effort; we're exiting regardless
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await handle.done;
  process.exit(0);
}

// The CLI imports this module through runnerHost.ts for its fallback command,
// so execute only when node/tsx invoked runner-entry itself.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runHsrHostFromPayload(process.argv[2]).catch((error) => {
    process.stderr.write(`hive __hsr-run: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
