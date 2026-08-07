#!/usr/bin/env node
/**
 * Minimal detached HSR child entry. This module owns only payload hydration and
 * the runner-host lifecycle; parent-side spawning stays in runnerHost.ts.
 */

import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

function payloadStrings(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (value.length > 0) found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) payloadStrings(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) payloadStrings(item, found);
  }
  return found;
}

/** Strip every payload-derived string from an error before it crosses a process boundary. */
export function redactHsrPayloadError(error: unknown, payload: HsrRunPayload): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of [...payloadStrings(payload)].sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(value, "[redacted]");
  }
  return new Error(message || "HSR runner startup failed");
}

async function validatedHsrPayloadPath(payloadPath: string): Promise<{ payloadPath: string; dir: string }> {
  if (basename(payloadPath) !== "payload.json") throw new Error("invalid HSR payload handoff path");
  const rawDir = dirname(resolve(payloadPath));
  const [realTmp, realDir, dirStat, payloadStat] = await Promise.all([
    realpath(tmpdir()),
    realpath(rawDir),
    lstat(rawDir),
    lstat(payloadPath),
  ]).catch(() => { throw new Error("invalid HSR payload handoff path"); });
  const owns = (uid: number): boolean => process.getuid === undefined || uid === process.getuid();
  if (
    dirname(realDir) !== realTmp ||
    !basename(realDir).startsWith("hive-hsr-payload-") ||
    !dirStat.isDirectory() || dirStat.isSymbolicLink() || !owns(dirStat.uid) || (dirStat.mode & 0o077) !== 0 ||
    !payloadStat.isFile() || payloadStat.isSymbolicLink() || !owns(payloadStat.uid) || (payloadStat.mode & 0o077) !== 0 ||
    await realpath(payloadPath) !== join(realDir, "payload.json")
  ) {
    throw new Error("invalid HSR payload handoff path");
  }
  return { payloadPath: join(realDir, "payload.json"), dir: realDir };
}

/**
 * Consume the private launch capability before any harness/provider await.
 * Keeping the descriptor open while unlinking makes the exact bytes we read
 * independent of the pathname; removing the now-empty directory closes the
 * durable secret-retention window even when parsing or startup later fails.
 */
export async function consumeHsrRunPayload(payloadPath: string): Promise<HsrRunPayload> {
  // __hsr-run is operator-callable. Validate the exact parent-created handoff
  // before any cleanup so an arbitrary `.../payload.json` can never authorize
  // unlinking a user file or removing its directory.
  const validated = await validatedHsrPayloadPath(payloadPath);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let raw: string;
  try {
    handle = await open(validated.payloadPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    raw = await handle.readFile("utf8");
    await unlink(validated.payloadPath);
    await handle.close();
    handle = undefined;
    await rmdir(validated.dir);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(validated.payloadPath).catch(() => undefined);
    await rmdir(validated.dir).catch(() => undefined);
    throw new Error("hive __hsr-run: unable to securely consume payload");
  }
  try {
    return JSON.parse(raw) as HsrRunPayload;
  } catch {
    // JSON parser diagnostics can quote source fragments. Never let bytes from
    // a credential-bearing payload reach stderr or a parent error result.
    throw new Error("hive __hsr-run: invalid payload JSON");
  }
}

export type StartHsrHostFromPayloadDependencies = {
  loadAdapter?: typeof loadAdapterFor;
  runHost?: typeof runHsrHost;
};

/** Consume and start one host, separated from process-exit ownership for tests. */
export async function startHsrHostFromPayload(
  payloadPath: string | undefined,
  dependencies: StartHsrHostFromPayloadDependencies = {},
) {
  if (!payloadPath) throw new Error("hive __hsr-run: missing payload path");
  const payload = await consumeHsrRunPayload(payloadPath);
  try {
    return await startConsumedHsrPayload(payload, dependencies);
  } catch (error) {
    throw redactHsrPayloadError(error, payload);
  }
}

async function startConsumedHsrPayload(
  payload: HsrRunPayload,
  dependencies: StartHsrHostFromPayloadDependencies,
) {
  const adapter = await (dependencies.loadAdapter ?? loadAdapterFor)(payload.kind);
  if (!adapter) throw new Error("hive __hsr-run: no HSR adapter for requested harness");
  return hydrateAndStartConsumedPayload(payload, adapter, dependencies.runHost ?? runHsrHost);
}

/**
 * Read a payload, load its one harness adapter, and live exactly as long as the
 * provider session. Also exported through runnerHost.ts for the __hsr-run CLI
 * compatibility path.
 */
export async function runHsrHostFromPayload(payloadPath: string | undefined): Promise<void> {
  let handle;
  try {
    handle = await startHsrHostFromPayload(payloadPath);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "hive __hsr-run: startup failed"}\n`);
    process.exit(1);
  }
  if (!handle) return;
  const payload = handle.payload;
  const host = handle.host;
  const shutdown = async (): Promise<void> => {
    try {
      await host.stop();
    } catch {
      // best-effort; we're exiting regardless
    }
    shutdownCellSandbox();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  await host.done;
  shutdownCellSandbox();
  process.exit(0);
}

async function hydrateAndStartConsumedPayload(
  payload: HsrRunPayload,
  adapter: NonNullable<Awaited<ReturnType<typeof loadAdapterFor>>>,
  runHost: typeof runHsrHost,
) {
  if (payload.filesystemWriteScope === "cwd") {
    // This detached process belongs to one execution Cell. Align process.cwd
    // before Sandbox Runtime discovers repository-local mandatory denies; the
    // provider child receives the same absolute cwd below.
    process.chdir(realpathSync(payload.cwd));
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
  const host = await runHost({ bee: payload.bee, adapter, opts, queueStartup: true });
  return { payload, host };
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
