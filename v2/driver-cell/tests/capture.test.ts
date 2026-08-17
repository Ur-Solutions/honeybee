/**
 * Spec 05 test tier 1 — the exit path: capture incl. conflict staging and
 * the zero-artifact guarantee (origin ref set bit-identical after a failed
 * land; no refs or notes left after a successful land). A1 ruling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWork } from "../src/capture.ts";
import { provisionCell } from "../src/provision.ts";
import { commitInCell, commitOn, fingerprintOrigin, fsckClean, g, makeRig } from "./helpers.ts";

function provisioned(rig: ReturnType<typeof makeRig>) {
  return provisionCell(
    rig.cellsRoot,
    {
      beeId: "bee-1",
      originRepo: rig.origin.repo,
      sha: rig.origin.sha,
      wrapper: "bee-1",
      repoName: "fixture",
      cellId: "c1",
    },
    "cmd-1",
    { disableCow: true },
  );
}

/** No hive refs — transient or otherwise — may survive any capture. */
function assertNoHiveRefs(repo: string): void {
  const refs = g(repo, ["for-each-ref", "--format=%(refname)"]);
  assert.ok(!refs.includes("refs/hive"), `hive refs survived: ${refs}`);
  const notes = g(repo, ["for-each-ref", "--format=%(refname)", "refs/notes"]);
  assert.equal(notes, "", "notes refs found in origin");
}

test("capture.branch-create: cell work lands as a new branch; only that branch appears", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const work = commitInCell(cell.paths.spaceDir, "feature.ts", "export const f = 1;\n", "add feature");
    const before = fingerprintOrigin(rig.origin.repo);

    const report = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "bee/feature",
      mode: "merge",
      opId: "cmd-77",
    });
    assert.equal(report.status, "landed");
    assert.equal(report.resultSha, work);
    assert.equal(g(rig.origin.repo, ["rev-parse", "refs/heads/bee/feature"]), work);

    // Zero artifacts: exactly ONE new ref (the branch the user asked for).
    const after = fingerprintOrigin(rig.origin.repo);
    assert.equal(after.head, before.head);
    assert.equal(after.status, before.status);
    const newRefs = after.refs.split("\n").filter((r) => !before.refs.split("\n").includes(r));
    assert.deepEqual(newRefs, [`refs/heads/bee/feature ${work}`]);
    assertNoHiveRefs(rig.origin.repo);
    assert.ok(fsckClean(rig.origin.repo));
  } finally {
    rig.cleanup();
  }
});

test("capture.fast-forward: existing target advances by CAS", () => {
  const rig = makeRig();
  try {
    g(rig.origin.repo, ["branch", "target", rig.origin.sha]);
    const cell = provisioned(rig);
    const work = commitInCell(cell.paths.spaceDir, "ff.ts", "1\n", "ff work");
    const report = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "target",
      mode: "merge",
      opId: "cmd-1",
    });
    assert.equal(report.status, "landed");
    assert.equal(report.baseTarget, rig.origin.sha);
    assert.equal(g(rig.origin.repo, ["rev-parse", "refs/heads/target"]), work);
    assertNoHiveRefs(rig.origin.repo);
  } finally {
    rig.cleanup();
  }
});

test("capture.merge: diverged target gets a merge commit; origin worktree untouched", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    // Origin advances on a target branch while the cell works.
    g(rig.origin.repo, ["checkout", "-b", "target"]);
    const originAdvance = commitOn(rig.origin.repo, "origin-side.ts", "o\n", "origin work");
    g(rig.origin.repo, ["checkout", "main"]);
    const cellWork = commitInCell(cell.paths.spaceDir, "cell-side.ts", "c\n", "cell work");
    const before = fingerprintOrigin(rig.origin.repo);

    const report = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "target",
      mode: "merge",
      opId: "cmd-2",
    });
    assert.equal(report.status, "landed");
    const tip = g(rig.origin.repo, ["rev-parse", "refs/heads/target"]);
    assert.equal(tip, report.resultSha);
    // The merge commit has both parents.
    const parents = g(rig.origin.repo, ["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1).sort();
    assert.deepEqual(parents, [originAdvance, cellWork].sort());
    // Origin worktree/HEAD/status: untouched by the merge machinery.
    const after = fingerprintOrigin(rig.origin.repo);
    assert.equal(after.head, before.head);
    assert.equal(after.status, before.status);
    assert.equal(after.branch, before.branch);
    assertNoHiveRefs(rig.origin.repo);
    assert.ok(fsckClean(rig.origin.repo));
  } finally {
    rig.cleanup();
  }
});

