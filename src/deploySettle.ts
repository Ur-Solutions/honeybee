/**
 * Deploy settling: prove the globally installed module tree is EXACTLY the
 * tree the local build produced before anything restarts the daemon.
 *
 * Incident this encodes (2026-08): `npm i -g .` followed immediately by
 * `hive daemon restart` booted a daemon from a half-copied / half-rebuilt
 * module mix — new files beside stale ones — and the mixed boot reap
 * false-reaped 8 live runners. The global install may be a directory copy or
 * a symlink into a sibling worktree, so "the install finished" is not a fact
 * the installer's exit code establishes; only content equality is.
 *
 * Mechanism: after `npm run build`, writeBuildStamp() records a digest of the
 * local dist tree inside dist itself; the stamp travels with the install.
 * waitForSettledInstall() then re-reads the INSTALLED stamp and re-hashes the
 * INSTALLED tree until both equal the local digest (bounded retries), which
 * simultaneously proves the copy completed and that the install target is not
 * a stale or mid-rebuild worktree. Only then may the daemon restart.
 */

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "./fsx.js";

/** Lives inside dist/ so the stamp travels with any install mechanism. */
export const BUILD_STAMP_FILENAME = ".build-stamp.json";

export type BuildStamp = {
  hash: string;
  builtAt: string;
};

export type SettleResult = {
  hash: string;
  attempts: number;
};

export type SettleOptions = {
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const DEFAULT_SETTLE_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_POLL_INTERVAL_MS = 500;

/**
 * Order-stable content digest of every regular file under `dir` (the stamp
 * file excluded — it must be able to DESCRIBE the digest without changing
 * it). Path and content both feed the hash, so a renamed, missing, or extra
 * file changes the digest even when byte totals agree. Throws on a tree that
 * mutates mid-walk; settling treats that as "not settled yet" and retries.
 */
export async function hashDirectoryTree(dir: string): Promise<string> {
  const digest = createHash("sha256");
  const relativeFiles: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(dir, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(relPath);
      else if (entry.isFile() && relPath !== BUILD_STAMP_FILENAME) relativeFiles.push(relPath);
    }
  };
  await walk("");
  for (const relPath of relativeFiles) {
    digest.update(relPath);
    digest.update("\0");
    digest.update(await readFile(join(dir, relPath)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/** Digest the freshly built tree and persist the stamp beside it. */
export async function writeBuildStamp(distDir: string): Promise<BuildStamp> {
  const stamp: BuildStamp = {
    hash: await hashDirectoryTree(distDir),
    builtAt: new Date().toISOString(),
  };
  await atomicWriteFile(join(distDir, BUILD_STAMP_FILENAME), `${JSON.stringify(stamp, null, 2)}\n`, { mode: 0o644 });
  return stamp;
}

/** Null on a missing or torn stamp — both simply mean "not settled yet". */
export async function readBuildStamp(distDir: string): Promise<BuildStamp | null> {
  let raw: string;
  try {
    raw = await readFile(join(distDir, BUILD_STAMP_FILENAME), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed?.hash !== "string" || parsed.hash.length === 0) return null;
    return { hash: parsed.hash, builtAt: typeof parsed.builtAt === "string" ? parsed.builtAt : "" };
  } catch {
    return null;
  }
}

/**
 * Block until the installed dist tree provably equals the local build:
 * the installed stamp must name the local digest AND the installed tree must
 * re-hash to it (a stamp that merely copied early proves nothing). Resolves
 * with the settled digest; throws once the timeout expires with the last
 * observed disagreement, so the caller never restarts a daemon over a mixed
 * tree.
 */
export async function waitForSettledInstall(
  localDist: string,
  installedDist: string,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_INTERVAL_MS);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const localStamp = await readBuildStamp(localDist);
  if (!localStamp) {
    throw new Error(`deploy-settle: no build stamp under ${localDist}; run the build (writeBuildStamp) first`);
  }
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastDisagreement = "installed tree not yet observed";
  for (;;) {
    attempts += 1;
    try {
      const installedStamp = await readBuildStamp(installedDist);
      if (!installedStamp) {
        lastDisagreement = "installed build stamp is missing or unreadable";
      } else if (installedStamp.hash !== localStamp.hash) {
        lastDisagreement = `installed stamp ${installedStamp.hash.slice(0, 12)} != local build ${localStamp.hash.slice(0, 12)}`;
      } else {
        const installedHash = await hashDirectoryTree(installedDist);
        if (installedHash === localStamp.hash) return { hash: installedHash, attempts };
        lastDisagreement = `installed tree ${installedHash.slice(0, 12)} != its own stamp ${localStamp.hash.slice(0, 12)} (copy in flight?)`;
      }
    } catch (error) {
      // A tree mutating (or missing) mid-walk is exactly the unsettled state
      // this loop exists to outwait.
      lastDisagreement = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(`deploy-settle: installed module tree did not settle within ${timeoutMs}ms: ${lastDisagreement}`);
    }
    await sleep(Math.min(pollIntervalMs, remaining));
  }
}
