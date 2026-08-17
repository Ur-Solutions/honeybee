/**
 * Versioned runtime deploys (reset WP0 — docs/design/specs/reset-00-deploy.md).
 *
 * `hive deploy` installs an immutable build of a committed sha under
 * `<storeRoot>/runtime/<sha>/` and atomically retargets the `runtime/current`
 * symlink, so the daemon and the global CLI never execute out of a mutable
 * working tree (core contract invariant 8). The developer tree is only ever
 * READ (a `git archive` of a committed sha); building happens in a disposable
 * temp checkout, and every failure before the final renames leaves `current`
 * — and therefore the running system — untouched.
 *
 * This module is the pure orchestration layer: history, symlink retarget,
 * prune, rollback. The two effectful steps — building the artifact and
 * restarting the daemon — arrive as injected hooks so tests exercise the full
 * deploy state machine against a temp runtime root without ever compiling the
 * repo or touching a real daemon. The production hooks live in
 * src/commands/deploy.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { writeBuildStamp } from "./deploySettle.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";

const execFileAsync = promisify(execFile);

export const RUNTIME_DIR_NAME = "runtime";
export const CURRENT_LINK_NAME = "current";
export const DEPLOY_HISTORY_FILENAME = "deploys.json";
export const DEFAULT_KEEP_VERSIONS = 5;

/** Full-length commit shas only: version dirs must be unambiguous forever. */
const DEPLOY_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `~/.hive/runtime` (HIVE_STORE_ROOT-aware, like every other store path). */
export function runtimeRoot(): string {
  return join(storeRoot(), RUNTIME_DIR_NAME);
}

export type DeployHistoryEntry = {
  sha: string;
  at: string;
  artifactHash: string;
  by: string;
};

export type BuildArtifactContext = {
  repoRoot: string;
  sha: string;
  /** Disposable temp dir for the clean checkout + build; removed afterwards. */
  workDir: string;
  log: (line: string) => void;
};

export type RestartDaemonContext = {
  root: string;
  installedDir: string;
  sha: string;
  log: (line: string) => void;
};

export type DeployHooks = {
  /**
   * Produce the installable artifact for `sha` inside `workDir` and return
   * the directory whose CONTENTS become `runtime/<sha>/`. The artifact must
   * be self-sufficient: dist/, contracts/, package.json and production
   * node_modules — nothing in it may resolve back into the repo tree.
   */
  buildArtifact: (context: BuildArtifactContext) => Promise<{ artifactDir: string }>;
  /** Separate final step so tests (and --no-restart futures) never touch a real daemon. */
  restartDaemon: (context: RestartDaemonContext) => Promise<void>;
};

export type DeployOptions = {
  repoRoot: string;
  hooks: DeployHooks;
  /** Commit-ish to deploy; default HEAD. */
  ref?: string;
  /** Runtime root override (tests); default runtimeRoot(). */
  root?: string;
  /** History depth protected from pruning; default DEFAULT_KEEP_VERSIONS. */
  keep?: number;
  by?: string;
  now?: () => Date;
  log?: (line: string) => void;
};

export type DeployOutcome = {
  sha: string;
  artifactHash: string;
  installedDir: string;
  previousSha: string | null;
  pruned: string[];
  entry: DeployHistoryEntry;
};

export type RollbackOptions = {
  hooks: Pick<DeployHooks, "restartDaemon">;
  root?: string;
  by?: string;
  now?: () => Date;
  log?: (line: string) => void;
};

export type RollbackOutcome = {
  /** Sha `current` pointed at before the rollback. */
  from: string;
  sha: string;
  entry: DeployHistoryEntry;
};

function isHistoryEntry(value: unknown): value is DeployHistoryEntry {
  const entry = value as Partial<DeployHistoryEntry> | null;
  return (
    typeof entry?.sha === "string" && DEPLOY_SHA_PATTERN.test(entry.sha) &&
    typeof entry.at === "string" &&
    typeof entry.artifactHash === "string" &&
    typeof entry.by === "string"
  );
}

/**
 * Append-only deploy log, oldest first; `current` always corresponds to the
 * last entry (rollbacks append too, so the log reads as "what `current`
 * pointed at over time"). Tolerant of a missing/foreign file — deploys.json
 * is bookkeeping, never the thing that decides whether a runtime is live.
 */