test("capture.rebase: cell commits replay onto the target tip", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    g(rig.origin.repo, ["checkout", "-b", "target"]);
    const originAdvance = commitOn(rig.origin.repo, "origin-side.ts", "o\n", "origin work");
    g(rig.origin.repo, ["checkout", "main"]);
    commitInCell(cell.paths.spaceDir, "cell-side.ts", "c\n", "cell work");

    const report = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "target",
      mode: "rebase",
      opId: "cmd-3",
    });
    assert.equal(report.status, "landed");
    const tip = g(rig.origin.repo, ["rev-parse", "refs/heads/target"]);
    // Linear history: rebased commit's parent is the origin advance.
    const parents = g(rig.origin.repo, ["rev-list", "--parents", "-n", "1", tip]).split(" ").slice(1);
    assert.deepEqual(parents, [originAdvance]);
    assertNoHiveRefs(rig.origin.repo);
  } finally {
    rig.cleanup();
  }
});

test("capture.conflict: structured report, origin ref-set bit-identical, transient ref gone", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    g(rig.origin.repo, ["checkout", "-b", "target"]);
    commitOn(rig.origin.repo, "clash.ts", "origin version\n", "origin clash");
    g(rig.origin.repo, ["checkout", "main"]);
    commitInCell(cell.paths.spaceDir, "clash.ts", "cell version\n", "cell clash");
    const before = fingerprintOrigin(rig.origin.repo);

    for (const mode of ["merge", "rebase"] as const) {
      const report = captureWork({
        originRepo: rig.origin.repo,
        cellSpaceDir: cell.paths.spaceDir,
        targetBranch: "target",
        mode,
        opId: `cmd-conf-${mode}`,
      });
      assert.equal(report.status, "conflict");
      assert.deepEqual(report.conflicts, ["clash.ts"], `${mode}: conflict paths staged for the operator`);
      // A failed land leaves the origin bit-identical (ref set + worktree)
      // and fsck-clean; the transient ref died with the operation.
      const after = fingerprintOrigin(rig.origin.repo);
      assert.deepEqual(after, before, `${mode}: origin drifted after failed land`);
      assertNoHiveRefs(rig.origin.repo);
      assert.ok(fsckClean(rig.origin.repo), `${mode}: fsck found problems`);
    }
  } finally {
    rig.cleanup();
  }
});

test("capture.refusals: checked-out target, moved target, nothing to capture", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "work.ts", "w\n", "work");

    // Landing onto the branch the user has checked out: refused, untouched.
    const before = fingerprintOrigin(rig.origin.repo);
    const refused = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: "main",
      mode: "merge",
      opId: "cmd-r1",
    });
    assert.equal(refused.status, "refused");
    assert.equal(refused.reason, "target_checked_out");
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), before);
    assertNoHiveRefs(rig.origin.repo);

    // Nothing to capture: the cell is at (an ancestor of) the target tip.
    g(rig.origin.repo, ["branch", "same", rig.origin.sha]);
    const fresh = provisionCell(
      rig.cellsRoot,
      {
        beeId: "bee-2",
        originRepo: rig.origin.repo,
        sha: rig.origin.sha,
        wrapper: "bee-2",
        repoName: "fixture",
        cellId: "c2",
      },
      "cmd-1",
      { disableCow: true },
    );
    const nothing = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: fresh.paths.spaceDir,
      targetBranch: "same",
      mode: "merge",
      opId: "cmd-r2",
    });
    assert.equal(nothing.status, "nothing_to_capture");
    assertNoHiveRefs(rig.origin.repo);
  } finally {
    rig.cleanup();
  }
});
