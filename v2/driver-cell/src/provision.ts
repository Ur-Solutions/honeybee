/**
 * Two-step cell provisioning (WP5, spec 05 point 1) + warm cells (A5).
 *
 * Step 1 — place a `.git` in the space:
 *   preferred: CoW copy of the origin's `.git` (`cp -c` / `cp --reflink=always`)
 *   — instant on APFS/btrfs/XFS same-volume; fails honestly elsewhere.
 *   Fallback: `git clone --local --no-checkout` — hardlinked objects on any
 *   same-volume POSIX fs, and a factory-fresh `.git` needing no scrubbing.
 *   Only the CoW path runs hygiene (it copied the user's live `.git`
 *   verbatim): hooksPath → empty dir, fsmonitor off, scrub lock files and
 *   merge/rebase/sequencer state. `copy_mode` is recorded honestly.
 *
 * Step 2 — materialize the working tree: `git checkout <sha>`, always (both
 * step-1 paths deliberately arrive without working files).
 *
 * Warm cells (A5, CoW-only by ruling): per-repo opt-in artifact dirs
 * (node_modules, target, …) are reflink-copied from the origin's working
 * tree AFTER checkout — only when the CoW probe succeeds. No CoW → the cell
 * is simply cold: no copy fallback, no hardlinks, deliberately.
 *
 * Everything is keyed through the cell.json ledger (operation id = command
 * id): a crashed provisioning replays idempotently from the first
 * unrecorded step.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { cowCopy, cowPlatform, probeCow, type CowPlatform } from "./cow.ts";
import { git } from "./git.ts";
import { cellPaths, type CellPaths } from "./layout.ts";
import {
  isProvisioned,
  newLedger,
  operationOf,
  readLedger,
  writeLedger,
  type CellLedger,
  type CopyMode,
  type WarmRecord,
} from "./ledger.ts";

export interface ProvisionRequest {
  beeId: string;
  /** Path to the origin repository (its working-tree root). */
  originRepo: string;
  /** The commit to materialize. */
  sha: string;
  /** Wrapper (grouping) directory name — unique per cell. */
  wrapper: string;
  /** Repo display name for the space directory. */
  repoName: string;
  /** Unique cell id (space suffix). */
  cellId: string;
  /** Per-repo opt-in warm artifact dirs, relative to the working tree (A5). */
  warmArtifacts?: string[];
}

export interface ProvisionedCell {
  paths: CellPaths;
  copyMode: CopyMode;
  warm: WarmRecord;
  sha: string;
  originRepo: string;
  /** True when this call found a completed provisioning and did nothing. */
  replayed: boolean;
}

export interface ProvisionOptions {
  /** Force-skip the CoW path (tests; ext4 simulation). */
  disableCow?: boolean;
  platform?: CowPlatform | null;
  now?: () => number;
}

/** Lock/merge/rebase/sequencer state scrubbed from a CoW-copied `.git`. */
export const COW_SCRUB_FILES = [
  "index.lock",
  "HEAD.lock",
  "config.lock",
  "packed-refs.lock",
  "shallow.lock",
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "gc.pid",
] as const;

export const COW_SCRUB_DIRS = ["rebase-merge", "rebase-apply", "sequencer"] as const;

function scrubCowGitDir(gitDir: string): void {
  for (const f of COW_SCRUB_FILES) rmSync(join(gitDir, f), { force: true });
  for (const d of COW_SCRUB_DIRS) rmSync(join(gitDir, d), { recursive: true, force: true });
  // Recursive *.lock sweep under refs/ (per-ref lock files).
  const refsDir = join(gitDir, "refs");
  if (existsSync(refsDir)) {
    const stack = [refsDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(p);
        else if (entry.name.endsWith(".lock")) rmSync(p, { force: true });
      }
    }
  }
}

/**
 * Provision (or replay-provision) a cell, keyed by an explicit operation
 * (command) id. Idempotent per the ledger: a completed provisioning
 * short-circuits; an interrupted one resumes from the first step its
 * operation record has not marked complete.
 */
export function provisionCell(
  cellsRoot: string,
  req: ProvisionRequest,
  opId: string,
  opts: ProvisionOptions = {},
): ProvisionedCell {
  const now = opts.now ?? Date.now;
  const platform = opts.platform === undefined ? cowPlatform() : opts.platform;
  const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
  mkdirSync(paths.boxDir, { recursive: true });
  let ledger = readLedger(paths.ledgerPath);
  if (ledger == null) {
    ledger = newLedger({
      beeId: req.beeId,
      origin: req.originRepo,
      sha: req.sha,
      wrapper: req.wrapper,
      spaceName: paths.spaceName,
      now: now(),
    });
    writeLedger(paths.ledgerPath, ledger);
  }
  if (ledger.beeId !== req.beeId || ledger.sha !== req.sha) {
    throw new Error(
      `cell ${paths.wrapperDir}: ledger is for bee=${ledger.beeId} sha=${ledger.sha}, ` +
        `refusing to provision bee=${req.beeId} sha=${req.sha} into it`,
    );
  }
  return runProvisionOperation(paths, ledger, opId, req, { platform, disableCow: opts.disableCow ?? false, now });
}