export async function readDeployHistory(root: string): Promise<DeployHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, DEPLOY_HISTORY_FILENAME), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries.filter(isHistoryEntry);
  } catch {
    return [];
  }
}

async function appendDeployHistory(root: string, entry: DeployHistoryEntry): Promise<void> {
  const entries = [...(await readDeployHistory(root)), entry];
  await atomicWriteFile(
    join(root, DEPLOY_HISTORY_FILENAME),
    `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
    { mode: 0o644 },
  );
}

/** Sha the `current` symlink names, or null when nothing is deployed yet. */
export async function currentDeployTarget(root: string): Promise<string | null> {
  let target: string;
  try {
    target = await readlink(join(root, CURRENT_LINK_NAME));
  } catch {
    return null;
  }
  const sha = basename(target);
  return DEPLOY_SHA_PATTERN.test(sha) ? sha : null;
}

/**
 * The entry `--rollback` would retarget to right now: the most recent history
 * entry naming a different sha than `current`. `requireInstalled` additionally
 * demands the version dir still exists (the actual rollback needs bytes;
 * prune protection must shield the target even if something deleted it).
 */
export function rollbackTargetEntry(
  entries: DeployHistoryEntry[],
  currentSha: string | null,
  options: { root?: string; requireInstalled?: boolean } = {},
): DeployHistoryEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]!;
    if (candidate.sha === currentSha) continue;
    if (options.requireInstalled && options.root !== undefined &&
      !existsSync(join(options.root, candidate.sha, "dist", "cli.js"))) continue;
    return candidate;
  }
  return null;
}

/**
 * Atomic retarget: publish a fresh symlink under a temp name, then rename it
 * over `current`. Readers observe either the old target or the new one —
 * never a missing or half-written link. The target is relative (just the
 * sha), so a moved store root stays coherent.
 */
async function retargetCurrent(root: string, sha: string): Promise<void> {
  const temp = join(root, `.${CURRENT_LINK_NAME}.${process.pid}.${Date.now()}.tmp`);
  await rm(temp, { force: true });
  await symlink(sha, temp);
  try {
    await rename(temp, join(root, CURRENT_LINK_NAME));
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

/** Refuse anything uncommitted — deployed bytes must equal committed bytes. */
async function verifyCleanWorkingTree(repoRoot: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
  );
  const dirt = stdout.trim();
  if (dirt.length > 0) {
    throw new Error(`deploy: working tree is dirty; commit (or stash) everything first\n${dirt}`);
  }
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`],
    );
    const sha = stdout.trim();
    if (!DEPLOY_SHA_PATTERN.test(sha)) throw new Error(`unexpected rev-parse output: ${sha}`);
    return sha;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`deploy: cannot resolve '${ref}' to a commit in ${repoRoot}\n${detail}`);
  }
}

function deployedBy(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "unknown";
  }
}

/**
 * The deploy sequence, in refuse-early order. Everything before the publish
 * renames happens in temp space; a failure at any point leaves `current`,
 * the history, and every installed version exactly as they were.
 */
