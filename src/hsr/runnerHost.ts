// Local HSR runner-host launcher (APIA-76): resolves and forks the minimal
// detached child entry. The child lifecycle lives in runner-entry.ts; its
// __hsr-run compatibility export stays here for the existing CLI dispatch.
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOrphanedChildGroupStopped } from "./observe.js";
import { ensureHsrRunDir, hsrRunDir, readHsrMeta, readHsrMetaStrict } from "./runDir.js";
import { redactHsrPayloadError, type HsrRunPayload } from "./runner-entry.js";

export { runHsrHostFromPayload } from "./runner-entry.js";
export type { HsrRunPayload } from "./runner-entry.js";

// Parent-process handles for detached hosts launched by this process. Keeping
// the returned ChildProcess and an observed-exit tombstone lets immediate
// rollback target its own spawn before meta.json exists, without looking up a
// same-name runtime or adopting a later same-number pid from metadata. Normal
// SIGTERM shutdown still runs the host's birth-validated descendant teardown.
const spawnedHosts = new Map<number, ReturnType<typeof spawnChild>>();
const recentlyExitedSpawnedHosts = new Set<number>();
const HSR_CHILD_ADMISSION_TIMEOUT_MS = 30_000;


const HSR_PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
const HSR_PRELOAD_PREFIXES = ["--import=", "--require=", "--loader=", "--experimental-loader="];

/**
 * Preserve only hooks needed to execute a source runner entry. Inheriting the
 * embedding process's execution mode (`-e`, `--test`, `--watch`, inspectors,
 * etc.) can make Node ignore the appended entry or stall every detached host.
 */
export function inheritableExecArgvForHsr(): string[] {
  const inherited: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]!;
    if (
      HSR_PRELOAD_PREFIXES.some((prefix) => arg.startsWith(prefix)) ||
      (arg.startsWith("-r") && arg !== "-r" && !arg.startsWith("--"))
    ) {
      inherited.push(arg);
      continue;
    }
    if (!HSR_PRELOAD_FLAGS.has(arg)) continue;
    const value = process.execArgv[index + 1];
    if (value === undefined) continue;
    inherited.push(arg, value);
    index += 1;
  }
  return inherited;
}


export type ResolvedHsrEntry = {
  path: string;
  mode: "dedicated" | "cli-fallback";
};

type Realpath = (path: string) => Promise<string>;

