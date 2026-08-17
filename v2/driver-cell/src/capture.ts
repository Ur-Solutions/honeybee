/**
 * The native exit path (WP5, spec 05 point 4; UI lands in WP6).
 *
 * Capturing work out of a cell is ONE operation against the origin:
 *
 *   1. `git -C <origin> fetch <cell> +HEAD:<transient-ref>` — the cell's
 *      commits enter the origin under a transient ref (never a user-visible
 *      name);
 *   2. the merge/rebase onto the target branch is computed OUTSIDE the
 *      origin's working tree (a shared scratch clone) — the user's checkout,
 *      index and refs are never touched by conflict machinery;
 *   3. on success the target branch ref is advanced by compare-and-swap; on
 *      conflict a structured report is returned for the operator UI — never
 *      auto-resolved, never dangling;
 *   4. the transient ref is deleted in the SAME operation, success and
 *      failure paths both (finally).
 *
 * Hard guarantee (A1): zero artifacts in the user repo. A failed land leaves
 * the origin's ref set bit-identical; a successful land changes exactly the
 * one branch the user asked for. No notes, no refs that outlive their
 * operation, ever.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentBranch, git, isAncestor, revParse, tryGit } from "./git.ts";

export type CaptureMode = "merge" | "rebase";

export interface CaptureRequest {
  /** The origin repository (working-tree root). */
  originRepo: string;
  /** The cell's space (checkout) directory. */
  cellSpaceDir: string;
  /** Branch in the origin to land onto (created if absent). */
  targetBranch: string;
  mode: CaptureMode;
  /** Operation id (command id) — names the transient ref, replay-safe. */
  opId: string;
}

export interface CaptureReport {
  status: "landed" | "nothing_to_capture" | "conflict" | "refused";
  targetBranch: string;
  mode: CaptureMode;
  /** The cell HEAD that was captured. */
  cellHead: string | null;
  /** The target tip the operation started from (null = branch created). */
  baseTarget: string | null;
  /** The commit the target branch now points at (landed only). */
  resultSha: string | null;
  /** Conflicted paths (conflict only) — staged for the operator, never auto-resolved. */
  conflicts: string[];
  /** Refusal reason (refused only). */
  reason: "target_checked_out" | "target_moved" | "no_cell_head" | null;
}

const TRANSIENT_NS = "refs/hive/capture";

export function transientRefFor(opId: string): string {
  const safe = opId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${TRANSIENT_NS}/${safe.length > 0 ? safe : "op"}`;
}

function report(partial: Partial<CaptureReport> & Pick<CaptureReport, "status" | "targetBranch" | "mode">): CaptureReport {
  return {
    cellHead: null,
    baseTarget: null,
    resultSha: null,
    conflicts: [],
    reason: null,
    ...partial,
  };
}

/** Conflicted paths of an in-progress merge/rebase in `repo`. */
function conflictedPaths(repo: string): string[] {
  const out = tryGit(repo, ["diff", "--name-only", "--diff-filter=U"]);
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .sort();
}

export function captureWork(req: CaptureRequest): CaptureReport {
  const { originRepo, cellSpaceDir, targetBranch, mode } = req;
  const base = { targetBranch, mode };

  const cellHead = revParse(cellSpaceDir, "HEAD");
  if (cellHead == null) {
    return report({ ...base, status: "refused", reason: "no_cell_head" });
  }

  // Refusal, not mutation: landing onto the branch the user has checked out
  // would desync their working tree — the one thing this operation must
  // never do. The UI (WP6) offers a different target or a manual pull.
  if (currentBranch(originRepo) === targetBranch) {
    return report({ ...base, status: "refused", reason: "target_checked_out", cellHead });
  }

  const transientRef = transientRefFor(req.opId);
  let scratch: string | null = null;
  try {
    // 1. Cell commits into the origin, under the transient ref only.
    git(originRepo, ["fetch", "--no-tags", cellSpaceDir, `+HEAD:${transientRef}`]);

    const targetTip = revParse(originRepo, `refs/heads/${targetBranch}`);

    // Fast paths that need no scratch computation.
    if (targetTip != null && isAncestor(originRepo, cellHead, targetTip)) {
      return report({ ...base, status: "nothing_to_capture", cellHead, baseTarget: targetTip });
    }
    if (targetTip == null) {
      // Branch creation: exactly the branch the user asked for, atomically.
      git(originRepo, ["update-ref", `refs/heads/${targetBranch}`, cellHead, ""]);
      return report({ ...base, status: "landed", cellHead, baseTarget: null, resultSha: cellHead });
    }
    if (isAncestor(originRepo, targetTip, cellHead)) {
      // Fast-forward; CAS on the observed tip so a concurrent move refuses.
      const cas = tryGit(originRepo, ["update-ref", `refs/heads/${targetBranch}`, cellHead, targetTip]);
      if (cas.status !== 0) {
        return report({ ...base, status: "refused", reason: "target_moved", cellHead, baseTarget: targetTip });
      }
      return report({ ...base, status: "landed", cellHead, baseTarget: targetTip, resultSha: cellHead });
    }

    // 2. True merge/rebase — computed in a scratch clone sharing the
    // origin's object store (--shared: no object copies, instant), so the
    // origin's working tree and index never see conflict state.
    scratch = mkdtempSync(join(tmpdir(), "hive-capture-"));
    const scratchRepo = join(scratch, "repo");
    git(scratch, ["clone", "--quiet", "--shared", "--no-checkout", originRepo, scratchRepo]);

    let resultSha: string;
    if (mode === "merge") {
      git(scratchRepo, ["checkout", "--quiet", "--force", "--detach", targetTip]);
      const merge = tryGit(scratchRepo, [
        "merge",
        "--no-ff",
        "-m",
        `Capture cell work into ${targetBranch}`,
        cellHead,
      ]);
      if (merge.status !== 0) {
        const conflicts = conflictedPaths(scratchRepo);
        tryGit(scratchRepo, ["merge", "--abort"]);
        return report({ ...base, status: "conflict", cellHead, baseTarget: targetTip, conflicts });
      }
      resultSha = git(scratchRepo, ["rev-parse", "HEAD"]);
    } else {
      git(scratchRepo, ["checkout", "--quiet", "--force", "--detach", cellHead]);
      const rebase = tryGit(scratchRepo, ["rebase", targetTip]);
      if (rebase.status !== 0) {
        const conflicts = conflictedPaths(scratchRepo);
        tryGit(scratchRepo, ["rebase", "--abort"]);
        return report({ ...base, status: "conflict", cellHead, baseTarget: targetTip, conflicts });
      }
      resultSha = git(scratchRepo, ["rev-parse", "HEAD"]);
    }

    // 3. Result objects into the origin (transient ref again — force-update
    // of OUR ref), then advance the target branch by CAS.
    git(originRepo, ["fetch", "--no-tags", scratchRepo, `+${resultSha}:${transientRef}`]);
    const cas = tryGit(originRepo, ["update-ref", `refs/heads/${targetBranch}`, resultSha, targetTip]);
    if (cas.status !== 0) {
      return report({ ...base, status: "refused", reason: "target_moved", cellHead, baseTarget: targetTip });
    }
    return report({ ...base, status: "landed", cellHead, baseTarget: targetTip, resultSha });
  } finally {
    // 4. The transient ref dies with the operation — success AND failure
    // paths (the A1 zero-artifact guarantee).
    tryGit(originRepo, ["update-ref", "-d", transientRef]);
    if (scratch != null) rmSync(scratch, { recursive: true, force: true });
  }
}