export async function deployVersion(options: DeployOptions): Promise<DeployOutcome> {
  const root = options.root ?? runtimeRoot();
  const keep = Math.max(1, Math.floor(options.keep ?? DEFAULT_KEEP_VERSIONS));
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  await verifyCleanWorkingTree(options.repoRoot);
  const sha = await resolveCommit(options.repoRoot, options.ref ?? "HEAD");
  log(`deploy: building ${sha.slice(0, 12)} in a clean temp checkout`);

  const workDir = await mkdtemp(join(tmpdir(), "hive-deploy-"));
  let staging: string | null = null;
  try {
    const { artifactDir } = await options.hooks.buildArtifact({
      repoRoot: options.repoRoot,
      sha,
      workDir,
      log,
    });
    if (!existsSync(join(artifactDir, "dist", "cli.js"))) {
      throw new Error(`deploy: built artifact has no dist/cli.js under ${artifactDir}`);
    }
    // Stamp before staging so the recorded hash names exactly the dist bytes
    // that get installed (deploySettle's tree digest, stamp excluded).
    const stamp = await writeBuildStamp(join(artifactDir, "dist"));

    // Stage on the runtime filesystem so publishing is a same-device rename.
    await mkdir(root, { recursive: true });
    staging = join(root, `.staging.${sha}.${process.pid}.${Date.now()}`);
    await cp(artifactDir, staging, { recursive: true, verbatimSymlinks: true });

    // Publish runtime/<sha>. A redeploy of an existing sha swaps the old dir
    // aside first; the rename pair keeps a complete install in place at every
    // instant `current` could be pointing at it.
    const versionDir = join(root, sha);
    let displaced: string | null = null;
    if (existsSync(versionDir)) {
      displaced = join(root, `.displaced.${sha}.${process.pid}.${Date.now()}`);
      await rename(versionDir, displaced);
    }
    try {
      await rename(staging, versionDir);
    } catch (error) {
      if (displaced) await rename(displaced, versionDir).catch(() => undefined);
      throw error;
    }
    staging = null;
    if (displaced) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);

    const previousSha = await currentDeployTarget(root);
    await retargetCurrent(root, sha);
    const entry: DeployHistoryEntry = { sha, at: now().toISOString(), artifactHash: stamp.hash, by };
    await appendDeployHistory(root, entry);
    const pruned = await pruneRuntimeVersions(root, { keep });
    for (const removed of pruned) log(`deploy: pruned old version ${removed.slice(0, 12)}`);

    // Deliberately last and separate: the install is fully recorded before
    // anything restarts, and a restart failure never un-publishes a deploy.
    await options.hooks.restartDaemon({ root, installedDir: versionDir, sha, log });
    return { sha, artifactHash: stamp.hash, installedDir: versionDir, previousSha, pruned, entry };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Retarget `current` to the previous history entry (most recent distinct sha
 * whose install still exists) and record the move. No pruning here — a
 * rollback must never delete anything.
 */
export async function rollbackDeploy(options: RollbackOptions): Promise<RollbackOutcome> {
  const root = options.root ?? runtimeRoot();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  const currentSha = await currentDeployTarget(root);
  if (!currentSha) throw new Error("deploy: nothing deployed yet (no runtime/current)");
  const entries = await readDeployHistory(root);
  const target = rollbackTargetEntry(entries, currentSha, { root, requireInstalled: true });
  if (!target) throw new Error("deploy: no previous installed version to roll back to");

  await retargetCurrent(root, target.sha);
  const entry: DeployHistoryEntry = {
    sha: target.sha,
    at: now().toISOString(),
    artifactHash: target.artifactHash,
    by,
  };
  await appendDeployHistory(root, entry);
  log(`deploy: rolled back ${currentSha.slice(0, 12)} → ${target.sha.slice(0, 12)}`);
  await options.hooks.restartDaemon({ root, installedDir: join(root, target.sha), sha: target.sha, log });
  return { from: currentSha, sha: target.sha, entry };
}

/**
 * Remove installed versions beyond the protected set: `current`, its rollback
 * target, and the last `keep` distinct shas in history. Only exact 40-hex
 * dirs are candidates — `current`, deploys.json, and staging temp names are
 * structurally exempt. Returns the removed shas (sorted).
 */
export async function pruneRuntimeVersions(
  root: string,
  options: { keep?: number } = {},
): Promise<string[]> {
  const keep = Math.max(1, Math.floor(options.keep ?? DEFAULT_KEEP_VERSIONS));
  const entries = await readDeployHistory(root);
  const currentSha = await currentDeployTarget(root);

  const protectedShas = new Set<string>();
  if (currentSha) protectedShas.add(currentSha);
  const rollback = rollbackTargetEntry(entries, currentSha);
  if (rollback) protectedShas.add(rollback.sha);
  const lastDistinct: string[] = [];
  for (let index = entries.length - 1; index >= 0 && lastDistinct.length < keep; index -= 1) {
    const sha = entries[index]!.sha;
    if (!lastDistinct.includes(sha)) lastDistinct.push(sha);
  }
  for (const sha of lastDistinct) protectedShas.add(sha);

  let dirents: Dirent[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (!DEPLOY_SHA_PATTERN.test(dirent.name)) continue;
    if (protectedShas.has(dirent.name)) continue;
    await rm(join(root, dirent.name), { recursive: true, force: true });
    removed.push(dirent.name);
  }
  return removed.sort();
}