/** Candidate emitted beside runnerHost.ts/runnerHost.js in source and builds. */
export function dedicatedHsrEntryCandidate(runnerHostEntry: string): string | undefined {
  const extension = extname(runnerHostEntry);
  if (![".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return undefined;
  return join(dirname(runnerHostEntry), `runner-entry${extension}`);
}

/**
 * True when this module's own resolved entry IS the self-contained cloud
 * runner-host bundle (`hive-runner-host-<version>.mjs`, emitted by
 * buildRunnerHostBundle.ts). In a cloud Cell there is no dedicated runner-entry
 * sibling on disk — the whole runner-host is this one file — so the bee host is
 * spawned by re-execing the bundle itself with the `__hsr-run` marker.
 */
export function isRunnerHostBundleEntry(runnerHostEntry: string): boolean {
  return extname(runnerHostEntry) === ".mjs" && basename(runnerHostEntry).startsWith("hive-runner-host-");
}


/**
 * Resolve the dedicated child from this module's own location. process.argv[1]
 * belongs to the embedding executable and may be a test file or another CLI;
 * treating it as Hive's CLI can recursively relaunch arbitrary entrypoints.
 */
export async function resolveHsrEntry(
  raw: string | undefined = fileURLToPath(import.meta.url),
  resolveRealpath: Realpath = realpath,
): Promise<ResolvedHsrEntry> {
  if (!raw) throw new Error("hsr: could not resolve runnerHost module entry path");
  let runnerHostEntry = raw;
  try {
    runnerHostEntry = await resolveRealpath(raw);
  } catch {
    // Keep the raw module path so the expected sibling remains diagnostic.
  }
  const candidate = dedicatedHsrEntryCandidate(runnerHostEntry);
  if (!candidate) {
    throw new Error(`hsr: unsupported runnerHost module entry ${runnerHostEntry}`);
  }
  try {
    return { path: await resolveRealpath(candidate), mode: "dedicated" };
  } catch {
    // No dedicated sibling on disk. A self-contained runner-host bundle (cloud
    // Cell) has none, so re-exec THIS bundle with the `__hsr-run` marker — the
    // same command remoteHost.main() dispatches. This uses the module's OWN
    // resolved entry (not process.argv[1]), preserving the safety that an
    // ordinary imported runnerHost never re-execs an arbitrary embedding CLI.
    if (isRunnerHostBundleEntry(runnerHostEntry)) {
      return { path: runnerHostEntry, mode: "cli-fallback" };
    }
    throw new Error(`hsr: dedicated runner entry unavailable (expected ${candidate})`);
  }
}


/** Construct child argv for either the dedicated entry or CLI fallback. */
export function hsrEntryArgv(entry: ResolvedHsrEntry, payloadPath: string): string[] {
  return [entry.path, ...(entry.mode === "cli-fallback" ? ["__hsr-run"] : []), payloadPath];
}

export type SpawnHsrHostDependencies = {
  makeTempDir?: (prefix: string) => Promise<string>;
  resolveEntry?: () => Promise<ResolvedHsrEntry>;
  spawn?: typeof spawnChild;
};

/**
 * The Cell-sandbox payload fields every HSR RELAUNCH must replay from the
 * session record: an execution Cell (executionRunId) keeps its OS write
 * boundary across revive/swap, and the extra `--sandbox-write` grants ride
 * along so a revived Layout-v2 Cell can still write its wrapper `box/`.
 */
export function hsrCellPayloadFields(
  record: { executionRunId?: string; sandboxWriteRoots?: string[] },
): Pick<HsrRunPayload, "filesystemWriteScope" | "extraWriteRoots"> {
  return {
    ...(record.executionRunId ? { filesystemWriteScope: "cwd" as const } : {}),
    ...(record.sandboxWriteRoots?.length ? { extraWriteRoots: [...record.sandboxWriteRoots] } : {}),
  };
}


/**
 * Fork the detached `hive __hsr-run` host for a bee and return its pid. Mirrors
 * spawnDetachedRun/createLauncher: an 0600 payload file under a temp dir, the
 * host's stdout/stderr to a log file under the run dir, detached + unref'd so it
 * survives the CLI process.
 */
export async function spawnHsrHost(
  payload: HsrRunPayload,
  dependencies: SpawnHsrHostDependencies = {},
): Promise<number> {
  try {
    await realpath(payload.cwd);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "is no longer available"
      : "could not be verified";
    throw new Error(`HSR working directory ${reason}; restore or recreate the working copy before launch`);
  }
  await ensureHsrRunDir(payload.bee);
  const dir = await (dependencies.makeTempDir ?? mkdtemp)(join(tmpdir(), "hive-hsr-payload-"));
  const payloadPath = join(dir, "payload.json");
  let logHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    logHandle = await open(join(hsrRunDir(payload.bee), "host.log"), "a", 0o600);
    const entry = await (dependencies.resolveEntry ?? (() => resolveHsrEntry()))();
    const childArgv = [...inheritableExecArgvForHsr(), ...hsrEntryArgv(entry, payloadPath)];
    const child = (dependencies.spawn ?? spawnChild)(process.execPath, childArgv, {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env },
    });
    // Async spawn failures surface via 'error' after spawn() returns; the
    // missing-pid check below converts them into a thrown error.
    child.once("error", () => undefined);
    if (!child.pid) throw new Error(`hive __hsr-run: spawn failed (no pid for ${payload.bee})`);
    const pid = child.pid;
    recentlyExitedSpawnedHosts.delete(pid);
    spawnedHosts.set(pid, child);
    child.once("exit", () => {
      spawnedHosts.delete(pid);
      recentlyExitedSpawnedHosts.add(pid);
      const expiry = setTimeout(() => recentlyExitedSpawnedHosts.delete(pid), 60_000);
      expiry.unref?.();
    });
    child.unref();
    try {
      await waitForSpawnedHostChildAdmission(payload.bee, pid, HSR_CHILD_ADMISSION_TIMEOUT_MS);
    } catch (error) {
      const stopped = await stopSpawnedHsrHost(pid);
      const meta = await readHsrMetaStrict(payload.bee).catch(() => null);
      const childStopped = meta?.hostPid === pid
        ? await ensureOrphanedChildGroupStopped(meta)
        : false;
      const detail = error instanceof Error ? error.message : String(error);
      if ((stopped !== "stopped" && stopped !== "unconfirmed") || !childStopped) {
        throw new Error(`${detail}; exact spawned HSR host/child rollback is unconfirmed`);
      }
      throw error;
    }
    return pid;
  } catch (error) {
    // If the child never consumed the capability (entry resolution/spawn
    // failure, early crash, admission timeout), the parent owns cleanup. This
    // is deliberately recursive only over the exact mkdtemp directory it just
    // created; the operator-supplied child path uses stricter unlink+rmdir.
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw redactHsrPayloadError(error, payload);
  } finally {
    await logHandle?.close().catch(() => undefined);
  }
}