function runProvisionOperation(
  paths: CellPaths,
  ledger: CellLedger,
  opId: string,
  req: ProvisionRequest,
  cfg: { platform: CowPlatform | null; disableCow: boolean; now: () => number },
): ProvisionedCell {
  // A completed provisioning — this operation's or an earlier one's — makes
  // this call a recorded no-op (idempotent replay).
  if (isProvisioned(ledger)) {
    const done = Object.values(ledger.operations).find((op) => op.completedAt != null);
    return {
      paths,
      copyMode: ledger.copy_mode ?? "clone",
      warm: done?.steps.warm ?? { mode: "cold", dirs: [], reason: "none_listed" },
      sha: ledger.sha,
      originRepo: ledger.origin,
      replayed: true,
    };
  }

  const op = operationOf(ledger, opId, cfg.now());
  const save = (): void => writeLedger(paths.ledgerPath, ledger);
  save();

  const originGitDir = join(req.originRepo, ".git");
  if (!existsSync(originGitDir)) {
    throw new Error(`provision: origin ${req.originRepo} has no .git`);
  }

  // ---- step 1: place a .git in the space --------------------------------
  if (op.steps.git_placed == null) {
    // A crash may have left a partial space dir with no recorded step —
    // wipe and redo (the step records only after it fully completed).
    rmSync(paths.spaceDir, { recursive: true, force: true });
    let mode: CopyMode = "clone";
    if (!cfg.disableCow && cfg.platform != null && probeCow(originGitDir, paths.boxDir, cfg.platform)) {
      mkdirSync(paths.spaceDir, { recursive: true });
      if (cowCopy(cfg.platform, originGitDir, join(paths.spaceDir, ".git"), { recursive: true })) {
        mode = "cow";
      } else {
        // The probe passed but the real copy failed (raced fs state) —
        // fall back honestly to the clone path.
        rmSync(paths.spaceDir, { recursive: true, force: true });
      }
    }
    if (mode === "clone") {
      git(paths.boxDir, ["clone", "--local", "--no-checkout", req.originRepo, paths.spaceDir]);
    }
    op.steps.git_placed = { mode, at: cfg.now() };
    ledger.copy_mode = mode;
    save();
  }

  // ---- hygiene: CoW copies carry the user's live .git state -------------
  if (op.steps.hygiene == null) {
    if (op.steps.git_placed.mode === "cow") {
      mkdirSync(paths.emptyHooksDir, { recursive: true });
      const gitDir = join(paths.spaceDir, ".git");
      scrubCowGitDir(gitDir);
      git(paths.spaceDir, ["config", "core.hooksPath", paths.emptyHooksDir]);
      git(paths.spaceDir, ["config", "core.fsmonitor", "false"]);
    }
    // The clone path yields a factory-fresh .git: nothing to scrub.
    op.steps.hygiene = { at: cfg.now() };
    save();
  }

  // ---- step 2: materialize the working tree (always) --------------------
  if (op.steps.checkout == null) {
    // --force: a CoW-copied index describes the origin's working tree, not
    // this empty space; force makes checkout write every tracked file.
    git(paths.spaceDir, ["checkout", "--force", "--detach", req.sha]);
    op.steps.checkout = { sha: req.sha, at: cfg.now() };
    save();
  }

  // ---- warm artifacts (A5: CoW-only, opt-in, default off) ---------------
  if (op.steps.warm == null) {
    const wanted = (req.warmArtifacts ?? []).filter((d) => d.length > 0);
    let record: WarmRecord;
    if (wanted.length === 0) {
      record = { mode: "cold", dirs: [], reason: "none_listed" };
    } else if (cfg.disableCow || cfg.platform == null || !probeCow(originGitDir, paths.boxDir, cfg.platform)) {
      // The ruling: no CoW → cold. Manager caches stay visible through the
      // sandbox profile, so cold installs remain network-warm.
      record = { mode: "cold", dirs: [], reason: "no_cow" };
    } else {
      const copied: string[] = [];
      for (const rel of wanted) {
        const src = join(req.originRepo, rel);
        const dest = join(paths.spaceDir, rel);
        if (!existsSync(src) || !statSync(src).isDirectory()) continue;
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); // replay hygiene
        mkdirSync(join(dest, ".."), { recursive: true });
        if (cowCopy(cfg.platform as CowPlatform, src, dest, { recursive: true })) copied.push(rel);
      }
      record = { mode: "cow", dirs: copied };
    }
    op.steps.warm = { ...record, at: cfg.now() };
    save();
  }

  op.completedAt = cfg.now();
  save();

  return {
    paths,
    copyMode: op.steps.git_placed.mode,
    warm: op.steps.warm,
    sha: req.sha,
    originRepo: req.originRepo,
    replayed: false,
  };
}
