/**
 * Two-step cell provisioning (WP5, spec 05 point 1) + warm cells (A5).
 *
 * Step 1 — place a `.git` in the space:
 *   preferred: initialize a fresh `.git`, then CoW-copy the small pack set
 *   from Honeybee's immutable per-repository Git image. The image is local
 *   acceleration state, built/refreshed after a Cell is ready by the
 *   provisioning worker; a miss never changes correctness.
 *   Cold fallback: CoW copy of the origin's `.git` (`cp -c` /
 *   `cp --reflink=always`).
 *   Fallback: `git clone --local --no-checkout` — hardlinked objects on any
 *   same-volume POSIX fs, and a factory-fresh `.git` needing no scrubbing.
 *   Only the live-origin CoW path runs hygiene (it copied the user's live `.git`
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
import { gitImagesRootForCells, tryMaterializeGitImage } from "./gitImage.ts";
import { cellPaths, parseSpaceName, type CellPaths } from "./layout.ts";
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
  /** Driver policy gate; production enables local images on workstations only. */
  useGitImages?: boolean;
  platform?: CowPlatform | null;
  /** Override the Honeybee-owned image root (tests); defaults beside cells/. */
  gitImagesRoot?: string;
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

/** What the daemon reserves for a bee at spawn, before the first start. */
export interface ReserveRequest extends ProvisionRequest {
  /** Per-cell sandbox override (A4); null/absent = node-kind default. */
  sandbox?: boolean | null;
}

/**
 * Reserve a cell for a bee WITHOUT provisioning it: writes the seed ledger
 * (`box/cell.json`, no operations yet) so the allocation — origin, sha,
 * layout, warm/sandbox choices — is durable from the moment the bee row
 * exists. The daemon calls this from `spawn`; the first `start()` finds the
 * ledger and provisions against it (`provisionCell` seeds identically when
 * no ledger exists, so a cell reserved here and one provisioned cold are
 * indistinguishable). Idempotent: an existing ledger for the same bee + sha
 * is left untouched; a ledger for a different bee/sha is a refusal — never
 * silently overwritten.
 */
export function reserveCell(
  cellsRoot: string,
  req: ReserveRequest,
  opts: { now?: () => number } = {},
): { paths: CellPaths; ledger: CellLedger; created: boolean } {
  const now = opts.now ?? Date.now;
  const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
  const existing = readLedger(paths.ledgerPath);
  if (existing != null) {
    if (existing.beeId !== req.beeId || existing.sha !== req.sha) {
      throw new Error(
        `cell ${paths.wrapperDir}: ledger is for bee=${existing.beeId} sha=${existing.sha}, ` +
          `refusing to reserve bee=${req.beeId} sha=${req.sha} into it`,
      );
    }
    return { paths, ledger: existing, created: false };
  }
  const ledger = newLedger({
    beeId: req.beeId,
    origin: req.originRepo,
    sha: req.sha,
    wrapper: req.wrapper,
    spaceName: paths.spaceName,
    now: now(),
    sandbox: req.sandbox ?? null,
    warm: req.warmArtifacts,
  });
  writeLedger(paths.ledgerPath, ledger);
  return { paths, ledger, created: true };
}

/**
 * The provisioning request a ledger describes — the inverse of the seed
 * written by `reserveCell`/`provisionCell`. Null when the ledger's space
 * name is not cell-shaped (a hand-edited or foreign file).
 */
export function provisionRequestOf(ledger: CellLedger): ProvisionRequest | null {
  const parsed = parseSpaceName(ledger.spaceName);
  if (parsed == null) return null;
  return {
    beeId: ledger.beeId,
    originRepo: ledger.origin,
    sha: ledger.sha,
    wrapper: ledger.wrapper,
    repoName: parsed.repoName,
    cellId: parsed.cellId,
    ...(ledger.warm && ledger.warm.length > 0 ? { warmArtifacts: [...ledger.warm] } : {}),
  };
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
      warm: req.warmArtifacts,
    });
    writeLedger(paths.ledgerPath, ledger);
  }
  if (ledger.beeId !== req.beeId || ledger.sha !== req.sha) {
    throw new Error(
      `cell ${paths.wrapperDir}: ledger is for bee=${ledger.beeId} sha=${ledger.sha}, ` +
        `refusing to provision bee=${req.beeId} sha=${req.sha} into it`,
    );
  }
  return runProvisionOperation(paths, ledger, opId, req, {
    platform,
    disableCow: opts.disableCow ?? false,
    useGitImages: opts.useGitImages ?? true,
    gitImagesRoot: opts.gitImagesRoot ?? gitImagesRootForCells(cellsRoot),
    now,
  });
}

function runProvisionOperation(
  paths: CellPaths,
  ledger: CellLedger,
  opId: string,
  req: ProvisionRequest,
  cfg: {
    platform: CowPlatform | null;
    disableCow: boolean;
    useGitImages: boolean;
    gitImagesRoot: string;
    now: () => number;
  },
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
    let image: { repoKey: string; generation: string } | undefined;
    if (cfg.useGitImages && !cfg.disableCow && cfg.platform != null) {
      image = tryMaterializeGitImage(
        cfg.gitImagesRoot,
        req.originRepo,
        req.sha,
        paths.spaceDir,
        paths.boxDir,
        paths.emptyHooksDir,
        { platform: cfg.platform },
      ) ?? undefined;
      if (image != null) mode = "image-cow";
    }
    if (mode === "clone" && !cfg.disableCow && cfg.platform != null && probeCow(originGitDir, paths.boxDir, cfg.platform)) {
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
    op.steps.git_placed = { mode, at: cfg.now(), ...(image == null ? {} : { image }) };
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
    // The clone and image paths yield factory-fresh .git dirs: nothing to scrub.
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
