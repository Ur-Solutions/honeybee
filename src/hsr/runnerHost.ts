// Local HSR runner-host launcher (APIA-76): resolves and forks the minimal
// detached child entry. The child lifecycle lives in runner-entry.ts; its
// __hsr-run compatibility export stays here for the existing CLI dispatch.
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { ensureHsrRunDir, hsrRunDir } from "./runDir.js";
import type { HsrRunPayload } from "./runner-entry.js";

export { runHsrHostFromPayload } from "./runner-entry.js";
export type { HsrRunPayload } from "./runner-entry.js";


/** process.execArgv minus flags that would change the child's execution mode. */
export function inheritableExecArgvForHsr(): string[] {
  return process.execArgv.filter(
    (arg) => arg !== "--test" && !arg.startsWith("--test=") && arg !== "--watch" && !arg.startsWith("--watch="),
  );
}


export type ResolvedHsrEntry = {
  path: string;
  mode: "dedicated" | "cli-fallback";
};

type Realpath = (path: string) => Promise<string>;

/** Candidate emitted beside cli.ts/cli.js for source and built execution. */
export function dedicatedHsrEntryCandidate(cliEntry: string): string | undefined {
  const extension = extname(cliEntry);
  if (![".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return undefined;
  return join(dirname(cliEntry), "hsr", `runner-entry${extension}`);
}


/**
 * Resolve the dedicated child entry, retaining the CLI's hidden __hsr-run path
 * as a compatibility fallback for incomplete or custom package layouts.
 */
export async function resolveHsrEntry(
  raw: string | undefined = process.argv[1],
  resolveRealpath: Realpath = realpath,
): Promise<ResolvedHsrEntry> {
  if (!raw) throw new Error("hsr: could not resolve CLI entry path (process.argv[1] is empty)");
  let cliEntry = raw;
  try {
    cliEntry = await resolveRealpath(raw);
  } catch {
    // Preserve the current raw-entry fallback when argv[1] cannot be resolved.
  }
  const candidate = dedicatedHsrEntryCandidate(cliEntry);
  if (candidate) {
    try {
      return { path: await resolveRealpath(candidate), mode: "dedicated" };
    } catch {
      // Older/custom installs may not contain the dedicated artifact.
    }
  }
  return { path: cliEntry, mode: "cli-fallback" };
}


/** Construct child argv for either the dedicated entry or CLI fallback. */
export function hsrEntryArgv(entry: ResolvedHsrEntry, payloadPath: string): string[] {
  return [entry.path, ...(entry.mode === "cli-fallback" ? ["__hsr-run"] : []), payloadPath];
}


/**
 * Fork the detached `hive __hsr-run` host for a bee and return its pid. Mirrors
 * spawnDetachedRun/createLauncher: an 0600 payload file under a temp dir, the
 * host's stdout/stderr to a log file under the run dir, detached + unref'd so it
 * survives the CLI process.
 */
export async function spawnHsrHost(payload: HsrRunPayload): Promise<number> {
  await ensureHsrRunDir(payload.bee);
  const dir = await mkdtemp(join(tmpdir(), "hive-hsr-payload-"));
  const payloadPath = join(dir, "payload.json");
  await writeFile(payloadPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });

  const logHandle = await open(join(hsrRunDir(payload.bee), "host.log"), "a", 0o600);
  try {
    const entry = await resolveHsrEntry();
    const childArgv = [...inheritableExecArgvForHsr(), ...hsrEntryArgv(entry, payloadPath)];
    const child = spawnChild(process.execPath, childArgv, {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      env: { ...process.env },
    });
    // Async spawn failures surface via 'error' after spawn() returns; the
    // missing-pid check below converts them into a thrown error.
    child.once("error", () => undefined);
    if (!child.pid) throw new Error(`hive __hsr-run: spawn failed (no pid for ${payload.bee})`);
    const pid = child.pid;
    child.unref();
    return pid;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
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