async function waitForSpawnedHostChildAdmission(bee: string, hostPid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let observedExpectedHost = false;
  while (Date.now() < deadline) {
    const meta = await readHsrMetaStrict(bee);
    if (meta) {
      if (meta.hostPid !== hostPid && observedExpectedHost) {
        throw new Error(`HSR birth admission for ${bee} was replaced before publication`);
      }
      if (meta.hostPid === hostPid) observedExpectedHost = true;
      if (meta.hostPid === hostPid && meta.status === "exited") {
        throw new Error(
          meta.startupFailure?.message ??
          `HSR birth admission for ${bee} exited before a runnable child was admitted`,
        );
      }
      if (
        meta.hostPid === hostPid &&
        (meta.childAdmission === "admitted" || meta.childAdmission === "none")
      ) return;
    }
    if (spawnedHsrHostHasExited(hostPid)) {
      throw new Error(`HSR host ${hostPid} exited before child birth admission for ${bee}`);
    }
    await sleep(HSR_HOST_POLL_INTERVAL_MS);
  }
  throw new Error(`HSR child birth admission for ${bee} timed out after ${timeoutMs}ms`);
}

async function waitForSpawnedHostExit(child: ReturnType<typeof spawnChild>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(child.exitCode !== null || child.signalCode !== null);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** True only when this spawning process observed the exact child exit. */
export function spawnedHsrHostHasExited(expectedPid: number): boolean {
  if (recentlyExitedSpawnedHosts.has(expectedPid)) return true;
  const child = spawnedHosts.get(expectedPid);
  return !!child && (child.exitCode !== null || child.signalCode !== null);
}

export type SpawnedHsrHostStop = "stopped" | "unconfirmed" | "unknown";

/** Stop only a detached HSR host born from this process's spawn handle. */
export async function stopSpawnedHsrHost(expectedPid: number): Promise<SpawnedHsrHostStop> {
  if (spawnedHsrHostHasExited(expectedPid)) return "stopped";
  const child = spawnedHosts.get(expectedPid);
  if (!child || child.pid !== expectedPid) return "unknown";
  if (await waitForSpawnedHostExit(child, 0)) return "stopped";
  child.kill("SIGTERM");
  if (await waitForSpawnedHostExit(child, 3_000)) return "stopped";
  child.kill("SIGKILL");
  await waitForSpawnedHostExit(child, 1_000);
  // A forced host exit cannot prove its detached harness tree also stopped.
  // The caller must surface this instead of silently accepting an untracked
  // runtime whose replacement metadata cannot safely be adopted for cleanup.
  return "unconfirmed";
}


export const HSR_HOST_POLL_INTERVAL_MS = 10;

export type WaitForHsrHostDependencies = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hasSession?: (bee: string) => Promise<boolean>;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the runner host records a live session, or the timeout lapses. */
export async function waitForHsrHost(
  bee: string,
  timeoutMs: number,
  dependencies: WaitForHsrHostDependencies = {},
): Promise<boolean> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const deadline = now() + timeoutMs;
  let hasSession = dependencies.hasSession;
  while (now() < deadline) {
    if (!hasSession) {
      // Parent-side only. Keeping this import out of the module graph prevents
      // the detached runner entry from loading substrate observation helpers.
      const substrate = (await import("./substrate.js")).hsrSubstrate();
      hasSession = (name) => substrate.hasSession(name);
    }
    if (await hasSession(bee).catch(() => false)) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await pause(Math.min(HSR_HOST_POLL_INTERVAL_MS, remainingMs));
  }
  return false;
}

/**
 * Strong readiness gate: unlike hasSession, a queued/booting host is not ready.
 * Used by execution protocol launches before emitting harness.running.
 */
export async function waitForHsrReadiness(
  bee: string,
  timeoutMs: number,
  dependencies: Pick<WaitForHsrHostDependencies, "now" | "sleep"> & { readMeta?: typeof readHsrMeta } = {},
): Promise<boolean> {
  const now = dependencies.now ?? Date.now;
  const pause = dependencies.sleep ?? sleep;
  const readMeta = dependencies.readMeta ?? readHsrMeta;
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const meta = await readMeta(bee).catch(() => null);
    if (meta?.status === "running" && typeof meta.runningAt === "string") return true;
    if (meta?.status === "exited") return false;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await pause(Math.min(HSR_HOST_POLL_INTERVAL_MS, remainingMs));
  }
  return false;
}
