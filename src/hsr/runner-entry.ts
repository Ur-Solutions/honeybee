#!/usr/bin/env node
/**
 * Minimal detached HSR child entry. This module owns only payload hydration and
 * the runner-host lifecycle; parent-side spawning stays in runnerHost.ts.
 */

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadAdapterFor } from "./adapter-loader.js";
import {
  initializeCellSandbox,
  shutdownCellSandbox,
  withoutAmbientProviderState,
} from "./cellSandbox.js";
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
  accountId?: string;
  model?: string;
  /** Trusted execution-protocol filesystem boundary. */
  filesystemWriteScope?: "cwd";
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
  if (payload.filesystemWriteScope === "cwd") {
    // This detached process belongs to one execution Cell. Align process.cwd
    // before Sandbox Runtime discovers repository-local mandatory denies; the
    // provider child receives the same absolute cwd below.
    process.chdir(realpathSync(payload.cwd));
  }
  const adapter = await loadAdapterFor(payload.kind);
  if (!adapter) {
    process.stderr.write(`hive __hsr-run: no HSR adapter for harness "${payload.kind}"\n`);
    process.exit(1);
    return;
  }
  // The harness child needs a complete env (PATH etc.), not just the spawn
  // overrides. Overlay the payload's resolved spec on the inherited host env.
  let childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  if (payload.filesystemWriteScope === "cwd") {
    childEnv = withoutAmbientProviderState(payload.kind, childEnv, payload.spec.env);
  }
  Object.assign(childEnv, payload.spec.env);
  // HSR children have no pane, so HIVE_BEE is the pane-less identity anchor.
  childEnv.HIVE_BEE = payload.bee;
  childEnv.HIVE_COMB = payload.comb ?? payload.bee;
  if (payload.parent) childEnv.HIVE_PARENT = payload.parent;
  let cellSandbox: RunnerOpts["cellSandbox"];
  if (payload.filesystemWriteScope === "cwd") {
    const initialized = initializeCellSandbox({
      kind: payload.kind,
      cwd: payload.cwd,
      runDir: hsrRunDir(payload.bee),
      env: childEnv,
    });
    childEnv = initialized.env;
    cellSandbox = initialized.backend;
  }
  const opts: RunnerOpts = {
    bee: payload.bee,
    cwd: payload.cwd,
    env: childEnv,
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.authKind ? { authKind: payload.authKind } : {}),
    ...(payload.accountId ? { accountId: payload.accountId } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.resume ? { resume: true } : {}),
    ...(payload.filesystemWriteScope ? { filesystemWriteScope: payload.filesystemWriteScope } : {}),
    ...(cellSandbox ? { cellSandbox } : {}),
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
    shutdownCellSandbox();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await handle.done;
  shutdownCellSandbox();
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
